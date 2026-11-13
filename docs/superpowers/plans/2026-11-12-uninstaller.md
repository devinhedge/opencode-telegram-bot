---
title: Uninstaller Implementation Plan
status: draft
version: 0.1.6
last_updated: 2026-11-12
review_date: 2027-05-12
spec: docs/superpowers/specs/2026-11-11-uninstaller-design.md
---

# Uninstaller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `opencode-telegram uninstall`: stop the bot daemon and any other running bot, remove app-home data and keychain secrets, remove the optional systemd unit, and leave only logs, with every action confirmed, localized, and idempotent.

**Architecture:** A new directory `src/runtime/uninstall/` holds small modules that each return structured results and print nothing: stored-data inventory, app-home and override handling, safe path removal, keychain removal, process scan, systemd removal, OpenCode server lookup. One orchestrator (`run.ts`) builds the plan, asks, executes in a fixed order, formats every line through `t()`, and returns the exit code. `src/cli.ts` only dispatches. All side effects enter through an injected `UninstallDeps` so tests never touch the real keychain, home directory, processes, or sudo.

**Tech Stack:** TypeScript 5 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `NodeNext` imports with `.js` suffix), Node 22.14+, Vitest, `dotenv`, `@napi-rs/keyring`, existing `t()` i18n.

**Spec:** `docs/superpowers/specs/2026-11-11-uninstaller-design.md` (decisions 1-21 and the confirmed agent calls are binding).

**Branch:** execute in a worktree on a new branch `feat/uninstaller-impl` cut from `feat/uninstaller`. Commit steps run only when the owner authorizes commits.

## Global Constraints

- Command `opencode-telegram uninstall` with flags `--yes` and `--stop-opencode`; both rejected for other commands. Exit 0 on success (including nothing to remove and skipped optional steps), 1 on a failed step, a declined confirmation, or a refusal, 2 on invalid arguments.
- Refuses inside a container (`isContainerRuntime`) as the first check, even with `--yes`: prints that the container should be rebuilt and redeployed, or destroyed, and removes nothing. Refuses when the effective uid is 0. Never calls Docker.
- Never removes the canonical log directory or `<appHome>/logs`; removes the app home directory only when nothing is left in it.
- Removes from the OS default installed app home and, when `OPENCODE_TELEGRAM_HOME` is set and differs, from that override (after validation and a separate y/n): `.env`, `.env.bak`, `settings.json`, `settings.json.bak`, `settings.json.tmp`, `secrets.enc`, `keystore_password`, `run/`, `local-commands/`, and interrupted-write temporary siblings (`.env.<pid>.<uuid>.tmp`, `secrets.enc.<pid>.<uuid>.tmp`). Never cleans a source checkout's own files.
- Keychain items under service `opencode-telegram-bot` (every account the bot can create) are removed whatever happens to the override step.
- One y/n for the plan; `--yes` skips only that. The override removal, `--stop-opencode`, and each bot process found ask separately and `--yes` does not skip them; with no terminal those steps are skipped with a message and the summary lists what was left. Without `--yes` and without a terminal, the plan is printed and nothing is removed.
- `sudo` only for the systemd unit steps, with inherited stdio and never a password string; without a terminal or `sudo` the exact commands are printed instead.
- All output goes to stdout through `t()` with a key and a real translation in every locale (identical placeholders); step-by-step trace lines; no file logger is started; no secret value is ever printed.
- Idempotent: a rerun after a partial failure completes the remaining steps; absent items are not errors.
- Tests write only inside temp directories, never touch the real keychain, home, processes, sudo, or the canonical log directory, pin container detection, and never stub `process.platform` to `win32` on POSIX.
- macOS and Linux behavior for the process scan and systemd; on Windows those two steps are skipped with a message and the code still typechecks and its tests pass or skip on Windows.
- Code, identifiers, comments in English; Prettier width 100; no raw `console.*`; surgical changes; docs state the current design only.

## Review Focus

- Nothing in `<appHome>/logs` or the canonical log directory is ever removed, even with `LOG_LOCATION=app` and with legacy logs present (Task 3, Task 10).
- A symlinked `.env` or `secrets.enc` loses its link only; an outside target is reported, never deleted (Task 3).
- The process scan never lists the uninstaller's own process chain, never kills without a per-process confirmation, and tolerates a launcher symlink, a relative script path, and a dangling link (Task 6).
- No test can reach the real keychain; the end-to-end test with `--yes` runs only on Linux with no session bus in the child environment (Task 13).
- A declined confirmation, no terminal without `--yes`, a container, and root each remove nothing and exit 1 (Task 10).

---

## File Structure

- Create `src/runtime/stored-data.ts`; `src/runtime/uninstall/{homes,remove-path,keychain,processes,systemd,opencode-server,messages,run}.ts`; `src/opencode/process-control.ts`.
- Modify `src/runtime/paths.ts` (export `getInstalledAppHome`), `src/secrets/keychain-secret-store.ts` (add `removeSecret`), `src/opencode/process.ts` and `src/config.ts` (re-export and import moved code), `src/cli/args.ts`, `src/cli.ts`, `src/i18n/*.ts`, `README.md`, `docs/LINUX_SYSTEMD_SETUP.md`, `PRODUCT.md`.
- Tests under `tests/runtime/uninstall/`, `tests/runtime/stored-data.test.ts`, `tests/cli/`, `tests/e2e/uninstall.test.ts`, and a shared build helper `tests/helpers/e2e-build.ts` extracted from `tests/e2e/log-location.test.ts`.

---

### Task 1: Stored-data inventory

**Files:** Create `src/runtime/stored-data.ts`; Test `tests/runtime/stored-data.test.ts`.

**Interfaces:**
- Consumes: `SECRET_ENV_VARS` (`src/secrets/migrate-secrets.ts`), `INTEGRITY_CHECKSUM_ACCOUNT`, `INTEGRITY_USER_ID_ACCOUNT` (`src/secrets/integrity.ts`), `SERVICE_NAME` value `"opencode-telegram-bot"` (`src/secrets/keychain-secret-store.ts`, private: export it as `KEYCHAIN_SERVICE_NAME`).
- Produces: `KEYCHAIN_SERVICE: string`; `STORED_KEYCHAIN_ACCOUNTS: readonly string[]` (the `SECRET_ENV_VARS` values plus both integrity accounts); `interface StoredEntry { name: string; kind: "file" | "dir" }`; `STORED_APP_HOME_ENTRIES: readonly StoredEntry[]`; `STORED_TEMP_SIBLING_PATTERNS: readonly RegExp[]`; `PRESERVED_APP_HOME_ENTRIES: readonly string[]` (`["logs"]`); `listAppHomeTargets(appHome: string): Promise<string[]>` (absolute paths that exist by `lstat`, including temp siblings, never a preserved entry).

- [ ] **Step 1: Failing tests:** `STORED_KEYCHAIN_ACCOUNTS` equals the `SECRET_ENV_VARS` values plus the two integrity accounts; `listAppHomeTargets` on a temp home with every entry, a `.env.1.abc.tmp`, a `secrets.enc.1.abc.tmp`, `logs/`, and an unrelated `notes.txt` returns the stored entries and temp siblings and neither `logs` nor `notes.txt`; a dangling symlink named `.env` is listed; a guard test scans `src/**/*.ts` with `/(?:set|get|delete)Secret\(\s*"([a-z_]+)"/g` and asserts every literal account is in `STORED_KEYCHAIN_ACCOUNTS` (a new account without an inventory entry fails the build).
- [ ] **Step 2:** `npx vitest run tests/runtime/stored-data.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the exports above in `src/runtime/stored-data.ts`; export `KEYCHAIN_SERVICE_NAME` from the keychain store and re-export it as `KEYCHAIN_SERVICE`.
- [ ] **Step 4:** Run the test, `npm run lint`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): declare the stored-data inventory`.

### Task 2: App homes and override validation

**Files:** Modify `src/runtime/paths.ts` (export `getInstalledAppHome`); Create `src/runtime/uninstall/homes.ts`; Test `tests/runtime/uninstall/homes.test.ts`.

**Interfaces:**
- Consumes: `getInstalledAppHome(): string` (now exported).
- Produces: `interface UninstallHomes { defaultHome: string; overrideHome: string | null }`; `resolveUninstallHomes(env?: NodeJS.ProcessEnv): UninstallHomes` (the override is the resolved `OPENCODE_TELEGRAM_HOME` when set and different from the default, else `null`); `type OverrideInvalidReason = "missing" | "not-a-directory" | "root" | "user-home" | "no-bot-files"`; `type OverrideValidation = { ok: true } | { ok: false; reason: OverrideInvalidReason }`; `validateOverrideHome(path: string, homedir?: string): Promise<OverrideValidation>` (valid when a directory that is not a filesystem root and not `homedir` and contains `.env`, `settings.json`, or `run/bot-service.json`; a missing path is `missing` and is never created).

- [ ] **Step 1: Failing tests (stub `HOME`, `os.homedir`, `XDG_CONFIG_HOME`, `APPDATA`, and delete `OPENCODE_TELEGRAM_HOME` with `vi.stubEnv`; the global `getRuntimePaths` mock does not protect code that bypasses it):** default home per platform inputs via the real function; override equal to default gives `null`; override set gives its resolved path; `validateOverrideHome` returns `missing` for a nonexistent path and the path still does not exist afterwards, `not-a-directory` for a file, `root` for the filesystem root, `user-home` for the home directory, `no-bot-files` for an empty directory, `ok` with each of the three marker files.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** (export the existing `getInstalledAppHome` in place; no other change to `paths.ts`).
- [ ] **Step 4:** Run the test, the existing `tests/runtime/paths.test.ts`, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): resolve app homes and validate the override`.

### Task 3: Safe path removal

**Files:** Create `src/runtime/uninstall/remove-path.ts`; Test `tests/runtime/uninstall/remove-path.test.ts`.

**Interfaces:**
- Consumes: `listAppHomeTargets`, `PRESERVED_APP_HOME_ENTRIES` (Task 1); `resolveSymlinkTarget(filePath): Promise<string>` (`src/runtime/env-file.ts`).
- Produces: `type RemoveStatus = "removed" | "absent" | "failed"`; `interface RemoveResult { path: string; status: RemoveStatus; linkTarget?: string | undefined; error?: string | undefined }`; `removePath(target: string): Promise<RemoveResult>`; `interface RemoveAppHomeResult { results: RemoveResult[]; homeRemoved: boolean; homeError?: string | undefined }`; `removeAppHomeData(appHome: string): Promise<RemoveAppHomeResult>` (never throws). A `linkTarget` can be missing or inside the home and removed in the same run; Task 10 reports "left in place" only for a target that exists and lies outside the home.

`removePath` uses `lstat`, never `fs.access`: a symlink is unlinked and its final target reported in `linkTarget` and left in place; a regular file or directory is removed recursively; on EPERM or EACCES it chmods the entry to owner-writable once and retries (this covers the Windows read-only attribute); a missing path is `absent`. It never calls `reopenEnvFileForEdit` (that helper creates a missing `.env` and follows links).

- [ ] **Step 1: Failing tests (temp dirs only):** removes a 0400 file; removes a directory tree; `absent` for a missing path; a dangling symlink is removed and `linkTarget` is the missing target; a symlink to a file outside the home removes the link and the target file still exists and `linkTarget` names it; a failing `fs.rm` (spy rejecting EPERM once) is retried after chmod and then `removed`; a persistent failure is `failed` with the error text and no throw; `removeAppHomeData` removes only inventory targets, keeps `logs/` and `notes.txt`, and `homeRemoved` is false while either exists and true when the home ends empty; a second call returns no results (absent entries are not listed) and the same `homeRemoved` as the first when the home still holds preserved entries (idempotent).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4:** Run, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): remove app-home data safely`.

### Task 4: Keychain removal

**Files:** Modify `src/secrets/keychain-secret-store.ts` (add `removeSecret`); Create `src/runtime/uninstall/keychain.ts`; Test `tests/secrets/keychain-secret-store.test.ts` (extend), `tests/runtime/uninstall/keychain.test.ts`.

**Interfaces:**
- Produces: `KeychainSecretStore.removeSecret(account: string): Promise<"removed" | "absent" | "failed">` (the existing `deleteSecret` swallows every error and cannot report; `failed` carries no reason by design, so no library error text reaches the output, and Task 10 prints a generic localized failure line with the account name); `type KeychainRemovalStore = Pick<KeychainSecretStore, "isAvailable" | "removeSecret">`; `interface KeychainRemoval { available: boolean; results: { account: string; status: "removed" | "absent" | "failed" }[] }`; `removeKeychainAccounts(store: KeychainRemovalStore, accounts?: readonly string[]): Promise<KeychainRemoval>` (default `STORED_KEYCHAIN_ACCOUNTS`; when the store is unavailable it returns `available: false` and empty results; never reads or prints a secret value).

- [ ] **Step 1: Failing tests:** `removeSecret` against the mocked `@napi-rs/keyring` `AsyncEntry` returns `removed` when deletion succeeds, `absent` when the library reports no entry, `failed` on any other error (read the library's real return and error shapes first and mirror them in the mock); `removeKeychainAccounts` with a fake store (`isAvailable` and a recorded `removeSecret`) calls it once per inventory account in order, returns the statuses, returns `available: false` without calling `removeSecret` when unavailable, and a second run over an all-`absent` store reports all `absent`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** The encrypted-file backend is not touched here: its file and `keystore_password` are removed by Task 3.
- [ ] **Step 4:** Run, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): remove keychain items and report each result`.

### Task 5: Side-effect-free process control

**Files:** Create `src/opencode/process-control.ts`; Modify `src/opencode/process.ts` and `src/config.ts`; Test `tests/opencode/process-control.test.ts` plus the existing `tests/opencode/process.test.ts`.

`src/opencode/process.ts` imports `src/config.ts`, which loads `.env` into `process.env` and can throw at import, so the uninstaller must not import it.

**Interfaces:**
- Produces in `process-control.ts` (moved from `process.ts`, behavior unchanged, no import of `config.ts`): `resolveLocalOpencodeTarget(apiUrl: string): LocalOpencodeTarget | null`; `findServerPid(port: number): Promise<number | null>`; `killServerProcess(pid: number, timeoutMs?: number): Promise<boolean>`; the pure netstat and `ss` parsers; `DEFAULT_OPENCODE_API_URLS: Record<"v1" | "v2", string>` (moved from `config.ts`, which now imports it); and new `getProcessCommandLine(pid: number): Promise<string | null>` (`ps -o args= -p <pid>`, null on any error). `process.ts` re-exports every moved name so existing imports and tests are unchanged.

- [ ] **Step 1: Failing tests:** `getProcessCommandLine` returns the trimmed output, null on an exec error, null on empty output (mock `exec` the way `manager.test.ts` does); a source test asserts `process-control.ts` does not import `config.js` or `logger.js` (read the file text).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Move and add** the code; update `process.ts` to re-export and `config.ts` to import the constant.
- [ ] **Step 4:** Run the new test, `tests/opencode`, `tests/config.test.ts`, lint, typecheck. Expected: PASS, no behavior change.
- [ ] **Step 5: Commit** `refactor(opencode): extract side-effect-free process control`.

### Task 6: Process scan

**Files:** Create `src/runtime/uninstall/processes.ts`; Test `tests/runtime/uninstall/processes.test.ts`.

**Interfaces:**
- Consumes: `getProcessCommandLine` (Task 5).
- Produces: `interface RawProcess { pid: number; ppid: number; user: string; startedAt: string; args: string }`; `parseProcessList(output: string): RawProcess[]` (from `ps -axo pid=,ppid=,user=,lstart=,args=`); `interface BotProcess { pid: number; user: string; startedAt: string; commandLine: string; verified: boolean }`; `interface ScanDeps { listProcesses(): Promise<RawProcess[]>; realpath(p: string): Promise<string>; cwdOf(pid: number): Promise<string | null>; entryPoints: readonly string[]; ownPid: number; excludePids: readonly number[] }`; `findBotProcesses(deps: ScanDeps): Promise<BotProcess[]>`; `defaultScanDeps(packageRoots: readonly string[]): ScanDeps` (real `ps`, `fs.realpath`, `lsof -a -p <pid> -d cwd -Fn`; `entryPoints` are `<root>/dist/cli.js` and `<root>/dist/index.js` for the running package root and for `<npm root -g>/@grinev/opencode-telegram-bot` when `npm root -g` succeeds).

Matching: argv0 basename is `node` or `nodejs`; the first non-option argument is the script; a relative script resolves against the process cwd from `cwdOf` (when the cwd is unknown the process is still listed with `verified: false`); `realpath` of the script (a failing realpath keeps the lexical path) equals an entry point; for `cli.js` the next argument must be `start` (not `uninstall`, `config`, `status`, `stop`, `--help`); `index.js` always matches. Excluded: the uninstaller's own pid and its ancestors (walk `ppid` up from `ownPid`), and `excludePids` (the daemon from the state file, so it is not asked about twice).

- [ ] **Step 1: Failing tests (pure, fake `ScanDeps`):** `parseProcessList` parses a macOS-style and a Linux-style `ps` sample including a command line with spaces; a launcher-symlink script (`/usr/local/bin/opencode-telegram` realpath to an entry point) matches; a relative `dist/index.js` resolved through `cwdOf` matches the checkout entry point and a different cwd does not; unknown cwd gives `verified: false`; `uninstall`, `config`, `status`, `stop` subcommands do not match; the own pid, its parent `make` process whose args mention `opencode-telegram uninstall`, and an `excludePids` daemon are not returned; an editor with the script path in its args and `grep opencode-telegram` do not match (argv0 is not node); a dangling symlink script is listed lexically; empty and malformed `ps` lines are ignored.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** the pure functions and `defaultScanDeps`.
- [ ] **Step 4:** Run, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): find bots started outside the daemon`.

### Task 7: systemd removal

**Files:** Create `src/runtime/uninstall/systemd.ts`; Test `tests/runtime/uninstall/systemd.test.ts`.

**Interfaces:**
- Produces: `SYSTEMD_UNIT_PATH = "/etc/systemd/system/opencode-telegram-bot.service"`; `SYSTEMD_COMMANDS: readonly (readonly string[])[]` (`systemctl stop opencode-telegram-bot`, `systemctl disable opencode-telegram-bot`, `rm -f <unit path>`, `systemctl daemon-reload`, each run as `sudo <command>`); `interface SystemdDeps { platform: NodeJS.Platform; unitExists(): Promise<boolean>; hasSudo(): Promise<boolean>; isInteractive: boolean; run(command: readonly string[]): Promise<number> }`; `type SystemdOutcome = "not-applicable" | "absent" | "removed" | "skipped-no-terminal" | "skipped-no-sudo" | "failed"`; `interface SystemdResult { outcome: SystemdOutcome; commands: readonly (readonly string[])[]; failedCommand?: readonly string[] | undefined }`; `removeSystemdUnit(deps: SystemdDeps): Promise<SystemdResult>`; `defaultSystemdDeps(): SystemdDeps` (`run` uses `spawn("sudo", command, { stdio: "inherit" })` and resolves the exit code; `hasSudo` uses `which sudo`; never any password handling).

`not-applicable` on any platform but Linux; `absent` when the unit file does not exist; the skipped outcomes return the exact commands for printing; a non-zero exit stops the sequence and returns `failed` with the failing command.

- [ ] **Step 1: Failing tests (fake deps):** non-Linux gives `not-applicable` with no `run` call; missing unit gives `absent`; success runs the four commands in order through `run`; no terminal gives `skipped-no-terminal` without calling `run`; no `sudo` gives `skipped-no-sudo`; a failing second command stops the sequence (`failed`, the third and fourth not run); the commands are returned in the skipped and failed outcomes.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): remove the documented systemd unit`.

### Task 8: OpenCode server lookup

**Files:** Create `src/runtime/uninstall/opencode-server.ts`; Test `tests/runtime/uninstall/opencode-server.test.ts`.

**Interfaces:**
- Consumes: `resolveLocalOpencodeTarget`, `findServerPid`, `killServerProcess`, `getProcessCommandLine`, `DEFAULT_OPENCODE_API_URLS` (Task 5).
- Produces: `resolveOpencodePort(env: NodeJS.ProcessEnv, envFilePath: string): Promise<number | null>` (`OPENCODE_API_URL`, else the default for `OPENCODE_SERVER_VERSION`, each read from the real environment first and then `dotenv.parse` of `.env`; null for a non-local host); `interface OpencodeServer { pid: number; port: number; commandLine: string | null }`; `findOpencodeServer(deps: { port: number | null; findPid: typeof findServerPid; commandLine: typeof getProcessCommandLine }): Promise<OpencodeServer | null>`; `stopOpencodeServer(pid: number, kill?: typeof killServerProcess): Promise<boolean>`.

- [ ] **Step 1: Failing tests:** port from `OPENCODE_API_URL` in the real environment; from `.env` when the environment lacks it; the real environment wins; default port for `v1` and for `v2` when the URL is unset; null for a remote host and for no `.env`; `findOpencodeServer` returns pid, port, and command line, null when no pid or no port; `stopOpencodeServer` returns the kill result.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** (read `.env` itself; never import `config.ts`).
- [ ] **Step 4:** Run, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): find the OpenCode server on its configured port`.

### Task 9: Localized messages

**Files:** Create `src/runtime/uninstall/messages.ts`; Modify `src/i18n/en.ts` and every other locale file; Test `tests/runtime/uninstall/messages.test.ts` plus `tests/i18n`.

**Interfaces:**
- Produces: `type UninstallTranslator = (key: I18nKey, params?: Record<string, string | number>) => string`; `resolveUninstallLocale(env: NodeJS.ProcessEnv, envFilePath: string): Promise<Locale | undefined>` (`BOT_LOCALE` from the real environment, then `dotenv.parse` of the `.env`, then `resolveSupportedLocale`; the CLI does not load `.env` into the environment, and this runs before `.env` is deleted); `createUninstallTranslator(locale: Locale | undefined): UninstallTranslator` (`t(key, params, locale)`).
- New `uninstall.*` keys, identical placeholders in every locale, real translations (no copies of English): `refused_container`, `refused_root`, `plan_header`, `plan_daemon` (`{pid}`), `plan_terminal_bots`, `plan_systemd` (`{path}`), `plan_home` (`{path}`), `plan_override` (`{path}`), `plan_keychain` (`{service}`), `plan_logs_stay` (`{path}`), `plan_opencode_server`, `confirm_plan`, `confirm_override` (`{path}`), `confirm_stop_process` (`{pid}`, `{user}`, `{started}`, `{command}`), `confirm_stop_opencode` (`{pid}`, `{port}`, `{command}`), `no_terminal_plan_only`, `aborted`, `step_daemon_stopped` (`{pid}`), `step_removed` (`{path}`), `step_absent` (`{path}`), `step_failed` (`{path}`, `{reason}`), `step_link_removed` (`{path}`, `{target}`), `step_keychain` (`{account}`, `{status}`), `step_keychain_unavailable`, `step_systemd` (`{outcome}`), `step_systemd_commands` (`{commands}`), `step_process_stopped` (`{pid}`), `step_process_failed` (`{pid}`), `step_process_skipped` (`{pid}`), `step_override_invalid` (`{path}`, `{reason}`), `step_override_skipped` (`{path}`), `step_opencode_stopped` (`{pid}`), `step_opencode_skipped`, `home_removed` (`{path}`), `home_kept` (`{path}`), `summary_ok`, `summary_left` (`{items}`), `summary_failed` (`{count}`), `cli_hint` (`{command}`).

- [ ] **Step 1: Failing tests:** `resolveUninstallLocale` prefers the real environment over `.env`, reads `.env` when the environment lacks it, returns undefined for an unsupported value and for a missing `.env`; the translator returns the German text for `de` and the English text with no locale; every key above exists in `en`; `tests/i18n` parity and placeholder tests pass.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and add the keys to `en.ts` first, then a translation in each other locale file (insert only the new lines; never run Prettier over i18n files).
- [ ] **Step 4:** `npx vitest run tests/runtime/uninstall/messages.test.ts tests/i18n`, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): localized uninstall messages`.

### Task 10: Orchestrator

**Files:** Create `src/runtime/uninstall/run.ts`; Test `tests/runtime/uninstall/run.test.ts`.

**Interfaces:**
- Consumes: every module above; `isContainerRuntime`, `getBotServiceStatus`, `stopBotDaemon`, `askVisibleOrEof`, `resolveLogsDirPath`.
- Produces: `interface UninstallOptions { yes: boolean; stopOpencode: boolean }`; `interface UninstallDeps { env: NodeJS.ProcessEnv; isContainer(): boolean; getUid(): number | null; isInteractive: boolean; ask(question: string): Promise<string | null>; write(line: string): void; homes: UninstallHomes; getDaemonStatus: typeof getBotServiceStatus; stopDaemon: typeof stopBotDaemon; findBotProcesses(excludePids: readonly number[]): Promise<BotProcess[]>; stopProcess(pid: number): Promise<boolean>; systemd: SystemdDeps; findOpencode(): Promise<OpencodeServer | null>; stopOpencode(pid: number): Promise<boolean>; removeAppHome(appHome: string): ReturnType<typeof removeAppHomeData>; removeKeychain(): Promise<KeychainRemoval>; resolveLogsDir(): Promise<string> }`; `defaultUninstallDeps(): UninstallDeps`; `runUninstall(options: UninstallOptions, deps?: Partial<UninstallDeps>): Promise<number>`.

Order: (1) container refusal; (2) root refusal (`getUid() === 0`); (3) resolve the locale and the logs directory (without prompting) before anything is deleted; (4) detect: daemon status, bot processes (excluding the daemon pid), systemd unit, OpenCode server only with `--stop-opencode`; (5) print the plan including where logs stay; (6) no terminal and no `--yes` prints `no_terminal_plan_only` and returns 1; otherwise one y/n unless `--yes` (a decline prints `aborted` and returns 1; end of input counts as a decline); (7) execute: stop the daemon, ask and stop each bot process, systemd, ask and stop the OpenCode server, remove the default home data, validate and ask for the override home then remove it, remove the keychain items, remove `secrets.enc` and `keystore_password` (part of the home data); (8) print the summary (what was removed, absent, left, failed) and the `cli_hint` line `npm uninstall -g @grinev/opencode-telegram-bot`; exit 1 if any step failed, else 0. Every line goes through the translator; trace lines name the step, outcome, path, and command, never a secret.

- [ ] **Step 1: Failing tests (fake deps; temp homes):** container: prints the refusal, removes nothing, 1, and `--yes` does not bypass it; root (`getUid` 0): same; full run with `--yes` on a temp home: stops the daemon, removes inventory entries, keeps `logs/` and so the home, removes keychain accounts, prints the hint, 0; `LOG_LOCATION=app` home with `logs/` keeps it; idempotent second run: all absent, 0; declined, end of input, and no-terminal-without-`--yes`: nothing removed, 1; bot processes: each asked separately, `--yes` still asks, a no skips and lists the pid left running, no terminal skips; `--stop-opencode` asks separately and stops only on yes, without the flag the server lookup is never called; override home: valid and confirmed is removed, declined is left, `missing` is skipped and not created, an invalid one is skipped with the reason, and the keychain is still removed in every case; a failing removal (`failed` result) makes the exit code 1 while the other steps still run; a symlinked `.env` reports the outside target; no output line contains a secret value (fake store holds `SECRET-SENTINEL`, assert the output never contains it); every line is produced through the translator (German locale prints German text); the daemon pid is passed as an exclusion to the process scan.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** `runUninstall` and `defaultUninstallDeps` (real `process.getuid?.()`, `askVisibleOrEof`, `process.stdout.write`, `defaultScanDeps`, `defaultSystemdDeps`, `new KeychainSecretStore()`).
- [ ] **Step 4:** Run, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): orchestrate the uninstall steps`.

### Task 11: CLI arguments and wiring

**Files:** Modify `src/cli/args.ts`, `src/cli.ts`; Test `tests/cli/args.test.ts` (update), `tests/cli/uninstall-command.test.ts` (create).

**Interfaces:**
- Produces: `CliCommand` gains `"uninstall"`; `ParsedCliArgs` gains `yes: boolean` and `stopOpencode: boolean` (every early-return literal in `parseCliArgs` is updated); `--yes` and `--stop-opencode` are rejected for every other command with new messages (mirroring `daemonOnlyStart`); `CLI_USAGE` lists `uninstall` and both flags; `runUninstallCommand(options: UninstallOptions): Promise<number>` in `src/cli.ts` (sets runtime mode `installed`, sets `LOG_LEVEL` to `silent` unconditionally (the logger's level above `error`) so the existing daemon-stop log lines never mix English or raw error text into the localized trace, dynamic-imports `./runtime/uninstall/run.js`); an explicit `uninstall` branch is added before the `stop` fall-through.

- [ ] **Step 1: Failing tests:** `parseCliArgs(["uninstall"])`, `["uninstall","--yes"]`, `["uninstall","--yes","--stop-opencode"]` parse; `["start","--yes"]` and `["stop","--stop-opencode"]` return the error and `showHelp`; every existing `toEqual` expectation gains `yes: false` and `stopOpencode: false`; the command test (follow `tests/cli/config-command.test.ts`: `vi.hoisted` mocks, `vi.mock` of the logger and of `run.js`, `process.argv`, `vi.resetModules`, `vi.waitFor`) asserts `runUninstall` is called with `{ yes, stopOpencode }`, the exit code is propagated, `LOG_LEVEL` is `silent` in-process whether or not it was set before (and `runUninstall` is never executed for real: `run.js` is mocked).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx vitest run tests/cli`, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uninstall): add the uninstall command`.

### Task 12: Integration test

**Files:** Test `tests/runtime/uninstall/integration.test.ts`.

- [ ] **Step 1: Write the test** (real filesystem in temp dirs; fake keychain store, process list, systemd runner, scripted answers; real `removeAppHomeData`, `listAppHomeTargets`, `resolveUninstallHomes`, translator): a full home with every inventory entry, temp siblings, a symlinked `secrets.enc` pointing outside, `logs/`, and a stub daemon state file whose pid is a fake live process; `runUninstall({ yes: true, stopOpencode: false })` removes everything listed, keeps `logs/` and `notes.txt`, leaves the outside target, reports it, exits 0; a second run is all-absent and exits 0; an override home with marker files removed only after the scripted yes; with `HOME`, `APPDATA`, `XDG_CONFIG_HOME` and `OPENCODE_TELEGRAM_HOME` stubbed to temp dirs the real user home is never listed (assert no path under `os.homedir()` of the test process).
- [ ] **Step 2:** `npx vitest run tests/runtime/uninstall/integration.test.ts`. Expected: PASS (the units already exist; if a behavior gap appears, fix the owning module test-first).
- [ ] **Step 3: Commit** `test(uninstall): integration coverage for the uninstall flow`.

### Task 13: End-to-end test

**Files:** Create `tests/helpers/e2e-build.ts` (extract the temp-directory `tsc` build, `package.json` and `.env.example` copy, and `node_modules` link from `tests/e2e/log-location.test.ts`) and update that test to use it; Create `tests/e2e/uninstall.test.ts`.

- [ ] **Step 1: Write the tests** (spawn the built `dist/cli.js` with a minimal environment allow-list plus `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `APPDATA`, `LOCALAPPDATA`, `OPENCODE_TELEGRAM_HOME` under a temp root; 20 s kill timeout; temp directories removed in `afterAll`): `uninstall --help` and the flag validation exit with 0 and 2; with no terminal and no `--yes` the plan is printed, nothing is removed, exit 1 (runs on every OS, never reaches the keychain); the full `--yes` run on a temp home removes the inventory, keeps `logs/`, prints the hint, exits 0 and a rerun exits 0: guarded `it.skipIf(process.platform !== "linux" || hostIsContainer)` because only Linux with no `DBUS_SESSION_BUS_ADDRESS` in the child environment cannot reach a real keychain (macOS and Windows would delete the developer's real secrets). `hostIsContainer` is `isContainerRuntime({ env: {} })`.
- [ ] **Step 2:** `npx vitest run tests/e2e/uninstall.test.ts tests/e2e/log-location.test.ts --testTimeout=60000`. Expected: PASS.
- [ ] **Step 3: Commit** `test(uninstall): end-to-end coverage with the built CLI`.

### Task 14: Documentation

**Files:** Modify `README.md`, `docs/LINUX_SYSTEMD_SETUP.md`, `PRODUCT.md`; spec and plan frontmatter.

- [ ] **Step 1:** README: a section for `opencode-telegram uninstall` stating the flags, what is removed, what stays (logs), the container refusal, the separate confirmations, the printed `npm uninstall -g` command, and that the Makefile is a separate later feature. `docs/LINUX_SYSTEMD_SETUP.md`: a removal section naming the four `sudo` commands and that `opencode-telegram uninstall` runs them. `PRODUCT.md`: add a checked item in the style of the file. Set the spec `status` to `approved` and bump its version; bump this plan's frontmatter. Current-design wording only; verify every claim against the code.
- [ ] **Step 2:** Verify with separate greps that no doc says the command removes the CLI install itself; run `npm run lint`, `npm run typecheck`, `npm run build`, and the full `npm test -- --testTimeout=60000`. Expected: all pass.
- [ ] **Step 3: Commit** `docs(uninstall): document the uninstall command`.

---

## Calls this plan makes beyond the spec

- The process matcher resolves launcher symlinks with `realpath` and reads the working directory with `lsof` because `ps` shows the launcher path or a relative path; a process whose checkout cannot be determined is listed as unverified and still asked about, never killed without confirmation.
- Interrupted-write siblings written next to a symlinked `.env` or `secrets.enc` target (which can be outside the app home) are not listed because they are outside the home.
- Removal uses a delete-specific helper instead of the `.env` writer's `reopenEnvFileForEdit` (that helper creates a missing `.env` and follows symlinks).
- A new `KeychainSecretStore.removeSecret` reports removed, absent, or failed; `deleteSecret` stays as is.
- Process-control code moves to a side-effect-free module because importing `src/opencode/process.ts` loads `.env` and can throw.
- Without `--yes` and without a terminal the plan is printed and nothing is removed; a declined confirmation exits 1.
- `LOG_LEVEL` is set to `silent` in-process for the uninstall command.
- The end-to-end run with `--yes` is Linux-only to protect the developer's real keychain.

## Self-Review

- Spec coverage: decisions 1, 2, 3 (Task 10), 4 and 17 and 18 (Task 10 hint, Makefile out of scope), 5 and 15 (Tasks 2 and 10), 6 and 20 (Task 7), 7 (Task 9), 8 and 19 (Tasks 8 and 10), 9 (Task 11), 10 (Tasks 3, 10, 12), 11 and 12 (Tasks 1, 3, 10), 13 (Task 10), 14 (Global Constraints; no Docker calls), 16 (out of scope), 21 (Tasks 6 and 10); the confirmed agent calls map to Tasks 1 (inventory), 3 (symlinks, read-only), 4, 9 (stdout trace), 10 (order, container, summary).
- Test requirements: unit (Tasks 1-9), boundary (Tasks 2, 3, 6), positive and negative (Tasks 3, 6, 10), integration (Task 12), end-to-end (Task 13).
