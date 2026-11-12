---
title: Logs Relocation Implementation Plan
status: approved
version: 0.6.1
last_updated: 2026-11-12
review_date: 2027-05-12
spec: docs/superpowers/specs/2026-11-11-logs-relocation-design.md
---

# Logs Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write bot, daemon, and service logs to the canonical per-user OS log directory, selectable between that and `<appHome>/logs` with `LOG_LOCATION`.

**Architecture:** A pure per-OS path function plus an async resolver (`src/runtime/log-location.ts`) decide the directory once per process. The spawning CLI resolves it and hands it to the daemon child through the service child environment. Naming, permissions, and pruning live in `src/utils/log-files.ts`, used by the logger and the service manager.

**Tech Stack:** TypeScript 5 strict, Node 22.14+, Vitest, `dotenv`, existing `t()` i18n.

**Spec:** `docs/superpowers/specs/2026-11-11-logs-relocation-design.md`

## Global Constraints

- Canonical directories, both runtime modes: macOS `~/Library/Logs/opencode-telegram-bot/`; Linux `$XDG_STATE_HOME/opencode-telegram-bot/logs/` defaulting to `~/.local/state/opencode-telegram-bot/logs/`; Windows `%LOCALAPPDATA%\opencode-telegram-bot\Logs\`.
- `LOG_LOCATION=default|app`; unset means `default`; `app` means `<appHome>/logs`. A real environment variable beats `.env`. `OPENCODE_TELEGRAM_HOME` alone does not move logs.
- File names: main logs `opencode-telegram-bot-<date or timestamp>.log`, service log `opencode-telegram-bot-service-<timestamp>.log`.
- `LOG_RETENTION` is read from the real environment, then `.env`; installed-mode daily logs, sources-mode per-launch logs, and service logs are each pruned separately.
- Unix permissions: log directory 0700, log files 0600, enforced on every start including existing paths. Windows relies on default ACLs.
- Unusable directory: the application logger warns once on stderr and the bot keeps running. Daemon startup fails with an error if the service log cannot be opened.
- Invalid `LOG_LOCATION` (outside a container; inside one see Task 4): with a TTY, warn and prompt for `1) default` or `2) app` (the words are accepted too), save the answer to `.env`; without a TTY, warn once on stderr and use `default`.
- No migration of, or special handling for, `<repo>/logs` and `<appHome>/logs` legacy files.
- Cross-platform: no hardcoded separators; Windows-only logic behind `process.platform`; every test passes on every OS or is skipped outside its OS.
- Code, identifiers, and comments in English; user-facing strings through `t()` with a key in every locale; no raw `console.*` in feature code.
- Docs state the current design only; no counts of dynamic things; no Mermaid; frontmatter bumped on touched docs that have it.

## Review Focus

- `LOG_LOCATION=` (empty) is treated as unset, with no prompt (Task 1, Task 4).
- `" App "` (case and whitespace) is accepted as `app` (Task 1).
- An invalid `LOG_LOCATION` supplied by the real environment warns and uses `default` (outside a container; inside one see Task 4), and is not written to `.env`, since `.env` cannot override it (Task 4).
- The main-log and service-log retention scans never delete each other's files or unrelated files such as `notes.txt` (Task 3).
- A pre-existing 0755 log directory and 0644 log file are tightened to 0700 and 0600 (Task 3, Task 5).
- A daemon child whose handed-down log directory is missing recreates it through the logger's `ensureLogsDir` call and does not fail (Task 5).

---

## File Structure

- Create `src/runtime/log-location.ts`: path function, setting parser, async resolver.
- Create `src/runtime/env-file.ts`: atomic `.env` write and single-key persist. `writeFileAtomically` lives here and `bootstrap.ts` imports it.
- Create `src/utils/log-files.ts`: file names, patterns, directory and file permissions, pruning, `LOG_RETENTION` parsing.
- Modify `src/utils/logger.ts`, `src/runtime/service/manager.ts`, `src/runtime/service/env.ts`, `src/runtime/prompts.ts`, `src/runtime/bootstrap.ts`, `src/cli.ts`, `src/i18n/*.ts`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `README.md`, `AGENTS.md`, `PRODUCT.md`, `e2e/`.
- Tests: `tests/runtime/log-location.test.ts`, `tests/runtime/env-file.test.ts`, `tests/utils/log-files.test.ts`, `tests/runtime/log-location-integration.test.ts`, `tests/e2e/log-location.test.ts`, `tests/cli/config-command.test.ts`, plus updates to `tests/utils/logger.test.ts`, `tests/runtime/service/manager.test.ts`, `tests/runtime/bootstrap-wizard.test.ts`, `tests/runtime/bootstrap.test.ts`, `tests/runtime/prompts.test.ts`.

Branch: create `feat/logs-relocation` from `main` before Task 1. Commit steps run only when the owner authorizes commits; `AGENTS.md` forbids automatic commits.

---

### Task 1: Canonical path and setting parser

**Files:** Create `src/runtime/log-location.ts`; Test `tests/runtime/log-location.test.ts`.

**Interfaces:**
- Produces: `type LogLocation = "default" | "app"`; `type LogLocationSetting = { kind: "unset" } | { kind: "valid"; value: LogLocation } | { kind: "invalid"; raw: string }`; `parseLogLocation(raw: string | undefined): LogLocationSetting` (trim and lowercase; empty or undefined is `unset`); `parseLogLocationChoice(answer: string): LogLocation | null` (accepts `1`, `2`, `default`, `app`, case-insensitive and trimmed; shared by the runtime prompt and the config wizard); `resolveCanonicalLogsDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homedir: string): string`.

- [ ] **Step 1: Write failing tests** in `tests/runtime/log-location.test.ts`:
  - `resolveCanonicalLogsDir("darwin", {}, "/Users/a")` equals `/Users/a/Library/Logs/opencode-telegram-bot`.
  - `("linux", { XDG_STATE_HOME: "/x/state" }, "/home/a")` equals `/x/state/opencode-telegram-bot/logs`; `("linux", {}, "/home/a")` equals `/home/a/.local/state/opencode-telegram-bot/logs`; a relative `XDG_STATE_HOME: "rel"` is ignored and gives the default.
  - `("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\Users\\a")` equals `C:\L\opencode-telegram-bot\Logs`; unset or empty `LOCALAPPDATA` gives `C:\Users\a\AppData\Local\opencode-telegram-bot\Logs`.
  - `parseLogLocation`: `"app"`, `" App "`, `"DEFAULT"` are `valid`; `undefined` and `""` are `unset`; `"apps"` is `{ kind: "invalid", raw: "apps" }`.
- [ ] **Step 2: Run** `npx vitest run tests/runtime/log-location.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** both functions. Use `path.win32` for `win32` and `path.posix` otherwise so the tests pass on every OS.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): add canonical log directory resolution`.

### Task 2: `.env` persistence helper

**Files:** Create `src/runtime/env-file.ts`; Modify `src/runtime/bootstrap.ts` (imports `writeFileAtomically` from `env-file.ts`); Test `tests/runtime/env-file.test.ts`.

**Interfaces:**
- Produces: `writeFileAtomically(filePath: string, content: string): Promise<void>` (temp file plus rename); `persistEnvValue(envFilePath: string, key: string, value: string): Promise<void>`. `writeFileAtomically` names the temp file uniquely per call and creates it 0600 with the `wx` flag, so concurrent writers and stale temp files never influence each other or the final mode. `replaceEnvFile(filePath, content)` follows a symlinked file, keeps the mode of an existing file (a read-only one included), and does not fail a completed replace when restoring the mode fails.

- [ ] **Step 1: Write failing tests** using a temp directory: creates the file when missing with `LOG_LOCATION=app\n`; replaces the first active `LOG_LOCATION=bad` line in place, drops later duplicate assignments, and keeps every other line; appends with a trailing newline when the key is absent; performs no write when the value is unchanged; leaves no `.tmp` sibling; two concurrent replacements both succeed; on non-Windows (skip on `win32`) a new file is `0o600`, the temp file is written with mode `0o600`, a stale temp file does not influence the mode, an existing file keeps its mode, a read-only file is updated and ends read-only, and a symlinked file keeps its link and the target mode.
- [ ] **Step 2: Run** `npx vitest run tests/runtime/env-file.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `persistEnvValue`: read (ENOENT is empty), replace the first active assignment of `key` in place (keeping its indentation and `export` prefix), drop later duplicates, append `key=value` only when the key is absent, return without writing when the content is unchanged, and otherwise write with `replaceEnvFile` (temp file created 0600). An existing file keeps its mode (a read-only file is reopened with `reopenEnvFileForEdit` from `src/secrets/file-permissions.ts` first, and the mode is restored after the write); a missing file is created 0600. It never calls `finalizeEnvFile`. `persistOpencodeVersion` in `config.ts` is not used for this, because importing `config.ts` runs its load-time side effects.
- [ ] **Step 4: Run** `npx vitest run tests/runtime/env-file.test.ts tests/runtime/bootstrap.test.ts tests/runtime/bootstrap-wizard.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(runtime): extract env file writer and add persistEnvValue`.

### Task 3: Log file naming, permissions, pruning

**Files:** Create `src/utils/log-files.ts`; Test `tests/utils/log-files.test.ts`.

**Interfaces:**
- Produces: `getLogRetention(env?: NodeJS.ProcessEnv): number` (default 10; a missing, non-numeric, zero, or negative value gives the default); `buildMainLogFileName(mode: RuntimeMode, now: Date, pid: number): string` (installed `opencode-telegram-bot-YYYY-MM-DD.log`; sources `opencode-telegram-bot-YYYY-MM-DD_HH-MM-SS_<pid>.log`); `getMainLogFilePattern(mode: RuntimeMode): RegExp`; `buildServiceLogFileName(now: Date): string` (`opencode-telegram-bot-service-YYYY-MM-DD_HH-MM-SS.log`); `SERVICE_LOG_FILE_PATTERN: RegExp`; `ensureLogsDir(dirPath: string): Promise<void>`; `secureLogFile(filePath: string): Promise<void>`; `FILE_MODE = 0o600`; `ensureLogsDirSync(dirPath: string): void` and `secureLogFileSync(filePath: string): void` (synchronous variants for the logger's rotation path and the service log descriptor); `pruneLogFiles(dirPath: string, pattern: RegExp, retention: number, onError: (message: string, error: unknown) => void): Promise<void>`.

- [ ] **Step 1: Write failing tests:**
  - The main patterns match only their own mode's names; neither main pattern matches a service name; `SERVICE_LOG_FILE_PATTERN` matches only service names.
  - `pruneLogFiles` with three service files, three main files, and `notes.txt`, retention 2 and the service pattern: removes only the oldest service file.
  - `ensureLogsDir` creates a nested directory at mode `0o700` and tightens an existing `0o755` directory to `0o700` (skip on `win32`).
  - `secureLogFile` tightens `0o644` to `0o600`, and the sync variants behave the same (skip on `win32`).
- [ ] **Step 2: Run** `npx vitest run tests/utils/log-files.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Permission calls are no-ops when `process.platform === "win32"`. `pruneLogFiles` sorts matching names (names with a pid suffix compare by pid numerically) and deletes all but the newest `retention`, reporting failures through `onError`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): add log file naming, permission, and pruning helpers`.

### Task 4: Async resolver with invalid-value handling

**Files:** Modify `src/runtime/log-location.ts`, `src/runtime/service/env.ts`, `src/runtime/prompts.ts`; Modify `src/i18n/en.ts` and every other locale file; Test `tests/runtime/log-location.test.ts`.

**Interfaces:**
- Consumes: `parseLogLocation`, `parseLogLocationChoice`, `resolveCanonicalLogsDir` (Task 1); `persistEnvValue` (Task 2); `getLogRetention` (Task 3); `getRuntimePaths` (`src/runtime/paths.ts`); `askVisibleOrEof` (`src/runtime/prompts.ts`); `t` and `resolveSupportedLocale` (`src/i18n/index.ts`); `isServiceChildProcess(env?: NodeJS.ProcessEnv): boolean` and `getServiceLogsDirFromEnv(env?: NodeJS.ProcessEnv): string | null` (`src/runtime/service/env.ts`; the second returns null for an unset or blank `OPENCODE_TELEGRAM_SERVICE_LOGS_DIR`).
- Produces: `resolveLogsDirPath(options?: ResolveLogsDirOptions): Promise<string>` memoized per process; `__resetLogsDirForTests(): void`; `ResolveLogsDirOptions { env?: NodeJS.ProcessEnv; isInteractive?: boolean; prompt?: boolean; ask?: (prompt: string) => Promise<string | null>; warn?: (message: string) => void }` (`ask` resolves null at end of input; `prompt: false` warns and uses `default` without asking, for the config command); `resolveLogRetention(options?: { env?: NodeJS.ProcessEnv }): Promise<number>` (real environment first, then the app-home `.env`; shared by the logger prunes and the daemon service-log prune). The default `ask` is `askVisibleOrEof(question, onInterrupt?)` in `src/runtime/prompts.ts`, which re-raises SIGINT on Ctrl+C.
- i18n keys, with placeholders identical in every locale: `runtime.logs.location_invalid` (`{value}`), `runtime.logs.ask_location` (`{envPath}`), `runtime.logs.location_choice_invalid`, `runtime.logs.location_invalid_no_tty` (`{value}`; no terminal available), `runtime.logs.location_invalid_gave_up` (`{value}`; a terminal existed but input ended or three answers were invalid), `runtime.logs.location_invalid_env` (`{value}`), `runtime.logs.location_persist_failed` (`{envPath}`, `{reason}`), `runtime.logs.env_read_failed` (`{envPath}`, `{reason}`), `runtime.logs.container_overrides_default` (no placeholders), `runtime.logs.container_invalid_value` (`{value}`; an invalid value inside a container).

Resolution order: (1) when `OPENCODE_TELEGRAM_SERVICE_CHILD=1` and `OPENCODE_TELEGRAM_SERVICE_LOGS_DIR` is set and not blank, return it (a blank value falls through to normal resolution); (2) setting from `env.LOG_LOCATION`, else from `dotenv.parse` of `getRuntimePaths().envFilePath` (ENOENT ignored); (3) `valid app` returns `getRuntimePaths().logsDirPath`, `valid default` or `unset` returns the canonical directory, computed (with `os.homedir()`) only when it is used, except inside a container (`isContainerRuntime` from `src/runtime/container.ts`, called with the injected `env`), where `valid default` and `unset` return `getRuntimePaths().logsDirPath` and an explicit `default` first writes one `runtime.logs.container_overrides_default` warning (no placeholders; no warning for `unset`); (4) `invalid` inside a container writes one `runtime.logs.container_invalid_value` warning and returns `getRuntimePaths().logsDirPath`, with no prompt and no persistence, whether the value came from the real environment or from `.env`; outside a container `invalid` follows the TTY rules in Global Constraints. When the invalid value came from the real environment, warn with `location_invalid_env`, do not persist, and use `default`. Warnings are translated with an explicit locale, never by changing the global one: `BOT_LOCALE` from the real environment first, else from the `.env` file, resolved with `resolveSupportedLocale` and passed to `t(key, params, locale)` (the resolver runs before `config.ts` loads `.env`). The `.env` file is read only when `LOG_LOCATION` or `BOT_LOCALE` is missing from the environment; when it cannot be read (an error other than ENOENT) and `LOG_LOCATION` is needed from it, the resolver warns with `runtime.logs.env_read_failed` and returns the canonical directory (the app home inside a container), and when the read was needed only for the locale the failure is ignored and a valid real-environment `LOG_LOCATION` is kept.

- [ ] **Step 1: Write failing tests** with injected `env`, `ask`, `warn`: unset gives canonical; `app` gives `<appHome>/logs`; `LOG_LOCATION=` (empty) gives canonical with `warn` not called; real env beats a conflicting `.env` value; invalid with `isInteractive: true` and `ask` returning `"x"` then `"app"` calls `ask` twice, persists `LOG_LOCATION=app` to `.env`, and returns the app path; invalid with `isInteractive: false` calls `warn` once and returns canonical without persisting; invalid from `env` (not `.env`) calls `warn` once, does not persist; service child override wins over everything, and a blank handed-down directory falls through to normal resolution; warnings use `BOT_LOCALE` from the environment, else from `.env`; an unreadable `.env` warns with `env_read_failed` and returns the canonical directory, while a real-environment `LOG_LOCATION` is kept when the read was needed only for the locale; answers `1` and `2` are accepted as `default` and `app`; end of input or exhausted answers on a terminal warn with `location_invalid_gave_up`; `prompt: false` warns once and does not ask; `LOG_LOCATION=app` resolves without calling `os.homedir()`; a second call returns the memoized value without calling `ask` again. Container tests (the host's `/.dockerenv` is neutralized by mocking `isContainerRuntime`): unset gives the app logs directory without a warning and without calling `os.homedir()`; `default` from the real environment gives the app logs directory with one `container_overrides_default` warning; `default` from `.env` does the same; `/.dockerenv` present counts as a container; an invalid value from the real environment or from `.env` (with a terminal available, and with `prompt: false`) gives the app logs directory with one `container_invalid_value` warning, without calling `ask` and without persisting; an unreadable `.env` gives the app logs directory with the `env_read_failed` warning; the handed-down service directory beats the container rule; a false container flag (`0`, `false`) behaves as outside a container. `resolveLogRetention` returns the `.env` value when the environment has none and the environment value when both are set.
- [ ] **Step 2: Run** `npx vitest run tests/runtime/log-location.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the i18n keys listed above** to `en.ts` and a translation in each of the other locale files (the `I18nKey` type forces parity). Run `npx vitest run tests/i18n`. Expected: PASS.
- [ ] **Step 4: Implement `resolveLogsDirPath`.** Default `isInteractive` is `process.stdin.isTTY && process.stdout.isTTY`. Default `warn` writes to `process.stderr`. `log-location.ts` and its imports (`env-file.ts`, `src/secrets/file-permissions.ts`, `prompts.ts`, `service/env.ts`) must not import the logger, directly or transitively.
- [ ] **Step 5: Run** the Task 4 tests and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(logs): resolve log directory from LOG_LOCATION`.

### Task 5: Logger uses the resolver, application-prefixed names, permissions, per-type retention

**Files:** Modify `src/utils/logger.ts`; Modify `tests/utils/logger.test.ts`.

**Interfaces:**
- Consumes: `resolveLogsDirPath`, `resolveLogRetention` (Task 4); `buildMainLogFileName`, `getMainLogFilePattern`, `ensureLogsDir`, `secureLogFile`, `ensureLogsDirSync`, `secureLogFileSync`, `FILE_MODE`, `pruneLogFiles` (Task 3).
- Produces: `getLogFilePath(): string | null`; `initializeLogger(options?: { promptForLogLocation?: boolean }): Promise<void>` (false is passed by the `config` command so the wizard asks the location question once; with no argument the resolver prompts for an invalid `.env` value when a terminal is available). A failed initialization is remembered for the process, so the unusable-directory warning appears once even though both entrypoints call it twice. Pruning uses `resolveLogRetention` (Task 4). The module holds the resolved directory in a module variable, which `rotateInstalledLogIfNeeded` uses for daily rotation.

- [ ] **Step 1: Write tests** in `tests/utils/logger.test.ts`. The expected installed daily names and sources per-launch names use the `opencode-telegram-bot-` prefix; those tests set `LOG_LOCATION=app` so `tempHome/logs` stays the directory under test. Add: initialization with `LOG_LOCATION=default` writes under the resolved canonical directory (inject through `OPENCODE_TELEGRAM_SERVICE_LOGS_DIR` with `OPENCODE_TELEGRAM_SERVICE_CHILD=1` to avoid touching the real home); the new file is `0o600` and its directory `0o700` (skip on `win32`); an unwritable directory (a regular file occupying the path) produces exactly one stderr warning and `logger.info` still works, and stays at one warning when `initializeLogger` is called twice; a `LOG_RETENTION` present only in `.env` prunes the main logs, and a real `LOG_RETENTION` overrides it; `initializeLogger({ promptForLogLocation: false })` calls the resolver with `{ prompt: false }`, and the `config` command passes it (`tests/cli/config-command.test.ts`).
- [ ] **Step 2: Run** `npx vitest run tests/utils/logger.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the name and pattern helpers from `log-files.ts`; resolve the directory in `initializeLoggerInternal`; at initialization call the async `ensureLogsDir` before opening and `secureLogFile` after `appendFile`; the synchronous daily rotation uses `ensureLogsDirSync`, `fs.appendFileSync` with `FILE_MODE`, and `secureLogFileSync`; use `pruneLogFiles` with `await resolveLogRetention()` as the retention and `reportLoggerInternalError` as `onError`. The logger's fail-soft catch blocks warn once and keep logging to the console. Add the `initializeLogger` options parameter and the remembered failed initialization described above, and pass `{ promptForLogLocation: false }` from `runConfigCommand` in `src/cli.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/utils/logger.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): write bot logs to the resolved directory with owner-only permissions`.

### Task 6: Daemon service log and handed-down directory

**Files:** Modify `src/runtime/service/manager.ts`, `src/runtime/service/env.ts`; Modify `tests/runtime/service/manager.test.ts`.

**Interfaces:**
- Consumes: `resolveLogsDirPath`, `resolveLogRetention` (Task 4); `buildServiceLogFileName`, `SERVICE_LOG_FILE_PATTERN`, `ensureLogsDir`, `secureLogFileSync`, `FILE_MODE`, `pruneLogFiles` (Task 3).
- Produces: `buildServiceChildEnv(baseEnv: NodeJS.ProcessEnv, stateFilePath: string, logsDirPath: string): NodeJS.ProcessEnv` adds `OPENCODE_TELEGRAM_SERVICE_LOGS_DIR`; `startBotDaemon` returns `{ success: false, service: null, error }` when the service log cannot be opened, before spawning and without leaving a state file.

- [ ] **Step 1: Write tests** (`manager.test.ts` mocks `resolveLogsDirPath` and keeps the real `resolveLogRetention`): the service log name matches `SERVICE_LOG_FILE_PATTERN`; the child env contains the resolved directory; the file descriptor is opened with mode `0o600`; with a regular file occupying the logs directory path, `startBotDaemon` returns `success: false`, `spawn` is not called, and no `bot-service.json` exists; service logs beyond `LOG_RETENTION` (from the environment or only from `.env`) are pruned while main logs are untouched; a daemon child whose handed-down directory is missing recreates it through the logger's `ensureLogsDir` call (covered in Task 5 by the logger test "writes to the handed-down service directory, creating it owner-only"; the resolver only returns the directory).
- [ ] **Step 2: Run** `npx vitest run tests/runtime/service/manager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `startBotDaemon`: resolve the directory, `ensureLogsDir` (async), build the file name, open with `fs.openSync(path, "a", FILE_MODE)` inside the existing `try` so failure returns the error result, `secureLogFileSync`, prune with `SERVICE_LOG_FILE_PATTERN` and `await resolveLogRetention()`, pass the directory to `buildServiceChildEnv`.
- [ ] **Step 4: Run** the manager tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): daemon service log in resolved directory, fail startup if unwritable`.

### Task 7: Wizard, `.env.example`, Docker

**Files:** Modify `src/runtime/bootstrap.ts`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `src/i18n/*.ts`; Test `tests/runtime/bootstrap-wizard.test.ts`, `tests/runtime/bootstrap.test.ts`.

**Interfaces:**
- Produces: `WizardEnvValues.LOG_LOCATION?: "default" | "app"`, added to `WIZARD_ENV_KEYS` and `buildFlatEnvFileContent`'s `orderedUpdates`; i18n keys `runtime.wizard.ask_log_location` (`{defaultLocation}`) and `runtime.wizard.log_location_invalid` (`{defaultLocation}`), in every locale. The wizard answer is parsed with `parseLogLocationChoice` (Task 1).

- [ ] **Step 1: Write failing tests:** `buildEnvFileContent` writes `LOG_LOCATION=app` over the commented template line; an existing `LOG_LOCATION=app` is the wizard default; the prompt accepts `1`, `2`, `default`, `app`, and Enter (keeps default), and rejects anything else with `log_location_invalid`, whose text names the Enter default; `bootstrap.test.ts` asserts the commented `.env.example` entry, `ENV LOG_LOCATION=app` in the `Dockerfile`, a `LOG_LOCATION=app` line in the `docker-compose.yml` environment list, and no `LOG_LOCATION` line in `docker-compose.desktop.yml`.
- [ ] **Step 2: Run** `npx vitest run tests/runtime/bootstrap-wizard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** an `askLogLocation` modeled on `askServerVersion`; add the commented `# LOG_LOCATION=default` entry with an explanation to `.env.example` next to `LOG_RETENTION`; add `ENV LOG_LOCATION=app` and `ENV OPENCODE_TELEGRAM_CONTAINER=1` (so plain `docker run` and Podman are detected as containers) to the runtime stage of the `Dockerfile` and `LOG_LOCATION=app` to the `environment` list of `docker-compose.yml` (Compose `env_file` values override the image ENV; a real environment variable beats `.env`, and the data volume can shadow an image-baked `.env`); add i18n keys to every locale.
- [ ] **Step 4: Run** `npx vitest run tests/runtime tests/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): config wizard and Docker support for LOG_LOCATION`.

### Task 8: Documentation

**Files:** Modify `README.md`, `AGENTS.md` (Logging section), `PRODUCT.md`, `docs/LINUX_SYSTEMD_SETUP.md` (when it names log locations), `.env.example` comments for `LOG_RETENTION` and `LOG_LOCATION`.

- [ ] **Step 1: Update** each document to state the current design: canonical locations, `LOG_LOCATION`, the `opencode-telegram-bot-` file names, per-type retention and its `.env` lookup, 0700 and 0600 permissions, daemon service log failure behavior, the numbered prompt choices. `AGENTS.md` has no `<project root>/logs` wording and no unprefixed `bot-YYYY-MM-DD` names. `PRODUCT.md` has a ticked checkbox for this feature. Bump frontmatter only on files that have it.
- [ ] **Step 2: Verify** with `grep -rn "<project root>/logs\|[^-]bot-YYYY\|[^-]bot-service-" README.md AGENTS.md PRODUCT.md docs/LINUX_SYSTEMD_SETUP.md` that no stale names or locations remain. Expected: no matches.
- [ ] **Step 3: Commit** `docs(logs): document canonical log locations and LOG_LOCATION`.

### Task 9: Integration and end-to-end tests

**Files:** Create `tests/runtime/log-location-integration.test.ts` and `tests/e2e/log-location.test.ts`; update the launcher scripts in `e2e/` (`run-test-bot.*`, `stop-test-bot.*`, `README.md`) and `tests/e2e/run-test-bot.test.ts`.

- [ ] **Step 1: Integration test.** With a temp `HOME`, `XDG_STATE_HOME`, `OPENCODE_TELEGRAM_HOME`, and mocked `spawn`, run `initializeLogger`, then `startBotDaemon`; assert the main log and the service log land in the same directory and both are `0o600` (skip modes on `win32`).
- [ ] **Step 2: End-to-end test.** `tests/e2e/log-location.test.ts` compiles the project with `tsc` into a temporary directory (which also holds copies of `package.json` and `.env.example` and a `node_modules` link, so nothing is written into the repository), runs the built entrypoint in both runtime modes against temporary home-like variables, and asserts a log file exists at the canonical path for the current OS (mode 0700 directory and 0600 file on Unix), and that `LOG_LOCATION=app` puts it in `<appHome>/logs` and creates nothing in the canonical directory. The `e2e/` launchers set `LOG_LOCATION=app` so a run stays in the isolated home, and their log lookups match the `opencode-telegram-bot-` main-log names only.
- [ ] **Step 3: Run the full suite** `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`. Expected: all pass, no failures or warnings introduced.
- [ ] **Step 4: Commit** `test(logs): integration and end-to-end coverage for log relocation`.

---

## Self-Review

- Spec coverage: decisions 1-4 map to Tasks 1, 4, 7; decision 5 to Tasks 3, 6; decision 6 to Task 3; decision 7 to Task 5; decision 8 requires no code; decision 9 to Tasks 3, 5, 6; decisions 10-12 to Tasks 1, 3; decisions 13-15 to Tasks 2, 4; decision 16 to Task 6. Test requirements map to Tasks 1-6 (unit, boundary, positive and negative), Task 9 (integration, end-to-end).
- Calls made here beyond the spec: the Dockerfile uses `ENV LOG_LOCATION=app` and the Compose `environment` list sets `LOG_LOCATION=app`, with no inserted `.env`; `LOG_RETENTION` is looked up in the real environment, then `.env`; an invalid value from the real environment is not persisted; `RuntimePaths.logsDirPath` is `<appHome>/logs` and is the path `LOG_LOCATION=app` resolves to.
