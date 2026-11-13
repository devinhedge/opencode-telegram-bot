import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFn = (command: string, callback: ExecCallback) => unknown;

const { spawnMock, execMock } = vi.hoisted(() => {
  const spawnMock = vi.fn();
  const execMock = vi.fn<ExecFn>() as Mock<ExecFn> & {
    [key: symbol]: (command: string) => Promise<{ stdout: string; stderr: string }>;
  };

  const customPromisifySymbol = Symbol.for("nodejs.util.promisify.custom");
  execMock[customPromisifySymbol] = function (this: unknown, command: string) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execMock(command, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };

  return { spawnMock, execMock };
});

const { getRuntimePathsMock, runtimePathsState } = vi.hoisted(() => {
  const runtimePathsState = {
    value: {
      mode: "installed",
      appHome: "D:/temp/opencode-telegram-test",
      envFilePath: "D:/temp/opencode-telegram-test/.env",
      settingsFilePath: "D:/temp/opencode-telegram-test/settings.json",
      logsDirPath: "D:/temp/opencode-telegram-test/logs",
      runDirPath: "D:/temp/opencode-telegram-test/run",
    },
  };

  return {
    getRuntimePathsMock: vi.fn(() => runtimePathsState.value),
    runtimePathsState,
  };
});

const { resolveLogsDirPathMock, logsDirState } = vi.hoisted(() => {
  const logsDirState = { value: "" };

  return {
    resolveLogsDirPathMock: vi.fn(async () => logsDirState.value),
    logsDirState,
  };
});

vi.mock("../../../src/runtime/log-location.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/runtime/log-location.js")>();
  return {
    resolveLogsDirPath: resolveLogsDirPathMock,
    resolveLogRetention: original.resolveLogRetention,
  };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  exec: execMock,
}));

vi.mock("../../../src/runtime/paths.js", () => ({
  getRuntimePaths: getRuntimePathsMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { FILE_MODE, SERVICE_LOG_FILE_PATTERN } from "../../../src/utils/log-files.js";
import { logger } from "../../../src/utils/logger.js";
import { getServiceLogsDirFromEnv } from "../../../src/runtime/service/env.js";
import {
  getBotServiceStatus,
  getServiceStateFilePath,
  readBotServiceStatus,
  startBotDaemon,
  stopBotDaemon,
} from "../../../src/runtime/service/manager.js";

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });

  return () => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  };
}

describe("runtime/service/manager", () => {
  let tempDirPath: string;
  let originalArgv1: string | undefined;

  beforeEach(async () => {
    tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-telegram-service-"));
    originalArgv1 = process.argv[1];
    process.argv[1] = path.join(tempDirPath, "dist", "cli.js");

    runtimePathsState.value = {
      mode: "installed",
      appHome: tempDirPath,
      envFilePath: path.join(tempDirPath, ".env"),
      settingsFilePath: path.join(tempDirPath, "settings.json"),
      logsDirPath: path.join(tempDirPath, "logs"),
      runDirPath: path.join(tempDirPath, "run"),
    };
    logsDirState.value = path.join(tempDirPath, "resolved-logs");

    spawnMock.mockReset();
    execMock.mockReset();
    execMock.mockImplementation((_command: string, callback: ExecCallback) => {
      callback(null, "", "");

      return {};
    });
  });

  afterEach(async () => {
    if (originalArgv1 === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalArgv1;
    }

    vi.restoreAllMocks();
    if (tempDirPath) {
      await fs.rm(tempDirPath, { recursive: true, force: true });
    }
  });

  it("starts daemon process and persists runtime state", async () => {
    spawnMock.mockReturnValue({
      pid: 4321,
      unref: vi.fn(),
    });

    const result = await startBotDaemon("installed");

    expect(result.success).toBe(true);
    expect(result.service).toEqual(
      expect.objectContaining({
        pid: 4321,
        mode: "daemon",
      }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [path.resolve(process.argv[1]!), "start", "--mode", "installed"],
      expect.objectContaining({
        detached: true,
        windowsHide: true,
        env: expect.objectContaining({
          OPENCODE_TELEGRAM_SERVICE_CHILD: "1",
          OPENCODE_TELEGRAM_SERVICE_STATE_PATH: getServiceStateFilePath(),
          OPENCODE_TELEGRAM_SERVICE_LOGS_DIR: logsDirState.value,
        }),
      }),
    );

    const persistedState = JSON.parse(await fs.readFile(getServiceStateFilePath(), "utf-8")) as {
      pid: number;
      mode: string;
    };
    expect(persistedState).toEqual(
      expect.objectContaining({
        pid: 4321,
        mode: "daemon",
      }),
    );
  });

  it("writes the service log in the resolved directory with a pattern-matching name", async () => {
    spawnMock.mockReturnValue({ pid: 4322, unref: vi.fn() });

    const result = await startBotDaemon("installed");

    expect(result.success).toBe(true);
    const logFilePath = result.service!.logFilePath;
    expect(path.dirname(logFilePath)).toBe(logsDirState.value);
    expect(path.basename(logFilePath)).toMatch(SERVICE_LOG_FILE_PATTERN);
    await expect(fs.access(logFilePath)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("creates the service log owner-only", async () => {
    spawnMock.mockReturnValue({ pid: 4323, unref: vi.fn() });

    const openSpy = vi.spyOn(fsSync, "openSync");

    const result = await startBotDaemon("installed");

    const stat = await fs.stat(result.service!.logFilePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(openSpy).toHaveBeenCalledWith(result.service!.logFilePath, "a", 0o600);
  });

  it("opens the service log with mode 0o600 as the third openSync argument", async () => {
    spawnMock.mockReturnValue({ pid: 4325, unref: vi.fn() });
    const openSpy = vi.spyOn(fsSync, "openSync");

    const result = await startBotDaemon("installed");

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[2]).toBe(FILE_MODE);
    expect(FILE_MODE).toBe(0o600);
    expect(result.success).toBe(true);
  });

  it("closes the descriptor exactly once on success", async () => {
    spawnMock.mockReturnValue({ pid: 4326, unref: vi.fn() });
    const openSpy = vi.spyOn(fsSync, "openSync");
    const closeSpy = vi.spyOn(fsSync, "closeSync");

    await startBotDaemon("installed");

    const descriptor = openSpy.mock.results[0]?.value as number;
    expect(closeSpy.mock.calls.filter(([fd]) => fd === descriptor)).toHaveLength(1);
  });

  it("closes the descriptor exactly once when spawn fails", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn boom");
    });
    const openSpy = vi.spyOn(fsSync, "openSync");
    const closeSpy = vi.spyOn(fsSync, "closeSync");

    const result = await startBotDaemon("installed");

    expect(result.success).toBe(false);
    const descriptor = openSpy.mock.results[0]?.value as number;
    expect(closeSpy.mock.calls.filter(([fd]) => fd === descriptor)).toHaveLength(1);
  });

  it("closes the descriptor exactly once when writing the state file fails", async () => {
    spawnMock.mockReturnValue({ pid: 4327, unref: vi.fn() });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename boom"));
    const openSpy = vi.spyOn(fsSync, "openSync");
    const closeSpy = vi.spyOn(fsSync, "closeSync");

    const result = await startBotDaemon("installed");

    expect(result.success).toBe(false);
    expect(result.error).toContain("rename boom");
    const descriptor = openSpy.mock.results[0]?.value as number;
    expect(closeSpy.mock.calls.filter(([fd]) => fd === descriptor)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "does not leak the descriptor when securing the service log throws",
    async () => {
      vi.spyOn(fsSync, "chmodSync").mockImplementation(() => {
        throw new Error("chmod boom");
      });
      const openSpy = vi.spyOn(fsSync, "openSync");
      const closeSpy = vi.spyOn(fsSync, "closeSync");

      const result = await startBotDaemon("installed");

      expect(result.success).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
      const descriptor = openSpy.mock.results[0]?.value as number;
      expect(closeSpy.mock.calls.filter(([fd]) => fd === descriptor)).toHaveLength(1);
    },
  );

  it("hands a logs directory with a space and a non-ASCII character to the child", async () => {
    logsDirState.value = path.join(tempDirPath, "logs dir é");
    spawnMock.mockReturnValue({ pid: 4328, unref: vi.fn() });

    const result = await startBotDaemon("installed");

    expect(result.success).toBe(true);
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.OPENCODE_TELEGRAM_SERVICE_LOGS_DIR).toBe(logsDirState.value);
    expect(getServiceLogsDirFromEnv(spawnOptions.env)).toBe(logsDirState.value);
    expect(path.dirname(result.service!.logFilePath)).toBe(logsDirState.value);
    await expect(fs.access(result.service!.logFilePath)).resolves.toBeUndefined();
  });

  it("keeps the cause of an open failure and logs it", async () => {
    await fs.writeFile(logsDirState.value, "not a directory");

    const result = await startBotDaemon("installed");

    expect(result.error).toContain(`Cannot open the service log in ${logsDirState.value}`);
    const errorCall = vi.mocked(logger.error).mock.calls.at(-1);
    expect(errorCall?.[0]).toContain(logsDirState.value);
    expect(errorCall?.[1]).toBeInstanceOf(Error);
    expect((errorCall?.[1] as NodeJS.ErrnoException).code).toBeDefined();
  });

  it("fails before spawning when the logs directory path is a regular file", async () => {
    await fs.writeFile(logsDirState.value, "not a directory");

    const result = await startBotDaemon("installed");

    expect(result.success).toBe(false);
    expect(result.service).toBeNull();
    expect(result.error).toContain(logsDirState.value);
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(fs.access(getServiceStateFilePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes old service logs beyond LOG_RETENTION and leaves other files alone", async () => {
    vi.stubEnv("LOG_RETENTION", "2");
    spawnMock.mockReturnValue({ pid: 4324, unref: vi.fn() });

    await fs.mkdir(logsDirState.value, { recursive: true });
    const oldServiceLogs = [
      "opencode-telegram-bot-service-2020-01-01_00-00-00.log",
      "opencode-telegram-bot-service-2020-01-02_00-00-00.log",
      "opencode-telegram-bot-service-2020-01-03_00-00-00.log",
    ];
    const keptFiles = ["opencode-telegram-bot-2020-01-01_00-00-00_123.log", "notes.txt"];
    for (const name of [...oldServiceLogs, ...keptFiles]) {
      await fs.writeFile(path.join(logsDirState.value, name), "x");
    }

    try {
      const result = await startBotDaemon("installed");
      expect(result.success).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }

    const remaining = await fs.readdir(logsDirState.value);
    expect(remaining).not.toContain(oldServiceLogs[0]);
    expect(remaining).not.toContain(oldServiceLogs[1]);
    expect(remaining).toContain(oldServiceLogs[2]);
    for (const name of keptFiles) {
      expect(remaining).toContain(name);
    }
    expect(remaining.filter((name) => SERVICE_LOG_FILE_PATTERN.test(name))).toHaveLength(2);
  });

  it("prunes service logs to a LOG_RETENTION that exists only in the .env file", async () => {
    vi.stubEnv("LOG_RETENTION", "");
    spawnMock.mockReturnValue({ pid: 4325, unref: vi.fn() });

    await fs.writeFile(runtimePathsState.value.envFilePath, "LOG_RETENTION=1\n", "utf-8");
    await fs.mkdir(logsDirState.value, { recursive: true });
    const oldServiceLogs = [
      "opencode-telegram-bot-service-2020-01-01_00-00-00.log",
      "opencode-telegram-bot-service-2020-01-02_00-00-00.log",
    ];
    for (const name of oldServiceLogs) {
      await fs.writeFile(path.join(logsDirState.value, name), "x");
    }

    try {
      const result = await startBotDaemon("installed");
      expect(result.success).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }

    const remaining = await fs.readdir(logsDirState.value);
    expect(remaining.filter((name) => SERVICE_LOG_FILE_PATTERN.test(name))).toHaveLength(1);
  });

  it("cleans stale daemon state during status check", async () => {
    await fs.mkdir(path.dirname(getServiceStateFilePath()), { recursive: true });
    await fs.writeFile(
      getServiceStateFilePath(),
      JSON.stringify({
        pid: 9876,
        startedAt: new Date().toISOString(),
        logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
        mode: "daemon",
      }),
    );

    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const status = await getBotServiceStatus();

    expect(status).toEqual({
      status: "stopped",
      service: null,
      cleanupReason: "stale",
    });
    await expect(fs.access(getServiceStateFilePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("readBotServiceStatus", () => {
    beforeEach(() => {
      vi.mocked(logger.info).mockClear();
      vi.mocked(logger.warn).mockClear();
    });

    async function writeState(content: string): Promise<void> {
      await fs.mkdir(path.dirname(getServiceStateFilePath()), { recursive: true });
      await fs.writeFile(getServiceStateFilePath(), content);
    }

    it("reports a stale state file and leaves it in place without logging", async () => {
      const content = JSON.stringify({
        pid: 9876,
        startedAt: new Date().toISOString(),
        logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
        mode: "daemon",
      });
      await writeState(content);
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });

      const status = await readBotServiceStatus();

      expect(status).toEqual({ status: "stopped", service: null, cleanupReason: "stale" });
      await expect(fs.readFile(getServiceStateFilePath(), "utf-8")).resolves.toBe(content);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("reports a recycled pid as stale and leaves the file in place", async () => {
      const restorePlatform = setPlatform("win32");
      const content = JSON.stringify({
        pid: 11236,
        startedAt: new Date("2026-07-18T20:56:06.413Z").toISOString(),
        logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
        mode: "daemon",
      });
      await writeState(content);
      vi.spyOn(process, "kill").mockImplementation(() => true);
      execMock.mockImplementation(
        (
          _command: string,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, "20260719095542.123456+180\n", "");
          return {};
        },
      );

      try {
        const status = await readBotServiceStatus();

        expect(status).toEqual({ status: "stopped", service: null, cleanupReason: "stale" });
        await expect(fs.readFile(getServiceStateFilePath(), "utf-8")).resolves.toBe(content);
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        restorePlatform();
      }
    });

    it("reports invalid JSON and an invalid state without removing the file", async () => {
      for (const content of ["{not json", JSON.stringify({ pid: -1 })]) {
        await writeState(content);

        const status = await readBotServiceStatus();

        expect(status).toEqual({ status: "stopped", service: null, cleanupReason: "invalid" });
        await expect(fs.readFile(getServiceStateFilePath(), "utf-8")).resolves.toBe(content);
      }
    });

    it("reads an explicit state file path and reports a live daemon as running", async () => {
      const explicit = path.join(tempDirPath, "other", "bot-service.json");
      await fs.mkdir(path.dirname(explicit), { recursive: true });
      await fs.writeFile(
        explicit,
        JSON.stringify({
          pid: 2468,
          startedAt: new Date(Date.now() + 60_000).toISOString(),
          logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
          mode: "daemon",
        }),
      );
      vi.spyOn(process, "kill").mockImplementation(() => true);

      const status = await readBotServiceStatus(explicit);

      expect(status.status).toBe("running");
      expect(status.service?.pid).toBe(2468);
    });

    it("keeps getBotServiceStatus removing a stale file", async () => {
      await writeState("{not json");

      await getBotServiceStatus();

      await expect(fs.access(getServiceStateFilePath())).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("stops daemon process and clears runtime state", async () => {
    const restorePlatform = setPlatform("linux");
    let isRunning = true;

    await fs.mkdir(path.dirname(getServiceStateFilePath()), { recursive: true });
    await fs.writeFile(
      getServiceStateFilePath(),
      JSON.stringify({
        pid: 2468,
        startedAt: new Date().toISOString(),
        logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
        mode: "daemon",
      }),
    );

    vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0 || signal === undefined) {
        if (isRunning) {
          return true;
        }

        throw new Error("ESRCH");
      }

      if (signal === "SIGTERM") {
        isRunning = false;
        return true;
      }

      return true;
    });

    try {
      const result = await stopBotDaemon(50);

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          cleanupReason: null,
        }),
      );
      expect(result.service).toEqual(
        expect.objectContaining({
          pid: 2468,
          mode: "daemon",
        }),
      );
      await expect(fs.access(getServiceStateFilePath())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restorePlatform();
    }
  });

  it("detects recycled PID via process creation time", async () => {
    const restorePlatform = setPlatform("win32");

    const daemonStartedAt = new Date("2026-07-18T20:56:06.413Z");
    const stolenPid = 11236;

    await fs.mkdir(path.dirname(getServiceStateFilePath()), { recursive: true });
    await fs.writeFile(
      getServiceStateFilePath(),
      JSON.stringify({
        pid: stolenPid,
        startedAt: daemonStartedAt.toISOString(),
        logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
        mode: "daemon",
      }),
    );

    vi.spyOn(process, "kill").mockImplementation(() => true);

    execMock.mockImplementation(
      (
        command: string,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (command.includes("powershell") && command.includes(String(stolenPid))) {
          callback(null, "20260719095542.123456+180\n", "");
        } else {
          callback(null, "", "");
        }
        return {};
      },
    );

    try {
      const status = await getBotServiceStatus();

      expect(status).toEqual({
        status: "stopped",
        service: null,
        cleanupReason: "stale",
      });
      await expect(fs.access(getServiceStateFilePath())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restorePlatform();
    }
  });

  it("returns running when PID exists and creation time matches", async () => {
    const restorePlatform = setPlatform("win32");

    const daemonStartedAt = new Date("2026-07-18T20:56:06.413Z");
    const pid = 11236;

    await fs.mkdir(path.dirname(getServiceStateFilePath()), { recursive: true });
    await fs.writeFile(
      getServiceStateFilePath(),
      JSON.stringify({
        pid,
        startedAt: daemonStartedAt.toISOString(),
        logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
        mode: "daemon",
      }),
    );

    vi.spyOn(process, "kill").mockImplementation(() => true);

    execMock.mockImplementation(
      (
        command: string,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (command.includes("powershell") && command.includes(String(pid))) {
          const creationDateStr =
            daemonStartedAt.getFullYear().toString() +
            String(daemonStartedAt.getMonth() + 1).padStart(2, "0") +
            String(daemonStartedAt.getDate()).padStart(2, "0") +
            String(daemonStartedAt.getHours()).padStart(2, "0") +
            String(daemonStartedAt.getMinutes()).padStart(2, "0") +
            String(daemonStartedAt.getSeconds()).padStart(2, "0") +
            ".000000+180";
          callback(null, `${creationDateStr}\n`, "");
        } else {
          callback(null, "", "");
        }
        return {};
      },
    );

    try {
      const status = await getBotServiceStatus();

      expect(status).toEqual({
        status: "running",
        service: expect.objectContaining({ pid, mode: "daemon" }),
        cleanupReason: null,
      });
      await expect(fs.access(getServiceStateFilePath())).resolves.toBeUndefined();
    } finally {
      restorePlatform();
    }
  });

  it("falls back to PID-only check when creation time cannot be determined", async () => {
    const restorePlatform = setPlatform("win32");

    await fs.mkdir(path.dirname(getServiceStateFilePath()), { recursive: true });
    await fs.writeFile(
      getServiceStateFilePath(),
      JSON.stringify({
        pid: 9999,
        startedAt: new Date().toISOString(),
        logFilePath: path.join(tempDirPath, "logs", "bot-service.log"),
        mode: "daemon",
      }),
    );

    vi.spyOn(process, "kill").mockImplementation(() => true);

    execMock.mockImplementation(
      (
        command: string,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (command.includes("powershell")) {
          callback(new Error("PowerShell failed"), "", "");
        } else {
          callback(null, "", "");
        }
        return {};
      },
    );

    try {
      const status = await getBotServiceStatus();

      expect(status).toEqual({
        status: "running",
        service: expect.objectContaining({ pid: 9999, mode: "daemon" }),
        cleanupReason: null,
      });
    } finally {
      restorePlatform();
    }
  });
});
