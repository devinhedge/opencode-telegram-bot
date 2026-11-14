import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  runUninstallMock: vi.fn(),
  deps: { marker: "default-uninstall-deps" },
  defaultUninstallDepsMock: vi.fn(),
  handleCliFailureMock: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  initializeLogger: vi.fn().mockResolvedValue(undefined),
  flushLogger: vi.fn().mockResolvedValue(undefined),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real handleCliFailure calls process.exit(1); its own test covers that.
vi.mock("../../src/cli/failure-exit.js", () => ({
  handleCliFailure: mocked.handleCliFailureMock,
}));

// The real runUninstall deletes user data. It must never run from a test.
vi.mock("../../src/runtime/uninstall/run.js", () => ({
  runUninstall: mocked.runUninstallMock,
  defaultUninstallDeps: mocked.defaultUninstallDepsMock,
}));

const RUNTIME_MODE_KEY = "OPENCODE_TELEGRAM_RUNTIME_MODE";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("cli uninstall command", () => {
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;
  let originalLogLevel: string | undefined;
  let originalRuntimeMode: string | undefined;
  let observedLogLevel: string | undefined;
  let observedRuntimeMode: string | undefined;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    originalLogLevel = process.env.LOG_LEVEL;
    originalRuntimeMode = process.env[RUNTIME_MODE_KEY];
    observedLogLevel = undefined;
    observedRuntimeMode = undefined;
    mocked.runUninstallMock.mockReset().mockImplementation(async () => {
      observedLogLevel = process.env.LOG_LEVEL;
      observedRuntimeMode = process.env[RUNTIME_MODE_KEY];
      return 0;
    });
    mocked.defaultUninstallDepsMock.mockReset().mockReturnValue(mocked.deps);
    mocked.handleCliFailureMock.mockReset().mockResolvedValue(undefined);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    restoreEnv("LOG_LEVEL", originalLogLevel);
    restoreEnv(RUNTIME_MODE_KEY, originalRuntimeMode);
  });

  it("passes the parsed flags to runUninstall", async () => {
    process.argv = ["node", "cli", "uninstall", "--yes", "--stop-opencode"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(mocked.runUninstallMock).toHaveBeenCalledWith(
      { yes: true, stopOpencode: true },
      mocked.deps,
    );
  });

  it("passes false flags when none are given", async () => {
    process.argv = ["node", "cli", "uninstall"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(mocked.runUninstallMock).toHaveBeenCalledWith(
      { yes: false, stopOpencode: false },
      mocked.deps,
    );
  });

  it("propagates the exit code of runUninstall", async () => {
    mocked.runUninstallMock.mockResolvedValue(3);
    process.argv = ["node", "cli", "uninstall", "--yes"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(3);
    });
  });

  it("sets the installed runtime mode before runUninstall runs", async () => {
    delete process.env[RUNTIME_MODE_KEY];
    process.argv = ["node", "cli", "uninstall"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(observedRuntimeMode).toBe("installed");
  });

  it("has LOG_LEVEL silent when runUninstall runs and it was unset", async () => {
    delete process.env.LOG_LEVEL;
    process.argv = ["node", "cli", "uninstall"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(observedLogLevel).toBe("silent");
  });

  it("has LOG_LEVEL silent when runUninstall runs even when it was debug", async () => {
    process.env.LOG_LEVEL = "debug";
    process.argv = ["node", "cli", "uninstall"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runUninstallMock).toHaveBeenCalledTimes(1);
    });

    expect(observedLogLevel).toBe("silent");
  });

  it("does not run the uninstall for a usage error and writes the error and usage", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = ["node", "cli", "start", "--yes"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(2);
    });

    expect(mocked.runUninstallMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--yes"));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("prints a fixed line without the error text and exits 1 when runUninstall rejects", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    mocked.runUninstallMock.mockRejectedValue(new Error("boom SECRET-SENTINEL"));
    process.argv = ["node", "cli", "uninstall", "--yes"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1);
    });

    expect(stderrSpy).toHaveBeenCalledWith("The uninstall failed unexpectedly.\n");
    const printed = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).not.toContain("SECRET-SENTINEL");
    expect(printed).not.toContain("boom");
    expect(mocked.handleCliFailureMock).not.toHaveBeenCalled();
  });
});
