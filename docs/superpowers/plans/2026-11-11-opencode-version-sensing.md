# OpenCode Version Sensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect installed OpenCode version at bootstrap, always override `OPENCODE_SERVER_VERSION` config with detected value, and persist to `.env`.

**Architecture:** At `loadConfig()` startup, call `readLocalOpencodeVersion()` and `getOpencodeApiVersion()` to detect the version. Always override `opencodeServerVersion`. Persist detected version to `.env` via atomic write. Fall back to `.env` value (or v1) when opencode not installed.

**Tech Stack:** TypeScript, Node.js `child_process` (already used in `process.ts`), `dotenv` for `.env` parsing.

**Spec:** `docs/superpowers/specs/2026-11-11-opencode-version-sensing-design.md`

## Global Constraints

- Node.js `^22.14.0 || ^23.6.0 || >=24`
- Detection must complete before config is consumed
- Fall back gracefully when opencode not installed
- Persist detected version to `.env` atomically
- Never log secret values

## Review Focus

- `opencodeServerVersion` must be mutable (let, not const) so detection can override
- Detection runs inside `loadConfig()` before config is consumed by consumers
- `.env` persistence must not corrupt the file or lose non-secret values
- Fallback when `readLocalOpencodeVersion()` returns null (opencode not installed)
- Log both detected version and any change from previous config

---

### Task 1: Make `opencodeServerVersion` Mutable and Add Detection Function

**Files:**
- Modify: `src/config.ts` (lines 263-264)

**Interfaces:**
- Produces: `detectOpencodeVersion()` → `Promise<OpencodeServerVersion>`; `opencodeServerVersion` becomes `let`

- [ ] **Step 1: Write the failing test** — `tests/config.test.ts`: mock `readLocalOpencodeVersion` to return "2.2.7", verify `loadConfig()` returns v2; mock to return null, verify fallback to .env value

```typescript
it("auto-detects v2 when opencode 2.x is installed", async () => {
  vi.doMock("../src/opencode/process.js", () => ({
    readLocalOpencodeVersion: vi.fn(async () => "2.2.7"),
    getOpencodeApiVersion: (v: string) => (parseInt(v) >= 2 ? "v2" : "v1"),
  }));
  const config = await loadConfig();
  expect(config.opencode.serverVersion).toBe("v2");
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — change `const` to `let`, add `detectOpencodeVersion()` function
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 2: Persist Detected Version to `.env`

**Files:**
- Modify: `src/config.ts` (add `persistOpencodeVersion()` helper)
- Test: `tests/config.test.ts` (extend)

**Interfaces:**
- Produces: `persistOpencodeVersion(version)` → `Promise<void>`; atomically updates `OPENCODE_SERVER_VERSION` in `.env`

- [ ] **Step 1: Write the failing test** — after detection, `.env` contains `OPENCODE_SERVER_VERSION=v2`
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — atomic `.env` rewrite preserving other values
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: Wire Detection into `loadConfig()`

**Files:**
- Modify: `src/config.ts` (`loadConfig()` function)
- Test: `tests/config.test.ts` (extend)

**Interfaces:**
- Consumes: `detectOpencodeVersion()`, `persistOpencodeVersion()`
- Produces: `loadConfig()` calls detection before returning config

- [ ] **Step 1: Write the failing test** — `loadConfig()` returns detected version; logs change when different from .env
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — call detection at start of `loadConfig()`, persist, log
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 4: Update `.env.example` and README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Update `.env.example`** — add note that `OPENCODE_SERVER_VERSION` is auto-detected
- [ ] **Step 2: Update `README.md`** — document auto-detection behavior
- [ ] **Step 3: Commit**

---

**Plan complete and saved.** Please review. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Native**, because tasks are tightly coupled (all modify `config.ts`) and a single implementer maintains consistency. Does the plan capture what you want, and which approach should we use?