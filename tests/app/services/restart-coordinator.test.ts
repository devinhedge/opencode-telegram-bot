import { describe, expect, it, vi } from "vitest";
import { RestartCoordinator } from "../../../src/app/services/restart-coordinator.js";

describe("RestartCoordinator", () => {
  it("tracks and untracks operations", () => {
    const coord = new RestartCoordinator();
    coord.track("op-1");
    expect(coord.getInFlightCount()).toBe(1);
    coord.untrack("op-1");
    expect(coord.getInFlightCount()).toBe(0);
  });

  it("untrack is no-op for unknown id", () => {
    const coord = new RestartCoordinator();
    coord.track("op-1");
    coord.untrack("op-unknown");
    expect(coord.getInFlightCount()).toBe(1);
  });

  it("duplicate track is no-op", () => {
    const coord = new RestartCoordinator();
    coord.track("op-1");
    coord.track("op-1");
    expect(coord.getInFlightCount()).toBe(1);
  });

  it("requestRestart sets isRestarting to true", () => {
    const coord = new RestartCoordinator();
    expect(coord.isRestarting()).toBe(false);
    coord.requestRestart();
    expect(coord.isRestarting()).toBe(true);
  });

  it("requestRestart is idempotent", () => {
    const coord = new RestartCoordinator();
    coord.requestRestart();
    coord.requestRestart();
    expect(coord.isRestarting()).toBe(true);
  });

  it("waitForDrain resolves true when in-flight count reaches 0", async () => {
    const coord = new RestartCoordinator();
    coord.track("op-1");
    const drainPromise = coord.waitForDrain(5000);
    coord.untrack("op-1");
    const result = await drainPromise;
    expect(result).toBe(true);
  });

  it("waitForDrain resolves immediately when no in-flight operations", async () => {
    const coord = new RestartCoordinator();
    const result = await coord.waitForDrain(5000);
    expect(result).toBe(true);
  });

  it("waitForDrain times out and returns false when operations don't complete", async () => {
    vi.useFakeTimers();
    const coord = new RestartCoordinator();
    coord.track("op-1");
    const drainPromise = coord.waitForDrain(1000);
    vi.advanceTimersByTime(1000);
    const result = await drainPromise;
    expect(result).toBe(false);
    vi.useRealTimers();
  });

  it("waitForDrain with grace 0 returns immediately false if in-flight", async () => {
    const coord = new RestartCoordinator();
    coord.track("op-1");
    const result = await coord.waitForDrain(0);
    expect(result).toBe(false);
  });

  it("waitForDrain with grace 0 returns true if no in-flight", async () => {
    const coord = new RestartCoordinator();
    const result = await coord.waitForDrain(0);
    expect(result).toBe(true);
  });
});