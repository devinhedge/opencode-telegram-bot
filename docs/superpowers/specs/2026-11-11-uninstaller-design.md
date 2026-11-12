---
title: Uninstaller Design
status: draft
version: 0.5.0
last_updated: 2026-11-12
review_date: 2027-05-12
branch: feat/uninstaller
depends_on: logs-relocation feature (canonical per-OS log locations and LOG_LOCATION), merged into feat/core-feature-expansion through pull request 4 and included in this branch
---

# Uninstaller Design (DRAFT)

Status: draft. Records decisions made with the owner. Not approved for planning. Builds on the logs-relocation feature (spec `docs/superpowers/specs/2026-11-11-logs-relocation-design.md`), which this branch includes.

## Intent

`opencode-telegram uninstall` stops the bot daemon, unlinks the global CLI, and removes all bot data so the repository can be deleted safely. Only logs remain.

## Facts about the current system

- The daemon is a detached child process started by `opencode-telegram start --daemon`. State file: `<appHome>/run/bot-service.json`. No launchd, Windows service, or scheduled task exists. See `src/runtime/service/manager.ts`.
- Linux systemd support is a hand-written unit described in `docs/LINUX_SYSTEMD_SETUP.md`. The code never creates it.
- Global CLI install is an npm link: `<prefix>/bin/opencode-telegram` pointing through `<prefix>/lib/node_modules/@grinev/opencode-telegram-bot` to `dist/cli.js`.
- Secrets live in the OS keychain under service `opencode-telegram-bot` (`src/secrets/keychain-secret-store.ts`), with an encrypted-file fallback `secrets.enc`. Account names are enumerated in `src/secrets/migrate-secrets.ts` and `src/secrets/integrity.ts`; there is no enumerate API.
- `.env.bak` retains pre-migration plaintext secrets.
- After the config wizard, `.env` is owner read-only (mode 0400, the read-only attribute on Windows).
- Atomic writes leave temporary sibling files only when a write is interrupted: `.env.<pid>.<uuid>.tmp`, `secrets.enc.<pid>.<uuid>.tmp`, and the temporary siblings of `settings.json` and the files under `run/`.
- `<appHome>/local-commands/` holds user-authored JSON files that define custom Telegram slash commands.
- The OpenCode server the bot starts is a detached process that outlives the bot.
- Logs are written to the canonical per-user log directory (macOS `~/Library/Logs/opencode-telegram-bot/`, Linux `$XDG_STATE_HOME/opencode-telegram-bot/logs/` defaulting to `~/.local/state/opencode-telegram-bot/logs/`, Windows `%LOCALAPPDATA%\opencode-telegram-bot\Logs\`), or to `<appHome>/logs` when `LOG_LOCATION=app`. Main logs are `opencode-telegram-bot-<date or timestamp>.log` and daemon output is `opencode-telegram-bot-service-<timestamp>.log`; the state file records the service log path.
- The runtime detects a container with `isContainerRuntime` (`src/runtime/container.ts`): true when `OPENCODE_TELEGRAM_CONTAINER` is truthy or `/.dockerenv` exists. The Docker image sets the variable.

## Goals

- Stop the bot daemon.
- Remove the global npm links.
- Remove keychain items and `secrets.enc`.
- Remove from app home: `.env`, `.env.bak`, `settings.json` and its backups, `run/`, `local-commands/`, and interrupted-write temporary siblings.
- Preserve logs: never remove the canonical log directory or `<appHome>/logs`.
- Allow the repository to be deleted afterward with nothing left behind except logs.

## Non-goals

- Stopping the OpenCode server by default.
- Relocating or migrating logs.
- Uninstalling from inside a container.
- Removing Docker containers, volumes, or sidecars (for example a telemetry collector).
- Localizing existing `stop` and `status` output (separate feature).
- Fixing the unwired `RESTARTING` env var, the missing `--restart` usage text, or the systemd doc inconsistency (separate issues).

## Anti-goals

- The uninstaller must never receive, store, log, or pass a password on a command line.
- It must never delete anything without showing the plan and receiving confirmation.
- It must never leave a half-removed state that a rerun cannot finish.

## Decisions (owner)

1. Scope is the detached daemon process, the npm links, app-home data, keychain secrets, and the optional systemd unit.
2. Delete keychain secrets, `.env`, `.env.bak`, `settings.json`, and `local-commands/`.
3. Show the full removal plan and ask one y/n confirmation before deleting.
4. Remove the actual symlinks by path using `lstat`. The links may dangle, so they are never resolved.
5. `OPENCODE_TELEGRAM_HOME` override: validate it first, then confirm y/n separately before touching it.
6. Linux systemd unit: remove it with `sudo`. The uninstaller never handles the password.
7. All uninstaller output is localized in every supported locale.
8. The OpenCode server keeps running by default. Stopping it is opt-in.
9. Logic lives in a testable module; `cli.ts` only dispatches.
10. The command is idempotent: rerunning after a partial failure completes the remaining steps.
11. Logs live in the canonical per-OS log directory, or in `<appHome>/logs` with `LOG_LOCATION=app`. The uninstaller never removes either.
12. `<appHome>/logs` is never removed, whatever `LOG_LOCATION` says, so logs left there by earlier runs stay in place. The app home directory is removed only when nothing is left in it.
13. Inside a container the uninstaller refuses to run and removes nothing. It tells the user that the container should be rebuilt and redeployed, or destroyed.
14. The uninstaller never calls Docker and never removes a Docker container or volume, on a host or anywhere else.
15. `--yes` skips only the main confirmation (decision 3). The `OPENCODE_TELEGRAM_HOME` override removal (decision 5) still asks; with no terminal available that step is skipped with a message.

## Agent calls (not yet confirmed by owner)

- Sudo handling: run `sudo systemctl ...` with inherited stdio so sudo prompts on the TTY itself. The owner asked for the password to be passed as a string to the command; this design avoids that because a command-line string is visible in process listings.
- Add an explicit `uninstall` branch in `src/cli.ts`; `stop` is currently the fall-through default.
- Add `uninstall` and its `--yes` flag (decision 15) to `CliCommand` and `SUPPORTED_COMMANDS` in `src/cli/args.ts`; flag validation matches the existing start-only checks.
- Delete from both secret-store backends, keychain and encrypted file.
- The removal plan shows where the logs stay. The uninstaller resolves that directory from `LOG_LOCATION` (real environment, then `.env`) without prompting, before `.env` is deleted; it does not need the value to decide what to remove, because logs are never removed.
- A read-only `.env` is made writable before deletion where the platform needs it (the Windows read-only attribute), using the same reopen step the `.env` writer uses.
- The uninstaller does not initialize the file logger, so it creates no log file of its own.
- What the bot stores (app-home files and keychain accounts) is declared in one place that the uninstaller reads, so a feature that adds stored data registers it once and uninstall removes it. Keychain accounts need this because there is no enumerate API.
- The container check (decision 13) uses `isContainerRuntime`, runs before any other step, and applies even with `--yes`. The refusal message is printed to the terminal in the user's locale, not written to a log file, and the command exits with a non-zero status.

## Test requirements (owner)

- Unit tests.
- Boundary tests.
- Positive and negative tests.
- Integration tests.
- End-to-end tests.

Existing patterns: `tests/runtime/service/manager.test.ts` (mocked `spawn` and `exec`, temp dirs, resolver mock), `src/secrets/fake-secret-store.ts` (in-memory secret store), and `tests/cli/args.test.ts` (full-object `toEqual` expectations that must be updated when the parsed structure changes). Tests must write only inside temp directories, must never touch the real home, keychain, or canonical log directory, and must pin container detection so the host cannot change the result (see `tests/runtime/log-location.test.ts`).

## Open questions

None.
