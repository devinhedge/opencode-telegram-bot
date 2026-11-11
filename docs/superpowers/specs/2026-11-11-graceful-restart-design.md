# Graceful Restart — start-bot-app.ts Changes — Design Update

## Additional Changes Needed

The graceful restart feature requires changes to `start-bot-app.ts` to:

1. **Detect restart mode** — via `RESTARTING=1` env var set by CLI `--restart`
2. **Graceful shutdown with drain** — on SIGTERM/SIGINT when restarting, wait up to 60s for in-flight operations
3. **Persist queue before exit** — serialize `promptQueue.list()` + inbox prompts to `restart-queue.json`
4. **Restore queue on startup** — load from file, restore to promptQueue, delete file
5. **In-flight tracking** — track active operations (OpenCode session processing, prompt delivery, command execution)

## Restart Mode Detection

The CLI sets `RESTARTING=1` in the child process environment when `--restart` is used. `startBotApp()` checks this env var to enable graceful restart behavior.

## In-Flight Tracking

A simple counter (`inFlightCount`) incremented/decremented around async operations:
- `notifyOpencodeReadyIfHealthy` → increment
- `bot.start()` message processing → increment per message
- `scheduledTaskRuntime` operations → increment

When `restarting=true` and `inFlightCount === 0`, proceed to persist + exit.

## Graceful Shutdown Flow (when restarting)

1. Set `restarting = true`
2. Stop accepting new Telegram messages (pause polling via `bot.stop()`)
3. Wait for `inFlightCount` to reach 0 (up to `RESTART_GRACE_PERIOD_SEC` seconds)
4. Persist queue: `saveRestartQueue({ queuedPrompts: promptQueue.list(), inboxPrompts: [...] })`
5. Flush settings and logs
6. Exit 0

## Normal Shutdown Flow (when not restarting)

Same as before (exit 0 after cleanup).

## Queue Restoration on Startup

1. After bot starts and `loadConfig()` completes, check for `restart-queue.json`
2. If found, parse and validate
3. Restore queued prompts: `promptQueue.add()` for each
4. Restore inbox prompts: `promptQueue.confirmReservation()` for each
5. Delete `restart-queue.json`
6. Log: `[App] Restored N queued messages from previous restart`

## Restart State File

Location: `<appHome>/run/restart-queue.json`

```json
{
  "version": 1,
  "savedAt": "2026-11-11T...",
  "sessionDirectory": "/path/to/project",
  "sessionId": "ses_...",
  "queuedPrompts": [...],
  "inboxPrompts": [...]
}
```

## Test Plan

### Unit Tests
- `RestartCoordinator`: track/untrack/drain/idempotency/duplicate handling
- `RestartQueueStore`: save/load/clear/round-trip/corrupt variants/missing file
- `args.ts`: --restart flag parsing (already done)

### Boundary Tests
- Grace period 0 → immediate force-exit
- Empty queue → save writes valid file with empty arrays
- Single in-flight never resolves → timeout at exactly graceMs (fake timers)
- Duplicate track ids → count semantics
- Corrupt JSON variants (empty, truncated, wrong version, missing fields)
- File IO errors on save → log and continue

### Positive Tests
- Drain resolves when count → 0 before timeout
- Save → load round-trips all QueuedPrompt fields including inbox
- Startup restore + file deletion
- CLI daemon restart: stop → wait → start

### Negative Tests
- SIGTERM without restart flag → normal shutdown, exit 0
- Force-kill after timeout (SIGKILL sent)
- Concurrent restart → second waits or fails gracefully
- Restore failure (corrupt file) → log warning, skip, delete file
- Missing file on startup → no-op

### Integration Tests
- Shutdown persists queue only when restarting flag set
- Startup restores queue before polling starts
- CLI orchestration: startBotDaemon not called until stopBotDaemon resolves

### E2E Tests (Manual)
- Foreground restart: start, send --restart, verify exit 0 and queue restored
- Daemon restart: daemon → restart → new PID, old gone
- Plain invocation while running → "already running", exit 0

## What's Left to the Builder

- Exact in-flight tracking integration points (which operations to track)
- Whether to persist inbox prompts or just local queue
- Test strategy for signal handling (process signal simulation in tests)