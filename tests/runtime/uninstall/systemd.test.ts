import { describe, expect, it, vi } from "vitest";
import {
  SYSTEMD_COMMANDS,
  SYSTEMD_UNIT_PATH,
  removeSystemdUnit,
  type SystemdDeps,
} from "../../../src/runtime/uninstall/systemd.js";

function createDeps(overrides: Partial<SystemdDeps> = {}): SystemdDeps {
  return {
    platform: "linux",
    unitExists: vi.fn(async () => true),
    hasSudo: vi.fn(async () => true),
    isInteractive: true,
    run: vi.fn(async () => 0),
    ...overrides,
  };
}

describe("runtime/uninstall/systemd", () => {
  it("uses the documented unit path and the four documented commands", () => {
    expect(SYSTEMD_UNIT_PATH).toBe("/etc/systemd/system/opencode-telegram-bot.service");
    expect(SYSTEMD_COMMANDS).toEqual([
      ["systemctl", "stop", "opencode-telegram-bot"],
      ["systemctl", "disable", "opencode-telegram-bot"],
      ["rm", "-f", SYSTEMD_UNIT_PATH],
      ["systemctl", "daemon-reload"],
    ]);
  });

  it.each(["darwin", "win32"] as const)("is not applicable on %s", async (platform) => {
    const deps = createDeps({ platform });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("not-applicable");
    expect(deps.unitExists).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("reports absent when the unit file does not exist", async () => {
    const deps = createDeps({ unitExists: vi.fn(async () => false) });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("absent");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("runs the four commands in order and reports removed", async () => {
    const deps = createDeps();

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("removed");
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    expect(vi.mocked(deps.run).mock.calls.map((call) => call[0])).toEqual(SYSTEMD_COMMANDS);
  });

  it("returns the commands without running them when there is no terminal", async () => {
    const deps = createDeps({ isInteractive: false });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("skipped-no-terminal");
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("returns the commands without running them when sudo is missing", async () => {
    const deps = createDeps({ hasSudo: vi.fn(async () => false) });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("skipped-no-sudo");
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("stops at the first failing command and returns it with the commands", async () => {
    const run = vi.fn(async (command: readonly string[]) => (command[1] === "disable" ? 1 : 0));
    const deps = createDeps({ run });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("failed");
    expect(result.failedCommand).toEqual(["systemctl", "disable", "opencode-telegram-bot"]);
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
