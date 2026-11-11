# Port Conflict Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect port conflicts at startup for the health server, auto-scan up to 10 ports for a free one, return the actual bound port, and support `BOT_HEALTH_PORT_AUTO=0` to disable auto-scan.

**Architecture:** Modify `HealthServer.start()` to catch `EADDRINUSE`, scan sequentially up to 10 ports, return actual bound port as `Promise<number>`. Update `resolveHealthPort()` to read `BOT_HEALTH_PORT_AUTO` env var. Caller (`startBotApp`) logs both requested and actual port.

**Tech Stack:** TypeScript, Node.js `net` module for port checking, existing `HealthServer` class.

**Spec:** `docs/superpowers/specs/2026-11-10-port-conflict-detection-design.md`

## Global Constraints

- Node.js `^22.14.0 || ^23.6.0 || >=24`
- Max scan attempts: 10 (user decision)
- `BOT_HEALTH_PORT_AUTO=0` disables auto-scan, fails hard on conflict (user decision)
- `HealthServer.start()` returns `Promise<number>` — actual bound port (user decision)
- Loopback only (`127.0.0.1`)
- Preserve existing explicit port config (`BOT_HEALTH_PORT`)

## Review Focus

- Auto-scan must not loop infinitely; max 10 attempts enforced
- `BOT_HEALTH_PORT_AUTO=0` must fail fast with clear error (no silent fallback)
- Actual port returned and logged by caller (both requested and actual)
- Health check probe (`runHealthcheck`) must use the same resolved port
- Container default (3100) still applies when env not set

---

### Task 1: Update `resolveHealthPort()` to Read `BOT_HEALTH_PORT_AUTO`

**Files:**
- Modify: `src/runtime/health-port.ts`
- Test: `tests/runtime/health-port.test.ts` (extend existing)

**Interfaces:**
- Produces: `resolveHealthPort(rawValue, inContainer, autoScanEnabled)` → `number` (0 = disabled, >0 = port)

- [ ] **Step 1: Write the failing test** — `autoScanEnabled=false` returns port as-is; `autoScanEnabled=true` returns port as-is (scan logic is in HealthServer)

```typescript
it("respects BOT_HEALTH_PORT_AUTO=0 by returning port without auto-scan flag", () => {
  const port = resolveHealthPort("3100", false, false);
  expect(port).toBe(3100);
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — add optional `autoScanEnabled` parameter to `resolveHealthPort()`; update callers
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 2: Modify `HealthServer.start()` to Auto-Scan and Return Actual Port

**Files:**
- Modify: `src/app/services/health-server-service.ts`
- Test: `tests/app/services/health-server-service.test.ts` (extend existing)

**Interfaces:**
- Consumes: `port` (number, preferred)
- Produces: `Promise<number>` — actual bound port

- [ ] **Step 1: Write the failing test** — `start(3100)` returns 3101 when 3100 is busy (mock `server.listen` to reject once with `EADDRINUSE`); returns actual port; logs requested vs actual

```typescript
it("scans to next port when preferred is in use and returns actual", async () => {
  // mock listen to reject once with EADDRINUSE, then succeed on next port
  const actual = await healthServer.start(3100, "test");
  expect(actual).toBe(3101);
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — change `start(port, version): Promise<void>` to `start(port, version): Promise<number>`; add scan loop (max 10); catch `EADDRINUSE`; log `Listening on 127.0.0.1:${actual} (requested: ${preferred})`; return actual port
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: Add `BOT_HEALTH_PORT_AUTO` Env Var and Wire Through Config

**Files:**
- Modify: `src/config.ts` (add `BOT_HEALTH_PORT_AUTO` parsing)
- Modify: `src/runtime/health-port.ts` (update `resolveHealthPort` signature and call site in `config.ts`)
- Test: `tests/config.test.ts` (extend)

**Interfaces:**
- Produces: `config.health.autoScanEnabled` (boolean, default true)

- [ ] **Step 1: Write the failing test** — `BOT_HEALTH_PORT_AUTO=0` sets `autoScanEnabled=false`; default is `true`
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — add `getOptionalBooleanEnvVar("BOT_HEALTH_PORT_AUTO", true)` to config health section; pass to `resolveHealthPort`
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 4: Wire Auto-Scan Flag into `HealthServer.start()` Call

**Files:**
- Modify: `src/app/services/health-server-service.ts` (add `autoScanEnabled` parameter to `start()`)
- Modify: `src/app/bootstrap/start-bot-app.ts` (pass `config.health.autoScanEnabled` to `healthServer.start()`)
- Test: `tests/app/bootstrap/start-bot-app.test.ts` (extend mock)

**Interfaces:**
- `HealthServer.start(port, version, autoScanEnabled): Promise<number>`
- Caller logs: `Health server listening on ${actualPort} (requested: ${preferredPort})`

- [ ] **Step 1: Write the failing test** — mock `healthServer.start` receives `autoScanEnabled`; caller logs both ports
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — add `autoScanEnabled` param to `start()`; if `false`, skip scan and throw on `EADDRINUSE`; update call in `startBotApp`
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 5: Update Health Check Probe to Use Actual Port

**Files:**
- Modify: `src/runtime/healthcheck.ts` — ensure `runHealthcheck()` uses same port resolution (already does via `resolveHealthPort`)
- Test: `tests/runtime/healthcheck.test.ts` (verify probe works with auto-selected port)

**Interfaces:**
- `runHealthcheck()` probes the port returned by `resolveHealthPort()` (no change needed if already correct)

- [ ] **Step 1: Verify existing test covers this** — health check uses resolved port
- [ ] **Step 2: Add test if gap** — probe succeeds when auto-scan selected different port
- [ ] **Step 3: Commit**

---

### Task 6: Update `.env.example` and Documentation

**Files:**
- Modify: `.env.example` — add `BOT_HEALTH_PORT_AUTO` comment
- Modify: `README.md` — document auto-scan feature
- Commit

- [ ] **Step 1: Update `.env.example`** — add `BOT_HEALTH_PORT_AUTO=1` (default) with comment
- [ ] **Step 2: Update `README.md`** — health check section: auto-scan behavior, `BOT_HEALTH_PORT_AUTO=0` to disable
- [ ] **Step 3: Commit**

---

**Plan complete and saved.** Please review. Which execution approach would you prefer?

- **Subagent-driven** — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Native**, because tasks are tightly coupled (each modifies `HealthServer.start()` signature and call chain) and a single implementer can maintain consistency across the call chain. Does the plan capture what you want, and which approach should we use?