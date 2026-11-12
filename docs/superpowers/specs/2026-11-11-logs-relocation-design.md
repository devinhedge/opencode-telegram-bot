---
title: Logs Relocation Design
status: approved
version: 0.5.0
last_updated: 2026-11-12
review_date: 2027-05-12
branch: feat/logs-relocation
blocks: uninstaller feature (docs/superpowers/specs/2026-11-11-uninstaller-design.md)
---

# Logs Relocation Design

Status: approved. Records decisions made with the owner.

## Intent

Logs are written to the canonical per-user log directory of each operating system, so they survive deletion of the repository and are easy to find. This feature ships before the uninstaller.

## Facts about the current system

- `src/utils/logger.ts` writes to `<appHome>/logs`. In sources mode `appHome` defaults to `process.cwd()`, which is inside the repo, so logs are deleted with the repo.
- Installed mode writes daily files `bot-YYYY-MM-DD.log`. Sources mode writes per-run files `bot-YYYY-MM-DD_HH-MM-SS_<pid>.log`.
- `LOG_RETENTION` (default 10) prunes files matching the main log pattern only.
- The daemon output log `bot-service-<ts>.log` (`src/runtime/service/manager.ts`) matches no pruning pattern and is never pruned.
- Installed-mode app home is `~/Library/Application Support/opencode-telegram-bot` on macOS, `$XDG_CONFIG_HOME` or `~/.config` plus `/opencode-telegram-bot` on Linux, and `%APPDATA%\opencode-telegram-bot` on Windows.
- The daemon is a detached child of the CLI and runs as the invoking user.

## Goals

- Write logs to the canonical per-user location on each OS, in both sources and installed modes.
- Let the user or the Docker image choose the app-home log location instead.
- Make log file names identify the application.
- Apply retention to every log file type.
- Protect log contents with owner-only permissions on Unix.

## Non-goals

- Migrating logs from old locations.
- Changing log levels, formats, or content.
- The uninstaller itself.

## Anti-goals

- Logging to an unexpected location when the chosen directory is unusable.
- Crashing the bot because the log directory is unusable.

## Decisions (owner)

1. Canonical log directories, same in sources and installed modes:
   - macOS: `~/Library/Logs/opencode-telegram-bot/`
   - Linux: `$XDG_STATE_HOME/opencode-telegram-bot/logs/`, defaulting to `~/.local/state/opencode-telegram-bot/logs/`
   - Windows: `%LOCALAPPDATA%\opencode-telegram-bot\Logs\`
2. The `.env` variable `LOG_LOCATION` takes the values `default` and `app`.
   - `default` is the canonical OS location and is used when the variable is unset.
   - `app` is `<appHome>/logs`.
3. The `opencode-telegram config` wizard offers `LOG_LOCATION`, and the Docker image sets it to `app` with `ENV LOG_LOCATION=app` in the Dockerfile and `LOG_LOCATION=app` in the Compose `environment` lists (see "Agent calls (confirmed by owner)").
4. `OPENCODE_TELEGRAM_HOME` alone does not move logs; only `LOG_LOCATION=app` does.
5. The daemon output log moves into the log directory and falls under `LOG_RETENTION`.
6. Log file names are renamed to identify the application:
   - Main logs: `opencode-telegram-bot-<date or timestamp>.log`.
   - Service log: `opencode-telegram-bot-service-<timestamp>.log`.
7. If the log directory cannot be created or written, the logger prints one warning to stderr and the bot keeps running.
8. Old locations (`<repo>/logs`, `<appHome>/logs`) are not migrated and not special-cased.
9. On Unix the log directory is mode 0700 and log files are mode 0600.
10. Per-user directories are used because the daemon runs as the invoking user, not as an OS service.
11. `LOG_RETENTION` counts main log files and service log files separately, so each type keeps up to the configured number.
12. On Windows the logger relies on the default ACLs of `%LOCALAPPDATA%` and applies no extra permission handling.
13. If `LOG_LOCATION` holds a value other than `default` or `app`, the logger warns and prompts the user to choose `default` or `app`.
14. When no TTY is available (daemon, Docker, systemd), the logger warns once to stderr and uses `default` instead of prompting.
15. The answer to the invalid-`LOG_LOCATION` prompt is saved to `.env` through the existing config writer, so the CLI and the daemon agree. Any process with a TTY may prompt.
16. The daemon service refuses to start, with an error, if it cannot open its service log. This differs from decision 7: the application logger falls back to stderr, but daemon startup fails when the service log is unwritable. The child's stderr is redirected into the service log, so the child never runs without one. An unwritable service log at daemon startup also serves as a canary for a failed installation.

## Agent calls (confirmed by owner)

- The existing filename patterns stay: daily files in installed mode and per-run files in sources mode, with the new prefix.
- The logger resolves its directory once at startup.
- The logger reads `LOG_LOCATION` from `.env` before the rest of the config loads.
- The main-log and service-log patterns must stay distinct so each retention scan matches only its own files.
- `OPENCODE_TELEGRAM_HOME` and `appHome` resolve first, then `.env` is read for `LOG_LOCATION`. A real environment variable (set by Docker or systemd) takes precedence over `.env`, matching `dotenv` behavior.
- One shared resolver computes the log directory. The CLI process that spawns the daemon resolves it once and passes it to the child through the service child environment, so the CLI, the daemon, and the service log always use the same directory.
- Permissions are enforced on every start: the leaf log directory is set to 0700 and each log file to 0600, including when the directory or files already exist. Directories the logger creates are created with 0700. Parent directories it did not create are left unchanged. The service log file descriptor is opened with mode 0600.
- Fallbacks: on Windows, an unset or empty `%LOCALAPPDATA%` falls back to `<homedir>\AppData\Local`. On Linux, a relative `$XDG_STATE_HOME` is ignored, per the XDG specification.
- Files left in old locations under the old `bot-*` names are never pruned. This follows decision 8. With `LOG_LOCATION=app` they remain in `<appHome>/logs`.
- Builder-found files to change are left to the builder: `config.ts`, `.env.example`, the `config` wizard prompt text and its localized strings, the Dockerfile and compose files.

- The Docker image sets `LOG_LOCATION=app` as `ENV LOG_LOCATION=app` in the Dockerfile plus `LOG_LOCATION=app` in the `environment` list of `docker-compose.yml`, instead of an inserted `.env`. A real environment variable beats `.env` and beats Compose `env_file` values, and a data volume mounted at the app home can shadow an `.env` baked into the image.
- The Windows ACL statement of decision 12 also applies to `LOG_LOCATION=app`: on Windows the logger relies on the default ACLs inherited from the parent directory, which is the app home under `%APPDATA%` (or `OPENCODE_TELEGRAM_HOME`) for `app` and `%LOCALAPPDATA%` for `default`, and applies no extra permission handling.
- Inside a container (`OPENCODE_TELEGRAM_CONTAINER` truthy or `/.dockerenv` present), an unset or `default` `LOG_LOCATION` resolves to `app`, because a real environment variable from `docker run -e` or `--env-file` overrides the image's `ENV`. An explicit `app` and the handed-down service directory are unchanged. One localized warning is written when an explicit `default` is overridden. The Dockerfile sets `OPENCODE_TELEGRAM_CONTAINER=1`.
- `LOG_RETENTION` is looked up in the real environment first, then in the app-home `.env` file, by one helper (`resolveLogRetention`) shared by the logger prunes and the daemon service-log prune. Without it, a `LOG_RETENTION` set only in `.env` never applied, because the logger prunes before the config loads `.env` into the environment and the daemon parent never loads it.

## Open questions

None.

## Test requirements

- Unit tests for per-OS path resolution, `LOG_LOCATION` handling, filename patterns, and retention matching.
- Boundary tests for retention limits and unset or unknown `LOG_LOCATION` values.
- Positive and negative tests for permissions and unusable-directory fallback.
- Integration tests for logger and daemon start writing to the resolved directory.
- End-to-end tests across modes.
