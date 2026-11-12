import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  initializeLoggerMock: vi.fn(),
  runConfigWizardCommandMock: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  initializeLogger: mocked.initializeLoggerMock,
  flushLogger: vi.fn().mockResolvedValue(undefined),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/runtime/bootstrap.js", () => ({
  runConfigWizardCommand: mocked.runConfigWizardCommandMock,
}));

describe("cli config command", () => {
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    mocked.initializeLoggerMock.mockReset().mockResolvedValue(undefined);
    mocked.runConfigWizardCommandMock.mockReset().mockResolvedValue(undefined);
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  });

  it("initializes the logger without the log-location prompt, leaving the question to the wizard", async () => {
    process.argv = ["node", "cli", "config"];

    await import("../../src/cli.js");
    await vi.waitFor(() => {
      expect(mocked.runConfigWizardCommandMock).toHaveBeenCalledTimes(1);
    });

    expect(mocked.initializeLoggerMock).toHaveBeenCalledTimes(1);
    expect(mocked.initializeLoggerMock).toHaveBeenCalledWith({ promptForLogLocation: false });
  });
});
