# Graceful Restart — start-bot-app.ts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement graceful restart signal handling in `start-bot-app.ts`: detect restart mode via env var, drain in-flight operations, persist queued messages to disk, and restore them on startup.

**Architecture:** Signal-based graceful restart. CLI sets `RESTARTING=1` env var. Bot process detects it, tracks in-flight operations, on SIGTERM drains (up to 60s), persists queue to `restart-queue.json`, exits 0. On startup, restores queue from file then deletes it.

**Tech Stack:** TypeScript, Node.js `process` signals, JSON file persistence, existing `promptQueue` singleton.

**Spec:** `docs/superpowers/specs/2026-11-11-graceful-restart-design.md`

## Global Constraints

- Node.js `^22.14.0 || ^23.6.0 || >=24`
- Grace period: `RESTART_GRACE_PERIOD_SEC` env var (default 60)
- Queue persistence: JSON file in `run/` dir, deleted after restore
- Persist both prompt queue AND inbox prompts (V2 session inbox)
- Log restart events to stdout and log file
- SIGTERM without restart flag → normal shutdown, exit 0

## Review Focus

- Race condition: new instance starts before old one fully exits
- Queue serialization must handle all QueuedPrompt fields (including inbox)
- Grace period timeout must force-exit, not hang indefinitely
- Restart state file must be cleaned up after successful restore
- In-flight tracking must be accurate (no double-count or missed untrack)

---

### Task 1: Restart State Store (Save/Restore/Delete)

**Files:**
- Create: `src/app/services/restart-queue-store.ts`
- Test: `tests/app/services/restart-queue-store.test.ts`

**Interfaces:**
- Produces: `RestartQueueState` interface; `saveRestartQueue(state, filePath)` → writes JSON; `loadRestartQueue(filePath)` → reads + validates + deletes; `clearRestartQueue(filePath)` → deletes file

- [ ] **Step 1: Write the failing test** — round-trip save/load with all QueuedPrompt fields (including inbox); file deleted after load; corrupt file returns null; missing file returns null; clear deletes file

```typescript
it("round-trips queued prompts including inbox", async () => {
  const state = { version: 1, savedAt: new Date().toISOString(), queuedPrompts: [...], inboxPrompts: [...] };
  await saveRestartQueue(state, filePath);
  const loaded = await loadRestartQueue(filePath);
  expect(loaded).toEqual(state);
  // file should be deleted
  await expect(fs.access(filePath)).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** `restart-queue-store.ts` with atomic write (temp + rename), validation, and cleanup
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 2: In-Flight Operation Tracker

**Files:**
- Create: `src/app/services/restart-coordinator.ts`
- Test: `tests/app/services/restart-coordinator.test.ts`

**Interfaces:**
- Produces: `RestartCoordinator` class with `requestRestart()`, `isRestarting()`, `track(id)`, `untrack(id)`, `getInFlightCount()`, `waitForDrain(graceMs)` → Promise<boolean>

- [ ] **Step 1: Write the failing test** — track/untrack updates count; `waitForDrain` resolves true when count 0; times out (returns false) after graceMs with fake timers; duplicate track is no-op; untrack unknown id is no-op

```typescript
it("waitForDrain resolves true when in-flight count reaches 0", async () => {
  const coord = new RestartCoordinator();
  coord.track("op-1");
  const drainPromise = coord.waitForDrain(5000);
  coord.untrack("op-1");
  const result = await drainPromise;
  expect(result).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** `RestartCoordinator` with Set-based tracking
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: Graceful Shutdown with Drain + Persist

**Files:**
- Modify: `src/app/bootstrap/start-bot-app.ts` (shutdown handler, signal registration)
- Test: `tests/app/start-bot-app.test.ts` (extend)

**Interfaces:**
- Consumes: `RestartCoordinator`, `restart-queue-store`, `promptQueue`
- Produces: `shutdown(signal, isRestarting)` → drains, persists if restarting, exits 0

- [ ] **Step 1: Write the failing test** — SIGTERM with `RESTARTING=1` env: persists queue, logs restart messages, exits 0; SIGTERM without flag: normal shutdown, no queue file written

```typescript
it("persists queue and exits 0 on SIGTERM when restarting", async () => {
  process.env.RESTARTING = "1";
  // mock promptQueue.list() to return items
  // trigger SIGTERM
  // assert saveRestartQueue called, process.exit(0) called
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — modify shutdown handler: check `isRestarting`, drain via `waitForDrain(graceMs)`, persist queue if restarting, flush, exit 0
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 4: Restore Queue on Startup

**Files:**
- Modify: `src/app/bootstrap/start-bot-app.ts` (after bot start)
- Test: `tests/app/start-bot-app.test.ts` (extend)

**Interfaces:**
- Consumes: `restart-queue-store`, `promptQueue`
- Produces: on startup, if `restart-queue.json` exists, restore queued prompts + inbox prompts, then delete file

- [ ] **Step 1: Write the failing test** — startup with existing `restart-queue.json` restores queue (verify `promptQueue.list()` populated); file deleted after restore; corrupt file logged as warning, skipped
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — after `bot.start()`, check for restart-queue.json, restore, delete
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 5: In-Flight Tracking Integration

**Files:**
- Modify: `src/app/bootstrap/start-bot-app.ts` (wrap async operations)
- Test: `tests/app/start-bot-app.test.ts` (extend)

**Interfaces:**
- Consumes: `RestartCoordinator`
- Produces: `inFlightCount` tracked around bot message processing, scheduled tasks, auto-restart

- [ ] **Step 1: Write the failing test** — in-flight count increments during message processing; decrements on completion; `waitForDrain` used in shutdown
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — wrap key async operations with `track`/`untrack`
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 6: Update `.env.example` and README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Update `.env.example`** — add `RESTART_GRACE_PERIOD_SEC=60`
- [ ] **Step 2: Update `README.md`** — document graceful restart behavior
- [ ] **Step 3: Commit**

---

**Plan complete and saved.** Please review. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Native**, because tasks are tightly coupled (all modify `start-bot-app.ts`) and a single implementer maintains consistency. Does the plan capture what you want, and which approach should we use?