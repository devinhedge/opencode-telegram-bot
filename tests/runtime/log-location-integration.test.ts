import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHome } from "../helpers/test-environment.js";

// Real logger, real resolver and real daemon manager over a temporary directory tree;
// only `spawn` is mocked, so no child process starts. Every path the code can compute
// (home, XDG, LOCALAPPDATA, app home) is inside the temp root, and process.platform is
// never stubbed: a stubbed win32 on a POSIX host would create backslash-named
// directories in the repository root.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// Keeps the host's /.dockerenv out of the tests: inside a container the default location is the
// app home, which would change what the canonical-directory test expects.
const dockerEnvState = vi.hoisted(() => ({ exists: false }));

vi.mock("../../src/runtime/container.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/runtime/container.js")>();
  return {
    ...original,
    isContainerRuntime: (options?: Parameters<typeof original.isContainerRuntime>[0]) =>
      original.isContainerRuntime({ dockerEnvExists: () => dockerEnvState.exists, ...options }),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

const isWindows = process.platform === "win32";

describe("log location integration", () => {
  let root: string;
  let homeDir: string;
  let appHome: string;
  let originalArgv1: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "log-location-int-"));
    homeDir = path.join(root, "home");
    // Registered with the shared test environment, which redirects any other app home.
    appHome = await createTestHome("log-location-int-app-");
    await fs.mkdir(homeDir, { recursive: true });

    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    vi.stubEnv("XDG_STATE_HOME", path.join(root, "xdg-state"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg-config"));
    vi.stubEnv("LOCALAPPDATA", path.join(root, "local-app-data"));
    vi.stubEnv("APPDATA", path.join(root, "app-data"));
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", appHome);
    vi.stubEnv("OPENCODE_TELEGRAM_RUNTIME_MODE", "installed");
    vi.stubEnv("LOG_LOCATION", undefined);
    vi.stubEnv("OPENCODE_TELEGRAM_CONTAINER", "");
    vi.stubEnv("OPENCODE_TELEGRAM_SERVICE_CHILD", undefined);
    vi.stubEnv("OPENCODE_TELEGRAM_SERVICE_LOGS_DIR", undefined);
    vi.stubEnv("OPENCODE_TELEGRAM_SERVICE_STATE_PATH", undefined);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    originalArgv1 = process.argv[1];
    process.argv[1] = path.join(root, "dist", "cli.js");

    spawnMock.mockReset();
    spawnMock.mockReturnValue({ pid: 5151, unref: vi.fn() });
    vi.resetModules();
  });

  afterEach(async () => {
    dockerEnvState.exists = false;
    const { __resetLoggerForTests } = await import("../../src/utils/logger.js");
    const { __resetLogsDirForTests } = await import("../../src/runtime/log-location.js");
    __resetLoggerForTests();
    __resetLogsDirForTests();

    if (originalArgv1 === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalArgv1;
    }

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(appHome, { recursive: true, force: true });
  });

  async function runLoggerThenDaemon(): Promise<{
    mainLogPath: string;
    serviceLogPath: string;
  }> {
    const { initializeLogger, getLogFilePath, flushLogger } =
      await import("../../src/utils/logger.js");
    const { startBotDaemon } = await import("../../src/runtime/service/manager.js");

    await initializeLogger();
    const mainLogPath = getLogFilePath();
    expect(mainLogPath).not.toBeNull();

    const result = await startBotDaemon("installed");
    expect(result.success).toBe(true);
    await flushLogger();

    return { mainLogPath: mainLogPath!, serviceLogPath: result.service!.logFilePath };
  }

  function spawnedServiceLogsDir(): string | undefined {
    const options = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv } | undefined;
    return options?.env.OPENCODE_TELEGRAM_SERVICE_LOGS_DIR;
  }

  async function expectOwnerOnly(dirPath: string, ...filePaths: string[]): Promise<void> {
    if (isWindows) {
      return;
    }

    expect((await fs.stat(dirPath)).mode & 0o777).toBe(0o700);
    for (const filePath of filePaths) {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  }

  it("writes the main log and the service log to the same canonical directory", async () => {
    const { resolveCanonicalLogsDir } = await import("../../src/runtime/log-location.js");
    const expectedDir = resolveCanonicalLogsDir(process.platform, process.env, homeDir);
    expect(expectedDir.startsWith(root)).toBe(true);

    const { mainLogPath, serviceLogPath } = await runLoggerThenDaemon();

    expect(path.dirname(mainLogPath)).toBe(expectedDir);
    expect(path.dirname(serviceLogPath)).toBe(expectedDir);
    expect(path.basename(mainLogPath)).toMatch(/^opencode-telegram-bot-\d{4}-\d{2}-\d{2}\.log$/);
    expect(path.basename(serviceLogPath)).toMatch(/^opencode-telegram-bot-service-.+\.log$/);
    expect(spawnedServiceLogsDir()).toBe(expectedDir);
    await expectOwnerOnly(expectedDir, mainLogPath, serviceLogPath);
    await expect(fs.access(path.join(appHome, "logs"))).rejects.toThrow();
  });

  it("writes both logs to <appHome>/logs by default inside a container", async () => {
    dockerEnvState.exists = true;
    const expectedDir = path.join(appHome, "logs");

    const { mainLogPath, serviceLogPath } = await runLoggerThenDaemon();

    expect(path.dirname(mainLogPath)).toBe(expectedDir);
    expect(path.dirname(serviceLogPath)).toBe(expectedDir);
    expect(spawnedServiceLogsDir()).toBe(expectedDir);
    await expect(fs.readdir(path.join(root, "xdg-state"))).rejects.toThrow();
    await expect(fs.readdir(path.join(homeDir, "Library"))).rejects.toThrow();
    await expect(fs.readdir(path.join(root, "local-app-data"))).rejects.toThrow();
  });

  it("writes both logs to <appHome>/logs when LOG_LOCATION=app", async () => {
    vi.stubEnv("LOG_LOCATION", "app");
    const expectedDir = path.join(appHome, "logs");

    const { mainLogPath, serviceLogPath } = await runLoggerThenDaemon();

    expect(path.dirname(mainLogPath)).toBe(expectedDir);
    expect(path.dirname(serviceLogPath)).toBe(expectedDir);
    expect(spawnedServiceLogsDir()).toBe(expectedDir);
    await expectOwnerOnly(expectedDir, mainLogPath, serviceLogPath);
    await expect(fs.readdir(path.join(root, "xdg-state"))).rejects.toThrow();
    await expect(fs.readdir(path.join(homeDir, "Library"))).rejects.toThrow();
    await expect(fs.readdir(path.join(root, "local-app-data"))).rejects.toThrow();
  });
});
