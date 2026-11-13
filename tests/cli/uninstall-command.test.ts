import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  runUninstallMock: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  initializeLogger: vi.fn().mockResolvedValue(undefined),
  flushLogger: vi.fn().mockResolvedValue(undefined),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real runUninstall deletes user data. It must never run from a test.
vi.mock("../../src/runtime/uninstall/run.js", () => ({
  runUninstall: mocked.runUninstallMock,
}));

describe("cli uninstall command", () => {
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    originalLogLevel = process.env.LOG_LEVEL;
    mocked.runUninstallMock.mockReset().mockResolvedValue(0);
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it("passes the parsed flags to runUninstall", async () => {
    process.argv = ["node", "cli", "uninstall", "--yes", "--stop-opencode"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(mocked.runUninstallMock).toHaveBeenCalledWith({ yes: true, stopOpencode: true });
  });

  it("passes false flags when none are given", async () => {
    process.argv = ["node", "cli", "uninstall"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(mocked.runUninstallMock).toHaveBeenCalledWith({ yes: false, stopOpencode: false });
  });

  it("propagates the exit code of runUninstall", async () => {
    mocked.runUninstallMock.mockResolvedValue(3);
    process.argv = ["node", "cli", "uninstall", "--yes"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(3);
    });
  });

  it("sets LOG_LEVEL to silent when it was unset", async () => {
    delete process.env.LOG_LEVEL;
    process.argv = ["node", "cli", "uninstall"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(process.env.LOG_LEVEL).toBe("silent");
  });

  it("sets LOG_LEVEL to silent even when it was set", async () => {
    process.env.LOG_LEVEL = "debug";
    process.argv = ["node", "cli", "uninstall"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(process.env.LOG_LEVEL).toBe("silent");
  });

  it("does not run the uninstall for a usage error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = ["node", "cli", "start", "--yes"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(2);
    });

    expect(mocked.runUninstallMock).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});
