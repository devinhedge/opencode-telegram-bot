# Graceful Restart — Design

## Intent and Why

When the bot is already running and the user invokes `opencode-telegram`, it should do nothing (not start a second instance). When invoked with `--restart`, it should gracefully drain in-flight work, persist queued messages, stop, and start a fresh instance — with no message loss.

## Goals

- `opencode-telegram` (no args): if already running, print "already running" and exit 0
- `opencode-telegram --restart`: gracefully stop the running instance, then start a new one
- Grace period: wait up to 60 seconds for in-flight operations to finish before force-exiting
- Queued messages (prompt queue + inbox) are persisted to disk before shutdown and restored on startup
- Works in both daemon and foreground modes
- Restart events logged to stdout and log file

## Non-Goals

- Hot-reload without process restart
- Preserving in-flight (actively processing) messages across restart
- Cross-platform signal handling beyond SIGTERM/SIGINT

## Constraints

- Node.js `^22.14.0 || ^23.6.0 || >=24`
- Queue is currently in-memory only; persistence is new
- Must not break existing `--daemon` behavior
- Foreground mode: Ctrl+C still works; `--restart` in foreground stops the current process and starts a new one
- Grace period configurable via `RESTART_GRACE_PERIOD_SEC` env var (default: 60)

## Approach: Signal-based graceful restart

### CLI (`--restart` flag)

1. Parse `--restart` from CLI args
2. Check if bot is running via `getBotServiceStatus()`
3. If running:
   a. Send `SIGTERM` to the process
   b. Poll for exit (up to 60s)
   c. If still alive after 60s, send `SIGKILL`
   d. Wait for exit
4. If not running: proceed normally
5. Start new instance (daemon or foreground, matching original mode)

### Daemon mode

- `--restart` with `--daemon`: stop daemon, wait, start new daemon
- Logs to stdout and log file

### Foreground mode

- `--restart` without `--daemon`: if a foreground bot is running (check PID file or process), stop it, then start new foreground bot
- If no foreground bot running, just start normally

### Graceful shutdown in the bot process

When `SIGTERM`/`SIGINT` is received and `restarting` flag is set:
1. Set `restarting = true`
2. Stop accepting new Telegram messages (pause polling)
3. Wait for in-flight operations (up to 60s):
   - Current OpenCode session processing
   - Current prompt delivery
   - Current command execution
4. Persist queued messages to `restart-queue.json` in `run/` dir
5. Flush settings and logs
6. Exit 0

### Queue persistence

**Before shutdown:**
- Serialize `promptQueue.list()` to `restart-queue.json`
- Include session context (directory, session ID) if available

**On startup:**
- Check for `restart-queue.json` in `run/` dir
- If found, load queued messages back into `promptQueue`
- Delete the file after successful restore
- If file is corrupt/invalid, log warning and skip

### Restart state file

Location: `<appHome>/run/restart-queue.json`
```json
{
  "version": 1,
  "savedAt": "2026-11-11T...",
  "sessionDirectory": "/path/to/project",
  "sessionId": "ses_...",
  "queuedPrompts": [ ... ],
  "inboxPrompts": [ ... ]
}
```

### Logging

- `[App] Restart requested, draining in-flight work...`
- `[App] Waiting for N in-flight operations (Xs remaining)...`
- `[App] Persisted M queued messages to restart-queue.json`
- `[App] Graceful restart complete, exiting`
- `[App] New instance started (PID=...)`

## What's Left to the Builder

- Test strategy for signal handling and queue persistence

## Test Plan

### Test Categories

- **Unit**: RestartCoordinator (track/untrack/drain/idempotency), restart-queue-store (save/load/clear/round-trip/corrupt variants), args parser (--restart flag)
- **Boundary**: Grace period 0, empty queue, duplicate ids, unknown-id untrack, corrupt JSON variants, file IO errors
- **Positive**: Happy path drain, round-trip serialization, startup restore, CLI daemon restart
- **Negative**: SIGTERM without restart flag (normal exit 0), force-kill after timeout, concurrent restart, corrupt file handling, missing file
- **Integration**: Shutdown persists queue only when restarting; startup restores before polling; CLI orchestration ordering
- **E2E**: Manual verification (process lifecycle makes automation flaky): foreground restart, daemon restart, plain invocation while running

### Test File Locations

- `tests/app/services/restart-coordinator.test.ts` (new)
- `tests/app/services/restart-queue-store.test.ts` (new)
- `tests/cli/args.test.ts` (extend)
- `tests/cli/cli.test.ts` (new — does not exist yet)
- `tests/app/start-bot-app.test.ts` (extend — SIGTERM/restart scenarios)
- `tests/config.test.ts` (extend — RESTART_GRACE_PERIOD_SEC env var)

## Resolved Design Decisions

1. **SIGTERM without restart flag**: Normal shutdown, exit 0 (consistent with current behavior). The `restarting` flag only controls queue persistence + log wording.
2. **In-flight tracking**: Set-based with unique operation IDs. `untrack` is a no-op for unknown IDs. Count = set size.
3. **Foreground restart**: Stop+start (send SIGTERM to existing process, wait for exit, then spawn new). Not self-restart via exec.
---
*Pending approval.*