---
title: Logs Relocation Implementation Plan
status: approved
version: 0.2.0
last_updated: 2026-11-11
review_date: 2027-05-11
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
- `LOG_RETENTION` counts main logs and service logs separately.
- Unix permissions: log directory 0700, log files 0600, enforced on every start including existing paths. Windows relies on default ACLs.
- Unusable directory: the application logger warns once on stderr and the bot keeps running. Daemon startup fails with an error if the service log cannot be opened.
- Invalid `LOG_LOCATION`: with a TTY, warn and prompt for `default` or `app`, save the answer to `.env`; without a TTY, warn once on stderr and use `default`.
- No migration of, or special handling for, `<repo>/logs` and `<appHome>/logs` legacy files.
- Cross-platform: no hardcoded separators; Windows-only logic behind `process.platform`; every test passes on every OS or is skipped outside its OS.
- Code, identifiers, and comments in English; user-facing strings through `t()` with a key in every locale; no raw `console.*` in feature code.
- Docs state the current design only; no counts of dynamic things; no Mermaid; frontmatter bumped on touched docs that have it.

## Review Focus

- `LOG_LOCATION=` (empty) is treated as unset, with no prompt (Task 1, Task 4).
- `" App "` (case and whitespace) is accepted as `app` (Task 1).
- An invalid `LOG_LOCATION` supplied by the real environment warns and uses `default`, and is not written to `.env`, since `.env` cannot override it (Task 4).
- The main-log and service-log retention scans never delete each other's files or unrelated files such as `notes.txt` (Task 3).
- A pre-existing 0755 log directory and 0644 log file are tightened to 0700 and 0600 (Task 3, Task 5).
- A daemon child whose handed-down log directory was deleted recreates it instead of failing (Task 6).

---

## File Structure

- Create `src/runtime/log-location.ts`: path function, setting parser, async resolver.
- Create `src/runtime/env-file.ts`: atomic `.env` write and single-key persist. `writeFileAtomically` moves here from `bootstrap.ts`.
- Create `src/utils/log-files.ts`: file names, patterns, directory and file permissions, pruning.
- Modify `src/utils/logger.ts`, `src/runtime/service/manager.ts`, `src/runtime/service/env.ts`, `src/runtime/bootstrap.ts`, `src/i18n/*.ts`, `.env.example`, `Dockerfile`, `README.md`, `AGENTS.md`, `PRODUCT.md`.
- Tests: `tests/runtime/log-location.test.ts`, `tests/runtime/env-file.test.ts`, `tests/utils/log-files.test.ts`, plus updates to `tests/utils/logger.test.ts`, `tests/runtime/service/manager.test.ts`, `tests/runtime/bootstrap-wizard.test.ts`.

Branch: create `feat/logs-relocation` from `main` before Task 1. Commit steps run only when the owner authorizes commits; `AGENTS.md` forbids automatic commits.

---

### Task 1: Canonical path and setting parser

**Files:** Create `src/runtime/log-location.ts`; Test `tests/runtime/log-location.test.ts`.

**Interfaces:**
- Produces: `type LogLocation = "default" | "app"`; `type LogLocationSetting = { kind: "unset" } | { kind: "valid"; value: LogLocation } | { kind: "invalid"; raw: string }`; `parseLogLocation(raw: string | undefined): LogLocationSetting` (trim and lowercase; empty or undefined is `unset`); `resolveCanonicalLogsDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homedir: string): string`.

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

**Files:** Create `src/runtime/env-file.ts`; Modify `src/runtime/bootstrap.ts` (import `writeFileAtomically` from `env-file.ts`, delete the local copy at `bootstrap.ts:311-317`); Test `tests/runtime/env-file.test.ts`.

**Interfaces:**
- Produces: `writeFileAtomically(filePath: string, content: string): Promise<void>` (same behavior as today); `persistEnvValue(envFilePath: string, key: string, value: string): Promise<void>`.

- [ ] **Step 1: Write failing tests** using a temp directory: creates the file when missing with `LOG_LOCATION=app\n`; replaces an existing active `LOG_LOCATION=bad` line and keeps every other line; appends when the key is absent; leaves no `.tmp` sibling; on non-Windows the resulting mode is `0o600` (skip on `win32`).
- [ ] **Step 2: Run** `npx vitest run tests/runtime/env-file.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `persistEnvValue`: read (ENOENT is empty), drop active assignment lines for `key`, append `key=value`, write with `writeFileAtomically` (temp file created 0600). An existing file keeps its mode (a read-only file is reopened with `reopenEnvFileForEdit` from `src/secrets/file-permissions.ts` first, and the mode is restored after the write); a missing file is created 0600. It never calls `finalizeEnvFile`. `persistOpencodeVersion` in `config.ts` is left unchanged because importing `config.ts` runs its load-time side effects.
- [ ] **Step 4: Run** `npx vitest run tests/runtime/env-file.test.ts tests/runtime/bootstrap.test.ts tests/runtime/bootstrap-wizard.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(runtime): extract env file writer and add persistEnvValue`.

### Task 3: Log file naming, permissions, pruning

**Files:** Create `src/utils/log-files.ts`; Test `tests/utils/log-files.test.ts`.

**Interfaces:**
- Produces: `LOG_FILE_PREFIX = "opencode-telegram-bot"`; `buildMainLogFileName(mode: RuntimeMode, now: Date, pid: number): string` (installed `opencode-telegram-bot-YYYY-MM-DD.log`; sources `opencode-telegram-bot-YYYY-MM-DD_HH-MM-SS_<pid>.log`); `getMainLogFilePattern(mode: RuntimeMode): RegExp`; `buildServiceLogFileName(now: Date): string` (`opencode-telegram-bot-service-YYYY-MM-DD_HH-MM-SS.log`); `SERVICE_LOG_FILE_PATTERN: RegExp`; `ensureLogsDir(dirPath: string): Promise<void>`; `secureLogFile(filePath: string): Promise<void>`; `pruneLogFiles(dirPath: string, pattern: RegExp, retention: number, onError: (message: string, error: unknown) => void): Promise<void>`.

- [ ] **Step 1: Write failing tests:**
  - The main patterns match only their own mode's names; neither main pattern matches a service name; `SERVICE_LOG_FILE_PATTERN` matches only service names.
  - `pruneLogFiles` with three service files, three main files, and `notes.txt`, retention 2 and the service pattern: removes only the oldest service file.
  - `ensureLogsDir` creates a nested directory at mode `0o700` and tightens an existing `0o755` directory to `0o700` (skip on `win32`).
  - `secureLogFile` tightens `0o644` to `0o600` (skip on `win32`).
- [ ] **Step 2: Run** `npx vitest run tests/utils/log-files.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Permission calls are no-ops when `process.platform === "win32"`. `pruneLogFiles` sorts matching names and deletes all but the newest `retention`, reporting failures through `onError`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): add log file naming, permission, and pruning helpers`.

### Task 4: Async resolver with invalid-value handling

**Files:** Modify `src/runtime/log-location.ts`; Modify `src/i18n/en.ts` and every other locale file; Test `tests/runtime/log-location.test.ts`.

**Interfaces:**
- Consumes: `parseLogLocation`, `resolveCanonicalLogsDir` (Task 1); `persistEnvValue` (Task 2); `getRuntimePaths` (`src/runtime/paths.ts`); `askVisible` (`src/runtime/prompts.ts`); `t` (`src/i18n/index.ts`).
- Produces: `resolveLogsDirPath(options?: ResolveLogsDirOptions): Promise<string>` memoized per process; `__resetLogsDirForTests(): void`; `ResolveLogsDirOptions { env?: NodeJS.ProcessEnv; isInteractive?: boolean; ask?: (prompt: string) => Promise<string>; warn?: (message: string) => void }`.
- New i18n keys, with placeholders identical in every locale: `runtime.logs.location_invalid` (`{value}`), `runtime.logs.ask_location` (`{envPath}`), `runtime.logs.location_choice_invalid`, `runtime.logs.location_invalid_no_tty` (`{value}`), `runtime.logs.location_invalid_env` (`{value}`).

Resolution order: (1) when `OPENCODE_TELEGRAM_SERVICE_CHILD=1` and `OPENCODE_TELEGRAM_SERVICE_LOGS_DIR` is set, return it; (2) setting from `env.LOG_LOCATION`, else from `dotenv.parse` of `getRuntimePaths().envFilePath` (ENOENT ignored); (3) `valid app` returns `getRuntimePaths().logsDirPath`, `valid default` or `unset` returns the canonical directory; (4) `invalid` follows the TTY rules in Global Constraints. When the invalid value came from the real environment, warn with `location_invalid_env`, do not persist, and use `default`.

- [ ] **Step 1: Write failing tests** with injected `env`, `ask`, `warn`: unset gives canonical; `app` gives `<appHome>/logs`; `LOG_LOCATION=` (empty) gives canonical with `warn` not called; real env beats a conflicting `.env` value; invalid with `isInteractive: true` and `ask` returning `"x"` then `"app"` calls `ask` twice, persists `LOG_LOCATION=app` to `.env`, and returns the app path; invalid with `isInteractive: false` calls `warn` once and returns canonical without persisting; invalid from `env` (not `.env`) calls `warn` once, does not persist; service child override wins over everything; a second call returns the memoized value without calling `ask` again.
- [ ] **Step 2: Run** `npx vitest run tests/runtime/log-location.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the five i18n keys** to `en.ts` and a translation in each of the other locale files (the `I18nKey` type forces parity). Run `npx vitest run tests/i18n`. Expected: PASS.
- [ ] **Step 4: Implement `resolveLogsDirPath`.** Default `isInteractive` is `process.stdin.isTTY && process.stdout.isTTY`. Default `warn` writes to `process.stderr`. Confirm `src/secrets/file-permissions.ts` does not import the logger; if it does, call `fs.chmod` directly in `env-file.ts` to avoid a cycle.
- [ ] **Step 5: Run** the Task 4 tests and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(logs): resolve log directory from LOG_LOCATION`.

### Task 5: Logger uses the resolver, new names, permissions, per-type retention

**Files:** Modify `src/utils/logger.ts`; Modify `tests/utils/logger.test.ts`.

**Interfaces:**
- Consumes: `resolveLogsDirPath` (Task 4); `buildMainLogFileName`, `getMainLogFilePattern`, `ensureLogsDir`, `secureLogFile`, `pruneLogFiles` (Task 3).
- Produces: `getLogFilePath()` and `initializeLogger()` keep their signatures. The module holds the resolved directory in a module variable so `rotateInstalledLogIfNeeded` no longer calls `getRuntimePaths().logsDirPath` (`logger.ts:275-285`).

- [ ] **Step 1: Update tests.** Rename the expected files in `tests/utils/logger.test.ts` (`bot-2026-04-11.log` and the sources pattern names near lines 182-299) to the `opencode-telegram-bot-` prefix, and set `LOG_LOCATION=app` in those tests so `tempHome/logs` stays the directory under test. Add: initialization with `LOG_LOCATION=default` writes under the resolved canonical directory (inject through `OPENCODE_TELEGRAM_SERVICE_LOGS_DIR` with `OPENCODE_TELEGRAM_SERVICE_CHILD=1` to avoid touching the real home); the new file is `0o600` and its directory `0o700` (skip on `win32`); an unwritable directory (a regular file occupying the path) produces exactly one stderr warning and `logger.info` still works.
- [ ] **Step 2: Run** `npx vitest run tests/utils/logger.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the local name and pattern helpers with those from `log-files.ts`; resolve the directory in `initializeLoggerInternal`; call `ensureLogsDir` before opening and `secureLogFile` after `appendFile`; use `pruneLogFiles` with `reportLoggerInternalError` as `onError`. Existing fail-soft catch blocks stay.
- [ ] **Step 4: Run** `npx vitest run tests/utils/logger.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): write bot logs to the resolved directory with owner-only permissions`.

### Task 6: Daemon service log and handed-down directory

**Files:** Modify `src/runtime/service/manager.ts`, `src/runtime/service/env.ts`; Modify `tests/runtime/service/manager.test.ts`.

**Interfaces:**
- Consumes: `resolveLogsDirPath` (Task 4); `buildServiceLogFileName`, `SERVICE_LOG_FILE_PATTERN`, `ensureLogsDir`, `secureLogFile`, `pruneLogFiles` (Task 3).
- Produces: `buildServiceChildEnv(baseEnv: NodeJS.ProcessEnv, stateFilePath: string, logsDirPath: string): NodeJS.ProcessEnv` adds `OPENCODE_TELEGRAM_SERVICE_LOGS_DIR`; `startBotDaemon` returns `{ success: false, service: null, error }` when the service log cannot be opened, before spawning and without leaving a state file.

- [ ] **Step 1: Update tests** (`manager.test.ts` stubs `logsDirPath` near lines 38 and 97): the service log name matches `SERVICE_LOG_FILE_PATTERN`; the child env contains the resolved directory; the file descriptor is opened with mode `0o600`; with a regular file occupying the logs directory path, `startBotDaemon` returns `success: false`, `spawn` is not called, and no `bot-service.json` exists; service logs beyond `LOG_RETENTION` are pruned while main logs are untouched; a child-side call to `resolveLogsDirPath` with the handed-down directory deleted recreates it (covered in Task 4 plus `ensureLogsDir`).
- [ ] **Step 2: Run** `npx vitest run tests/runtime/service/manager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `startBotDaemon`: resolve the directory, `ensureLogsDir`, build the file name, open with `fs.openSync(path, "a", 0o600)` inside the existing `try` so failure returns the error result, `secureLogFile`, prune with `SERVICE_LOG_FILE_PATTERN`, pass the directory to `buildServiceChildEnv`.
- [ ] **Step 4: Run** the manager tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): daemon service log in resolved directory, fail startup if unwritable`.

### Task 7: Wizard, `.env.example`, Docker

**Files:** Modify `src/runtime/bootstrap.ts`, `.env.example`, `Dockerfile`, `src/i18n/*.ts`; Test `tests/runtime/bootstrap-wizard.test.ts`.

**Interfaces:**
- Produces: `WizardEnvValues.LOG_LOCATION?: "default" | "app"`, added to `WIZARD_ENV_KEYS` and `buildFlatEnvFileContent`'s `orderedUpdates`; new keys `runtime.wizard.ask_log_location` (`{defaultLocation}`) and `runtime.wizard.log_location_invalid`, in every locale.

- [ ] **Step 1: Write failing tests:** `buildEnvFileContent` writes `LOG_LOCATION=app` over the commented template line; an existing `LOG_LOCATION=app` is the wizard default; the prompt accepts `1`, `2`, `default`, `app`, and Enter (keeps default), and rejects anything else with `log_location_invalid`.
- [ ] **Step 2: Run** `npx vitest run tests/runtime/bootstrap-wizard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** an `askLogLocation` modeled on `askServerVersion` (`bootstrap.ts:462`); add the commented `# LOG_LOCATION=default` entry with an explanation to `.env.example` next to `LOG_RETENTION`; add `ENV LOG_LOCATION=app` to the runtime stage of the `Dockerfile` (a real environment variable beats `.env`, and the data volume can shadow an image-baked `.env`); add i18n keys to every locale.
- [ ] **Step 4: Run** `npx vitest run tests/runtime tests/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(logs): config wizard and Docker support for LOG_LOCATION`.

### Task 8: Documentation

**Files:** Modify `README.md`, `AGENTS.md` (Logging section), `PRODUCT.md`, `.env.example` comments for `LOG_RETENTION`.

- [ ] **Step 1: Update** each document to state the current design: canonical locations, `LOG_LOCATION`, new file names, per-type retention, 0700 and 0600 permissions, daemon service log failure behavior. Remove the `<project root>/logs` wording and the `bot-YYYY-MM-DD` names from `AGENTS.md`. Tick the matching `PRODUCT.md` checkbox if one exists, otherwise add one. Bump frontmatter only on files that have it.
- [ ] **Step 2: Verify** with `grep -rn "bot-service-\|logs/\|bot-YYYY" README.md AGENTS.md PRODUCT.md docs/LINUX_SYSTEMD_SETUP.md` that no stale names remain. Expected: no stale matches.
- [ ] **Step 3: Commit** `docs(logs): document canonical log locations and LOG_LOCATION`.

### Task 9: Integration and end-to-end tests

**Files:** Create `tests/runtime/log-location-integration.test.ts`; extend the harness in `e2e/` and `tests/e2e/`.

- [ ] **Step 1: Integration test.** With a temp `HOME`, `XDG_STATE_HOME`, `OPENCODE_TELEGRAM_HOME`, and mocked `spawn`, run `initializeLogger`, then `startBotDaemon`; assert the main log and the service log land in the same directory and both are `0o600` (skip modes on `win32`).
- [ ] **Step 2: End-to-end test.** Inspect `e2e/run-test-bot.sh` and the existing e2e specs, then add a case that starts the built bot in installed mode against a temp `HOME` and asserts a log file exists at the canonical path for the current OS, and that setting `LOG_LOCATION=app` puts it in `<appHome>/logs`.
- [ ] **Step 3: Run the full suite** `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`. Expected: all pass, no failures or warnings introduced.
- [ ] **Step 4: Commit** `test(logs): integration and end-to-end coverage for log relocation`.

---

## Self-Review

- Spec coverage: decisions 1-4 map to Tasks 1, 4, 7; decision 5 to Tasks 3, 6; decision 6 to Task 3; decision 7 to Task 5; decision 8 requires no code; decision 9 to Tasks 3, 5, 6; decisions 10-12 to Tasks 1, 3; decisions 13-15 to Tasks 2, 4; decision 16 to Task 6. Test requirements map to Tasks 1-6 (unit, boundary, positive and negative), Task 9 (integration, end-to-end).
- Calls made here beyond the spec: the Dockerfile uses `ENV LOG_LOCATION=app` instead of an inserted `.env`; an invalid value from the real environment is not persisted; `RuntimePaths.logsDirPath` keeps meaning `<appHome>/logs`.
