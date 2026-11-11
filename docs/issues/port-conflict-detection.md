# Issue: Port Conflict Detection and Auto-Resolution for Localhost Web Service

## Problem

The localhost web service (dashboard/health endpoint) uses a fixed port that may conflict with other services running on the same machine. Currently there's no detection or automatic resolution when the configured port is already in use.

## Feature Request

At runtime, when starting the web service:
1. **Detect** if the configured port is already in use
2. **Automatically find** an available port (scan incrementally or use OS-assigned ephemeral port)
3. **Update** the service to bind to the available port
4. **Log/notify** the user of the actual port being used (especially important for dashboard access)

## Acceptance Criteria

- [ ] Service startup fails gracefully with clear error if port detection fails
- [ ] Auto-selection works for both dashboard port and health check port
- [ ] Selected port is communicated to user (stdout/logs)
- [ ] Works in both interactive and daemon modes
- [ ] Configurable port range for auto-selection (optional)
- [ ] Does not break existing explicit port configuration

## Related Components

- `src/runtime/health-port.ts` - port resolution logic
- `src/dashboard/server.ts` - dashboard web server
- `src/runtime/healthcheck.ts` - health endpoint
- `src/app/bootstrap/start-bot-app.ts` - service startup