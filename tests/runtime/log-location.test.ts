import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLogsDirForTests,
  parseLogLocation,
  resolveCanonicalLogsDir,
  resolveLogsDirPath,
} from "../../src/runtime/log-location.js";
import { t } from "../../src/i18n/index.js";
import { persistEnvValue } from "../../src/runtime/env-file.js";

const pathsState = vi.hoisted(() => ({ appHome: "" }));

vi.mock("../../src/runtime/paths.js", () => ({
  getRuntimePaths: () => ({
    appHome: pathsState.appHome,
    envFilePath: `${pathsState.appHome}/.env`,
    logsDirPath: `${pathsState.appHome}/logs`,
  }),
}));

vi.mock("../../src/runtime/env-file.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/runtime/env-file.js")>();
  return { ...original, persistEnvValue: vi.fn(original.persistEnvValue) };
});

describe("resolveCanonicalLogsDir", () => {
  it("resolves the macOS logs directory", () => {
    expect(resolveCanonicalLogsDir("darwin", {}, "/Users/a")).toBe(
      "/Users/a/Library/Logs/opencode-telegram-bot",
    );
  });

  it("uses XDG_STATE_HOME on linux when absolute", () => {
    expect(resolveCanonicalLogsDir("linux", { XDG_STATE_HOME: "/x/state" }, "/home/a")).toBe(
      "/x/state/opencode-telegram-bot/logs",
    );
  });

  it("falls back to ~/.local/state on linux", () => {
    expect(resolveCanonicalLogsDir("linux", {}, "/home/a")).toBe(
      "/home/a/.local/state/opencode-telegram-bot/logs",
    );
  });

  it("ignores a relative XDG_STATE_HOME", () => {
    expect(resolveCanonicalLogsDir("linux", { XDG_STATE_HOME: "rel" }, "/home/a")).toBe(
      "/home/a/.local/state/opencode-telegram-bot/logs",
    );
  });

  it("uses LOCALAPPDATA on win32", () => {
    expect(resolveCanonicalLogsDir("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\Users\\a")).toBe(
      "C:\\L\\opencode-telegram-bot\\Logs",
    );
  });

  it("falls back to AppData\\Local on win32 when LOCALAPPDATA is unset or empty", () => {
    const expected = "C:\\Users\\a\\AppData\\Local\\opencode-telegram-bot\\Logs";
    expect(resolveCanonicalLogsDir("win32", {}, "C:\\Users\\a")).toBe(expected);
    expect(resolveCanonicalLogsDir("win32", { LOCALAPPDATA: "" }, "C:\\Users\\a")).toBe(expected);
  });
});

describe("parseLogLocation", () => {
  it("accepts valid values case-insensitively with trimming", () => {
    expect(parseLogLocation("app")).toEqual({ kind: "valid", value: "app" });
    expect(parseLogLocation(" App ")).toEqual({ kind: "valid", value: "app" });
    expect(parseLogLocation("DEFAULT")).toEqual({ kind: "valid", value: "default" });
  });

  it("treats undefined and empty as unset", () => {
    expect(parseLogLocation(undefined)).toEqual({ kind: "unset" });
    expect(parseLogLocation("")).toEqual({ kind: "unset" });
  });

  it("reports invalid values with the raw input", () => {
    expect(parseLogLocation("apps")).toEqual({ kind: "invalid", raw: "apps" });
  });

  it("keeps the original untrimmed input as raw", () => {
    expect(parseLogLocation(" apps ")).toEqual({ kind: "invalid", raw: " apps " });
  });
});

describe("resolveLogsDirPath", () => {
  let tempDir: string;
  let envFilePath: string;
  let appLogsDir: string;
  let canonicalDir: string;

  const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    XDG_STATE_HOME: path.join(tempDir, "state"),
    LOCALAPPDATA: path.join(tempDir, "local"),
    ...extra,
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "log-location-test-"));
    pathsState.appHome = path.join(tempDir, "app");
    await fs.mkdir(pathsState.appHome, { recursive: true });
    envFilePath = path.join(pathsState.appHome, ".env");
    appLogsDir = path.join(pathsState.appHome, "logs");
    canonicalDir = resolveCanonicalLogsDir(process.platform, baseEnv(), os.homedir());
    __resetLogsDirForTests();
  });

  afterEach(async () => {
    __resetLogsDirForTests();
    vi.mocked(persistEnvValue).mockClear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns the canonical directory when LOG_LOCATION is unset", async () => {
    const warn = vi.fn();
    const dir = await resolveLogsDirPath({ env: baseEnv(), isInteractive: false, warn });

    expect(dir).toBe(canonicalDir);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns the app logs directory for LOG_LOCATION=app from env", async () => {
    const dir = await resolveLogsDirPath({ env: baseEnv({ LOG_LOCATION: "app" }) });

    expect(dir).toBe(appLogsDir);
  });

  it("returns the canonical directory for LOG_LOCATION=default from env", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=app\n", "utf-8");
    const dir = await resolveLogsDirPath({ env: baseEnv({ LOG_LOCATION: "default" }) });

    expect(dir).toBe(canonicalDir);
  });

  it("reads LOG_LOCATION from the .env file", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=app\n", "utf-8");
    const dir = await resolveLogsDirPath({ env: baseEnv() });

    expect(dir).toBe(appLogsDir);
  });

  it("treats an empty LOG_LOCATION as unset without warning or prompting", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=\n", "utf-8");
    const warn = vi.fn();
    const ask = vi.fn();
    const dir = await resolveLogsDirPath({
      env: baseEnv(),
      isInteractive: true,
      ask,
      warn,
    });

    expect(dir).toBe(canonicalDir);
    expect(warn).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("lets the real environment beat a conflicting .env value", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=app\n", "utf-8");
    const dir = await resolveLogsDirPath({ env: baseEnv({ LOG_LOCATION: "default" }) });

    expect(dir).toBe(canonicalDir);
  });

  it("ignores a missing .env file", async () => {
    const warn = vi.fn();
    const dir = await resolveLogsDirPath({ env: baseEnv(), warn });

    expect(dir).toBe(canonicalDir);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and uses default when .env cannot be read", async () => {
    await fs.mkdir(envFilePath);
    const warn = vi.fn();
    const dir = await resolveLogsDirPath({ env: baseEnv(), isInteractive: false, warn });

    expect(dir).toBe(canonicalDir);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toBe(
      t("runtime.logs.env_read_failed", {
        envPath: envFilePath,
        reason: message.slice(message.indexOf("EISDIR")).split("\n")[0] ?? "",
      }),
    );
    expect(message).toContain(envFilePath);
    expect(message).toContain("EISDIR");
  });

  it("does not keep a rejected resolution memoized", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
    const ask = vi.fn().mockRejectedValueOnce(new Error("stdin closed")).mockResolvedValue("app");
    const options = { env: baseEnv(), isInteractive: true, ask, warn: vi.fn() };

    await expect(resolveLogsDirPath(options)).rejects.toThrow("stdin closed");
    await expect(resolveLogsDirPath(options)).resolves.toBe(appLogsDir);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  describe("invalid value from .env", () => {
    beforeEach(async () => {
      await fs.writeFile(envFilePath, "A=1\nLOG_LOCATION=bogus\n", "utf-8");
    });

    it("prompts until a valid answer, persists it, and uses it", async () => {
      const warn = vi.fn();
      const ask = vi.fn().mockResolvedValueOnce("x").mockResolvedValueOnce("App");
      const dir = await resolveLogsDirPath({
        env: baseEnv(),
        isInteractive: true,
        ask,
        warn,
      });

      expect(dir).toBe(appLogsDir);
      expect(ask).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\n");
      expect(warn.mock.calls.some(([message]) => String(message).includes("bogus"))).toBe(true);
    });

    it("persists a default answer and returns the canonical directory", async () => {
      const ask = vi.fn().mockResolvedValueOnce("default");
      const dir = await resolveLogsDirPath({
        env: baseEnv(),
        isInteractive: true,
        ask,
        warn: vi.fn(),
      });

      expect(dir).toBe(canonicalDir);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=default\n");
    });

    it("warns on persistence failure and still uses the answer", async () => {
      vi.mocked(persistEnvValue).mockRejectedValueOnce(new Error("disk full"));
      const warn = vi.fn();
      const ask = vi.fn().mockResolvedValueOnce("app");
      const dir = await resolveLogsDirPath({
        env: baseEnv(),
        isInteractive: true,
        ask,
        warn,
      });

      expect(dir).toBe(appLogsDir);
      expect(warn).toHaveBeenCalledWith(
        t("runtime.logs.location_persist_failed", { envPath: envFilePath, reason: "disk full" }),
      );
    });

    it("warns once and uses default without a TTY, without persisting", async () => {
      const warn = vi.fn();
      const ask = vi.fn();
      const dir = await resolveLogsDirPath({
        env: baseEnv(),
        isInteractive: false,
        ask,
        warn,
      });

      expect(dir).toBe(canonicalDir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("bogus");
      expect(ask).not.toHaveBeenCalled();
      expect(persistEnvValue).not.toHaveBeenCalled();
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=bogus\n");
    });
  });

  it("warns once, does not persist, and uses default for an invalid real-env value", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=app\n", "utf-8");
    const warn = vi.fn();
    const ask = vi.fn();
    const dir = await resolveLogsDirPath({
      env: baseEnv({ LOG_LOCATION: "bogus" }),
      isInteractive: true,
      ask,
      warn,
    });

    expect(dir).toBe(canonicalDir);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("bogus");
    expect(ask).not.toHaveBeenCalled();
    expect(persistEnvValue).not.toHaveBeenCalled();
    expect(await fs.readFile(envFilePath, "utf-8")).toBe("LOG_LOCATION=app\n");
  });

  describe("service child override", () => {
    it("wins over every other source when the child flag is set", async () => {
      await fs.writeFile(envFilePath, "LOG_LOCATION=app\n", "utf-8");
      const override = path.join(tempDir, "from-parent");
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({
        env: baseEnv({
          OPENCODE_TELEGRAM_SERVICE_CHILD: "1",
          OPENCODE_TELEGRAM_SERVICE_LOGS_DIR: override,
          LOG_LOCATION: "bogus",
        }),
        isInteractive: false,
        warn,
      });

      expect(dir).toBe(override);
      expect(warn).not.toHaveBeenCalled();
    });

    it("is ignored when the child flag is not set", async () => {
      const dir = await resolveLogsDirPath({
        env: baseEnv({ OPENCODE_TELEGRAM_SERVICE_LOGS_DIR: path.join(tempDir, "nope") }),
      });

      expect(dir).toBe(canonicalDir);
    });

    it("falls through when the child flag is set but the directory is blank", async () => {
      const dir = await resolveLogsDirPath({
        env: baseEnv({
          OPENCODE_TELEGRAM_SERVICE_CHILD: "1",
          OPENCODE_TELEGRAM_SERVICE_LOGS_DIR: "  ",
        }),
      });

      expect(dir).toBe(canonicalDir);
    });
  });

  it("memoizes the first result for the process", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
    const ask = vi.fn().mockResolvedValue("app");
    const options = { env: baseEnv(), isInteractive: true, ask, warn: vi.fn() };

    const first = await resolveLogsDirPath(options);
    const second = await resolveLogsDirPath(options);

    expect(second).toBe(first);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
