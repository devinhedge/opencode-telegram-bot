# Port Conflict Detection and Auto-Resolution — Design

## Intent and Why

The localhost web service (health server on `127.0.0.1`) uses a configured port that may already be in use by another process. Currently, if the port is busy, the server fails to bind, logs a warning, and the bot continues without the health endpoint. This breaks Docker health checks, orchestrator probes, and local debugging.

We need: detect conflict at startup, automatically find a free port, bind to it, and communicate the actual port to the user.

## Goals

- Detect if configured port is in use before/during bind
- Auto-find an available port (incremental scan or OS-assigned ephemeral)
- Communicate the actual port via logs/stdout
- Graceful failure if no port can be found in range
- Preserve explicit port configuration (don't change user's choice unless forced)
- Work for both health server and any future HTTP services

## Non-Goals

- Port conflict resolution for external services (Telegram, OpenCode API)
- Persisting the auto-selected port across restarts
- Complex port allocation strategies (just sequential scan is fine)

## Constraints

- Node.js `^22.14.0 || ^23.6.0 || >=24`
- Must not break existing explicit port config (`BOT_HEALTH_PORT=3100`)
- Health server runs on `127.0.0.1` only (loopback)
- Container default is 3100, non-container default is 0 (disabled)

## Current Behavior

1. `resolveHealthPort()` in `health-port.ts` returns port from `BOT_HEALTH_PORT` env or default
2. `HealthServer.start(port, version)` in `health-server-service.ts` calls `server.listen(port, HEALTH_HOST)`
3. On `EADDRINUSE`, catches error, logs warning, returns without starting server
4. Bot continues without health endpoint

## Approaches

### Approach 1: Incremental Scan in HealthServer.start() (Recommended)

Modify `HealthServer.start()` to catch `EADDRINUSE` and scan sequentially for the next available port.

```typescript
async start(preferredPort: number, version: string): Promise<number> {
  let port = preferredPort;
  const maxAttempts = 100;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await this.tryListen(port);
      this.actualPort = port;
      logger.info(`[Health] Listening on ${HEALTH_HOST}:${port} (requested: ${preferredPort})`);
      return port;
    } catch (error) {
      if (isEADDRINUSE(error) && port < 65535) {
        port++;
        continue;
      }
      throw error;
    }
  }
  throw new Error(`No available port found after ${maxAttempts} attempts`);
}
```

**Trade-offs:**
- Simple, self-contained in HealthServer
- Returns actual port to caller (caller can log/notify)
- Max 100 attempts prevents infinite loop
- Minimal code change (~30 lines)

### Approach 2: OS-Assigned Ephemeral Port (Port 0)

Let the OS pick a free port by passing `0` to `listen()`, then read the assigned port from `server.address()`.

```typescript
async start(preferredPort: number, version: string): Promise<number> {
  const port = preferredPort === 0 ? 0 : preferredPort; // 0 = OS picks
  await this.tryListen(port);
  this.actualPort = this.server?.address()?.port ?? preferredPort;
  return this.actualPort;
}
```

**Trade-offs:**
- Simplest code (no retry loop)
- But: ignores user's explicit port preference (always random if 0)
- Need to handle case where user explicitly set `BOT_HEALTH_PORT=3100` — they expect 3100, not random
- Would need config flag to enable "auto port" mode

### Approach 3: Centralized Port Resolver Service

Create a `PortResolver` service that handles all port allocation for the app, with configurable strategies.

```typescript
interface PortResolver {
  resolve(preferred: number, options?: { maxAttempts?: number }): Promise<number>;
  release(port: number): void;
}
```

**Trade-offs:**
- More flexible for future HTTP services
- Over-engineering for current single health server
- Adds abstraction layer not yet needed

---

## Recommendation

**Approach 1 (Incremental Scan in HealthServer.start())** — minimal, focused, preserves user intent, communicates actual port. The scan only triggers on conflict, so zero overhead when port is free.

## Open Questions

1. **Max attempts?** 100 seems reasonable (covers 3100-3199). Make configurable?
2. **Should we also scan DOWNWARDS?** (e.g., if 3100 busy, try 3099, 3098...) — No, upward is standard.
3. **Return actual port to caller?** Yes — `start()` becomes `Promise<number>` returning actual port.
4. **Log both requested and actual?** Yes — `Listening on 127.0.0.1:3101 (requested: 3100)`
5. **Config flag to disable auto-scan?** Add `BOT_HEALTH_PORT_AUTO=0` to disable and fail hard on conflict.

---

*Pending approval.*