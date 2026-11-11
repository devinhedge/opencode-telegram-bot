# OpenCode Version Sensing — Design

## Intent and Why

The bot currently relies on the user manually setting `OPENCODE_SERVER_VERSION` (v1 or v2) in `.env` or via the wizard. If the installed OpenCode version doesn't match the configured value, the bot crashes at runtime with a version mismatch error. This feature auto-detects the installed OpenCode version at bootstrap and always overrides the config, so the bot self-corrects.

## Goals

- Auto-detect installed OpenCode version at startup (via `opencode --version`)
- Always override `OPENCODE_SERVER_VERSION` config with detected value
- Persist detected version to `.env` for next run
- Log the detected version and any change from previous config
- Graceful fallback to `.env` value (or v1) when opencode is not installed

## Non-Goals

- Changing the wizard flow (it can still ask, but bootstrap overrides)
- Supporting multiple opencode installations
- Caching the version across restarts (always re-detect)

## Constraints

- Detection must complete before config is consumed by other modules
- Must not block startup if opencode is not installed (fall back gracefully)
- Must persist to `.env` so the value is available to other tools (healthcheck, etc.)
- Must work in both interactive and daemon modes

## Approach

### Detection

At the start of `loadConfig()`, call `readLocalOpencodeVersion()` to get the version string. If available, map to v1/v2 via `getOpencodeApiVersion()`. Override `config.opencode.serverVersion` with the detected value.

### Persistence

After detection, update `OPENCODE_SERVER_VERSION` in `.env` (atomic write) so the value is available to:
- Health check probe (`runHealthcheck` reads `.env` directly)
- Other external tools
- Next run (instant, no re-detect needed but re-detect anyway for safety)

### Fallback

If `readLocalOpencodeVersion()` returns null (opencode not installed or not executable):
- Use `.env` value if present
- Default to v1

### Logging

- Log detected version: `[Config] Detected OpenCode v2.2.7 (API v2)`
- If different from `.env`: `[Config] OpenCode version changed: v1 → v2 (auto-corrected)`
- If not found: `[Config] Could not detect OpenCode version; using .env value (v1)`

## Implementation

### Changes to `config.ts`

1. Make `opencodeServerVersion` mutable (let instead of const)
2. Add async `detectAndSetOpencodeVersion()` called within `loadConfig()`
3. Persist detected version to `.env`
4. Export `opencodeServerVersion` (already exported)

### Changes to `process.ts`

- `readLocalOpencodeVersion()` already exists; no changes needed
- `getOpencodeApiVersion()` already exists; no changes needed

### Changes to `bootstrap.ts`

- No changes needed (wizard still asks, but bootstrap overrides)

### Changes to `.env.example`

- Add note that `OPENCODE_SERVER_VERSION` is auto-detected

## What's Left to the Builder

- Exact persistence mechanism (atomic .env rewrite vs. simple update)
- Whether to also update `OPENCODE_API_URL` defaults based on detected version
- Test strategy for mocking `readLocalOpencodeVersion()`
---
*Pending approval.*