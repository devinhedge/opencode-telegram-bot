# Graceful Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--restart` flag to CLI that gracefully drains in-flight work, persists queued messages, and starts a fresh instance. Plain `opencode-telegram` with no args does nothing if already running.

**Architecture:** Signal-based graceful restart. CLI sends SIGTERM to running daemon, waits for exit (60s grace), then starts new instance. Daemon saves queued messages to `restart-queue.json` before exit. New daemon restores queue on startup. Foreground mode: self-restart via process replacement.

**Tech Stack:** TypeScript, Node.js `process` signals, JSON file persistence, existing service manager.

**Spec:** `docs/superpowers/specs/2026-11-11-graceful-restart-design.md`

## Global Constraints

- Node.js `^22.14.0 || ^23.6.0 || >=24`
- Grace period: configurable via `RESTART_GRACE_PERIOD_SEC` env var (default 60)
- Queue persistence: JSON file in `run/` dir, deleted after restore
- Persist both prompt queue AND inbox prompts (V2 session inbox)
- Log restart events to stdout and log file
- Works in daemon and foreground modes

## Review Focus

- Race condition: new instance starts before old one fully exits → port/process conflict
- Queue serialization must handle all QueuedPrompt fields (including inbox)
- Grace period timeout must force-exit, not hang indefinitely
- Restart state file must be cleaned up after successful restore (no stale state)
- Foreground restart must not lose the terminal session

---

### Task 1: Add `--restart` CLI Flag and Already-Running Check

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/cli.ts`
- Test: `tests/cli/args.test.ts` (extend)

**Interfaces:**
- Produces: `--restart` boolean flag in parsed args; `runStartCommand` checks if already running and exits 0 if so

- [ ] **Step 1: Write the failing test** — parse `--restart` flag; `opencode-telegram` (no args) with running daemon prints "already running" and exits 0
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — add `--restart` to args parser; in `runStartCommand`, check `getBotServiceStatus()`; if running and no `--restart`, print already running and exit 0
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 2: Grace Period Env Var and In-Flight Tracking

**Files:**
- Modify: `src/config.ts` (add `RESTART_GRACE_PERIOD_SEC`)
- Create: `src/app/services/restart-coordinator.ts`
- Test: `tests/app/services/restart-coordinator.test.ts`

**Interfaces:**
- Produces: `RestartCoordinator` class with `requestRestart()`, `isRestarting()`, `trackOperation(id)`, `untrackOperation(id)`, `getInFlightCount()`, `waitForDrain(graceMs)`
- Consumes: `config.restart.gracePeriodSec`

- [ ] **Step 1: Write the failing test** — track/untrack operations; `waitForDrain` resolves when count reaches 0; times out after grace period
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** `RestartCoordinator`
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: Queue Persistence (Save/Restore)

**Files:**
- Create: `src/app/services/restart-queue-store.ts`
- Test: `tests/app/services/restart-queue-store.test.ts`

**Interfaces:**
- Produces: `saveRestartQueue(state)` → writes `restart-queue.json`; `loadRestartQueue()` → reads and deletes; `clearRestartQueue()`

- [ ] **Step 1: Write the failing test** — save queue, load returns same data, file deleted after load; corrupt file handled gracefully
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** save/load/clear with atomic writes
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 4: Graceful Shutdown in Bot Process

**Files:**
- Modify: `src/app/bootstrap/start-bot-app.ts` (shutdown handler)
- Test: `tests/app/start-bot-app.test.ts` (extend)

**Interfaces:**
- Consumes: `RestartCoordinator`, `restart-queue-store`
- Produces: `SIGTERM`/`SIGINT` handler checks `restarting` flag; drains in-flight; persists queue; exits 0

- [ ] **Step 1: Write the failing test** — SIGTERM with `restarting=true` persists queue and exits 0; SIGTERM without flag exits 1 (or normal)
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** graceful shutdown with drain + persist
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 5: Restore Queue on Startup

**Files:**
- Modify: `src/app/bootstrap/start-bot-app.ts` (after bot start)
- Test: `tests/app/start-bot-app.test.ts` (extend)

**Interfaces:**
- Consumes: `restart-queue-store`
- Produces: on startup, if `restart-queue.json` exists, restore queued prompts and inbox prompts, then delete file

- [ ] **Step 1: Write the failing test** — startup with existing `restart-queue.json` restores queue; file deleted after restore
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** restore on startup
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 6: CLI `--restart` Orchestration

**Files:**
- Modify: `src/cli.ts` (add `--restart` handling)
- Modify: `src/cli/args.ts` (add `--restart` flag parsing)
- Test: `tests/cli/args.test.ts` (extend), create `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `getBotServiceStatus()`, `stopBotDaemon()`, `startBotDaemon()`
- Produces: `--restart` flow: stop → wait → start

- [ ] **Step 1: Write the failing test** — `--restart` with running daemon stops and starts; `--restart` with no running daemon just starts; `--restart` on non-start commands is rejected; `--restart --daemon` combination works
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** restart orchestration
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 7: Foreground Mode Restart

**Files:**
- Modify: `src/cli.ts` (foreground `--restart` handling)
- Test: `tests/cli/cli.test.ts` (extend)

**Interfaces:**
- Produces: foreground `--restart` stops current process via SIGTERM, waits, starts new foreground instance

- [ ] **Step 1: Write the failing test** — foreground `--restart` sends SIGTERM to existing process, waits, starts new; plain invocation while running exits 0 without starting
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** foreground restart (stop+start, not exec replacement)
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 8: Update `.env.example` and README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Update `.env.example`** — add `RESTART_GRACE_PERIOD_SEC=60`
- [ ] **Step 2: Update `README.md`** — document `--restart` flag and grace period
- [ ] **Step 3: Commit**

---

**Plan complete and saved.** Please review. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Subagent-driven**, because tasks have clear interface contracts between them and a shipped mistake in restart logic could lose queued messages. Does the plan capture what you want, and which approach should we use?