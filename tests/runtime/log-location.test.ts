import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLogsDirForTests,
  parseLogLocation,
  parseLogLocationChoice,
  resolveCanonicalLogsDir,
  resolveLogRetention,
  resolveLogsDirPath,
} from "../../src/runtime/log-location.js";
import { t } from "../../src/i18n/index.js";
import { persistEnvValue } from "../../src/runtime/env-file.js";

const pathsState = vi.hoisted(() => ({ appHome: "" }));
// Keeps the host's /.dockerenv out of the tests; a test sets exists to simulate it.
const dockerEnvState = vi.hoisted(() => ({ exists: false }));

vi.mock("../../src/runtime/container.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/runtime/container.js")>();
  return {
    ...original,
    isContainerRuntime: (options?: Parameters<typeof original.isContainerRuntime>[0]) =>
      original.isContainerRuntime({ dockerEnvExists: () => dockerEnvState.exists, ...options }),
  };
});

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

describe("parseLogLocationChoice", () => {
  it.each([
    ["1", "default"],
    ["2", "app"],
    ["default", "default"],
    ["app", "app"],
    [" APP ", "app"],
    ["Default", "default"],
  ])("maps %j to %s", (answer, expected) => {
    expect(parseLogLocationChoice(answer)).toBe(expected);
  });

  it.each(["", "3", "0", "apps", "nope"])("rejects %j", (answer) => {
    expect(parseLogLocationChoice(answer)).toBeNull();
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
    const expectedReason = await fs.readFile(envFilePath, "utf-8").then(
      () => "",
      (error: Error) => error.message,
    );
    expect(expectedReason).toContain("EISDIR");
    expect(warn).toHaveBeenCalledWith(
      t("runtime.logs.env_read_failed", { envPath: envFilePath, reason: expectedReason }),
    );
  });

  it("shares one resolution between concurrent calls", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
    const ask = vi.fn().mockResolvedValue("app");
    const options = { env: baseEnv(), isInteractive: true, ask, warn: vi.fn() };

    const [first, second] = await Promise.all([
      resolveLogsDirPath(options),
      resolveLogsDirPath(options),
    ]);

    expect(first).toBe(appLogsDir);
    expect(second).toBe(appLogsDir);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("writes each localized warning to stderr with exactly one trailing newline", async () => {
    const writes: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
      await resolveLogsDirPath({ env: baseEnv(), isInteractive: false });
      __resetLogsDirForTests();
      await resolveLogsDirPath({ env: baseEnv({ LOG_LOCATION: "bogus" }) });
      __resetLogsDirForTests();
      vi.mocked(persistEnvValue).mockRejectedValueOnce(new Error("disk full"));
      await resolveLogsDirPath({
        env: baseEnv(),
        isInteractive: true,
        ask: vi.fn().mockResolvedValueOnce("x").mockResolvedValueOnce("app"),
      });
      __resetLogsDirForTests();
      await fs.rm(envFilePath);
      await fs.mkdir(envFilePath);
      await resolveLogsDirPath({ env: baseEnv(), isInteractive: false });
    } finally {
      stderrSpy.mockRestore();
    }

    // Expected writes: no-TTY invalid .env (1: no_tty); invalid real env (1: invalid_env);
    // interactive with one bad answer then a failed save (3: invalid, choice_invalid,
    // persist_failed); unreadable .env (1: env_read_failed).
    expect(writes).toHaveLength(6);
    for (const written of writes) {
      expect(written.endsWith("\n")).toBe(true);
      expect(written.endsWith("\n\n")).toBe(false);
    }
  });

  it("uses default and warns once when input ends during the prompt", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
    const warn = vi.fn();
    const ask = vi.fn().mockResolvedValue(null);
    const dir = await resolveLogsDirPath({ env: baseEnv(), isInteractive: true, ask, warn });

    expect(dir).toBe(canonicalDir);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(
      t("runtime.logs.location_invalid_gave_up", { value: "bogus" }),
    );
    expect(persistEnvValue).not.toHaveBeenCalled();
    expect(await fs.readFile(envFilePath, "utf-8")).toBe("LOG_LOCATION=bogus\n");
  });

  it("gives up after 3 invalid answers, using default without persisting", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
    const warn = vi.fn();
    const ask = vi.fn().mockResolvedValue("garbage");
    const dir = await resolveLogsDirPath({ env: baseEnv(), isInteractive: true, ask, warn });

    expect(dir).toBe(canonicalDir);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      t("runtime.logs.location_invalid", { value: "bogus" }),
      t("runtime.logs.location_choice_invalid"),
      t("runtime.logs.location_choice_invalid"),
      t("runtime.logs.location_invalid_gave_up", { value: "bogus" }),
    ]);
    expect(persistEnvValue).not.toHaveBeenCalled();
  });

  it.each([
    ["app", () => appLogsDir],
    ["default", () => canonicalDir],
  ])(
    "keeps a real-env LOG_LOCATION=%s when .env is unreadable and BOT_LOCALE is unset",
    async (value, expected) => {
      await fs.mkdir(envFilePath);
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({
        env: baseEnv({ LOG_LOCATION: value }),
        isInteractive: false,
        warn,
      });

      expect(dir).toBe(expected());
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("gives up after 3 empty answers", async () => {
    await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
    const ask = vi.fn().mockResolvedValue("");
    const dir = await resolveLogsDirPath({
      env: baseEnv(),
      isInteractive: true,
      ask,
      warn: vi.fn(),
    });

    expect(dir).toBe(canonicalDir);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("translates early warnings with BOT_LOCALE read from .env", async () => {
    await fs.writeFile(envFilePath, "BOT_LOCALE=de\nLOG_LOCATION=bogus\n", "utf-8");
    const warn = vi.fn();
    await resolveLogsDirPath({ env: baseEnv(), isInteractive: false, warn });

    expect(warn).toHaveBeenCalledWith(
      t("runtime.logs.location_invalid_no_tty", { value: "bogus" }, "de"),
    );
    expect(t("runtime.logs.location_invalid_no_tty", { value: "bogus" }, "de")).not.toBe(
      t("runtime.logs.location_invalid_no_tty", { value: "bogus" }, "en"),
    );
  });

  it("prefers BOT_LOCALE from the environment over .env", async () => {
    await fs.writeFile(envFilePath, "BOT_LOCALE=de\nLOG_LOCATION=bogus\n", "utf-8");
    const warn = vi.fn();
    await resolveLogsDirPath({ env: baseEnv({ BOT_LOCALE: "fr" }), isInteractive: false, warn });

    expect(warn).toHaveBeenCalledWith(
      t("runtime.logs.location_invalid_no_tty", { value: "bogus" }, "fr"),
    );
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

    it.each([
      ["1", "default"],
      ["2", "app"],
      ["DEFAULT", "default"],
      ["App", "app"],
    ])("accepts the answer %j as %s", async (answer, expected) => {
      const ask = vi.fn().mockResolvedValueOnce(answer);
      const dir = await resolveLogsDirPath({
        env: baseEnv(),
        isInteractive: true,
        ask,
        warn: vi.fn(),
      });

      expect(dir).toBe(expected === "app" ? appLogsDir : canonicalDir);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe(`A=1\nLOG_LOCATION=${expected}\n`);
    });

    it("persists the answer in place of the invalid assignment", async () => {
      await fs.writeFile(envFilePath, "A=1\nLOG_LOCATION=bogus\nB=2\n", "utf-8");
      const ask = vi.fn().mockResolvedValueOnce("app");

      await resolveLogsDirPath({ env: baseEnv(), isInteractive: true, ask, warn: vi.fn() });

      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\nB=2\n");
    });

    it("lists the numbered choices in the prompt", async () => {
      const ask = vi.fn().mockResolvedValueOnce("app");
      await resolveLogsDirPath({ env: baseEnv(), isInteractive: true, ask, warn: vi.fn() });

      const prompt = String(ask.mock.calls[0]?.[0]);
      expect(prompt).toContain("1) default");
      expect(prompt).toContain("2) app");
    });

    it("warns once and does not prompt when prompting is disabled", async () => {
      const warn = vi.fn();
      const ask = vi.fn();
      const dir = await resolveLogsDirPath({
        env: baseEnv(),
        isInteractive: true,
        prompt: false,
        ask,
        warn,
      });

      expect(dir).toBe(canonicalDir);
      expect(ask).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        t("runtime.logs.location_invalid", { value: "bogus" }),
      ]);
      expect(persistEnvValue).not.toHaveBeenCalled();
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=bogus\n");
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

  describe("inside a container", () => {
    const containerEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
      baseEnv({ OPENCODE_TELEGRAM_CONTAINER: "1", ...extra });
    const overrideWarning = t("runtime.logs.container_overrides_default");
    const invalidValueWarning = (value: string): string =>
      t("runtime.logs.container_invalid_value", { value });

    afterEach(() => {
      dockerEnvState.exists = false;
    });

    it("resolves an unset LOG_LOCATION to the app logs directory without a warning", async () => {
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({ env: containerEnv(), warn });

      expect(dir).toBe(appLogsDir);
      expect(warn).not.toHaveBeenCalled();
    });

    it("resolves LOG_LOCATION=default from the real environment to the app logs directory with one warning", async () => {
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({
        env: containerEnv({ LOG_LOCATION: "default" }),
        warn,
      });

      expect(dir).toBe(appLogsDir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(overrideWarning);
    });

    it("resolves LOG_LOCATION=default from .env to the app logs directory with one warning", async () => {
      await fs.writeFile(envFilePath, "LOG_LOCATION=default\n", "utf-8");
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({ env: containerEnv(), warn });

      expect(dir).toBe(appLogsDir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(overrideWarning);
    });

    it("keeps an explicit app without a warning", async () => {
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({ env: containerEnv({ LOG_LOCATION: "app" }), warn });

      expect(dir).toBe(appLogsDir);
      expect(warn).not.toHaveBeenCalled();
    });

    it("detects a container from /.dockerenv", async () => {
      dockerEnvState.exists = true;
      const dir = await resolveLogsDirPath({ env: baseEnv(), warn: vi.fn() });

      expect(dir).toBe(appLogsDir);
    });

    it("never calls os.homedir for an unset LOG_LOCATION", async () => {
      const homedirSpy = vi.spyOn(os, "homedir").mockImplementation(() => {
        throw new Error("no home");
      });

      try {
        const dir = await resolveLogsDirPath({ env: containerEnv(), warn: vi.fn() });

        expect(dir).toBe(appLogsDir);
        expect(homedirSpy).not.toHaveBeenCalled();
      } finally {
        homedirSpy.mockRestore();
      }
    });

    it("uses the app logs directory for an invalid .env value without a terminal, with one container warning", async () => {
      await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({ env: containerEnv(), isInteractive: false, warn });

      expect(dir).toBe(appLogsDir);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([invalidValueWarning("bogus")]);
    });

    it("never prompts or persists for an invalid .env value even with a terminal", async () => {
      await fs.writeFile(envFilePath, "A=1\nLOG_LOCATION=bogus\n", "utf-8");
      const warn = vi.fn();
      const ask = vi.fn();
      const dir = await resolveLogsDirPath({
        env: containerEnv(),
        isInteractive: true,
        ask,
        warn,
      });

      expect(dir).toBe(appLogsDir);
      expect(ask).not.toHaveBeenCalled();
      expect(persistEnvValue).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([message]) => message)).toEqual([invalidValueWarning("bogus")]);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=bogus\n");
    });

    it("does not prompt for an invalid .env value when prompting is disabled", async () => {
      await fs.writeFile(envFilePath, "LOG_LOCATION=bogus\n", "utf-8");
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({ env: containerEnv(), prompt: false, warn });

      expect(dir).toBe(appLogsDir);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([invalidValueWarning("bogus")]);
    });

    it("uses the app logs directory for an invalid real-environment value with one container warning", async () => {
      const warn = vi.fn();
      const ask = vi.fn();
      const dir = await resolveLogsDirPath({
        env: containerEnv({ LOG_LOCATION: "bogus" }),
        isInteractive: true,
        ask,
        warn,
      });

      expect(dir).toBe(appLogsDir);
      expect(ask).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([message]) => message)).toEqual([invalidValueWarning("bogus")]);
    });

    it("uses the app logs directory when .env is unreadable", async () => {
      await fs.mkdir(envFilePath);
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({ env: containerEnv(), warn });

      expect(dir).toBe(appLogsDir);
      const expectedReason = await fs.readFile(envFilePath, "utf-8").then(
        () => "",
        (error: Error) => error.message,
      );
      expect(expectedReason).toContain("EISDIR");
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        t("runtime.logs.env_read_failed", { envPath: envFilePath, reason: expectedReason }),
      ]);
    });

    it("keeps the handed-down service directory over the container rule", async () => {
      const override = path.join(tempDir, "from-parent");
      const warn = vi.fn();
      const dir = await resolveLogsDirPath({
        env: containerEnv({
          OPENCODE_TELEGRAM_SERVICE_CHILD: "1",
          OPENCODE_TELEGRAM_SERVICE_LOGS_DIR: override,
          LOG_LOCATION: "default",
        }),
        warn,
      });

      expect(dir).toBe(override);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("outside a container", () => {
    it("treats a false container flag as not a container", async () => {
      const warn = vi.fn();
      const unset = await resolveLogsDirPath({
        env: baseEnv({ OPENCODE_TELEGRAM_CONTAINER: "0" }),
        warn,
      });
      __resetLogsDirForTests();
      const explicit = await resolveLogsDirPath({
        env: baseEnv({ OPENCODE_TELEGRAM_CONTAINER: "false", LOG_LOCATION: "default" }),
        warn,
      });

      expect(unset).toBe(canonicalDir);
      expect(explicit).toBe(canonicalDir);
      expect(warn).not.toHaveBeenCalled();
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

  describe("without a home directory", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("resolves LOG_LOCATION=app without calling os.homedir", async () => {
      vi.spyOn(os, "homedir").mockImplementation(() => {
        throw new Error("no home");
      });

      const dir = await resolveLogsDirPath({
        env: { LOG_LOCATION: "app" },
        isInteractive: false,
        warn: vi.fn(),
      });

      expect(dir).toBe(appLogsDir);
    });
  });
});

describe("resolveLogRetention", () => {
  let tempDir: string;
  let envFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "log-retention-test-"));
    pathsState.appHome = path.join(tempDir, "app");
    await fs.mkdir(pathsState.appHome, { recursive: true });
    envFilePath = path.join(pathsState.appHome, ".env");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads LOG_RETENTION from the .env file when the environment has none", async () => {
    await fs.writeFile(envFilePath, "LOG_RETENTION=3\n", "utf-8");

    await expect(resolveLogRetention({ env: {} })).resolves.toBe(3);
  });

  it("lets the real environment beat the .env file", async () => {
    await fs.writeFile(envFilePath, "LOG_RETENTION=3\n", "utf-8");

    await expect(resolveLogRetention({ env: { LOG_RETENTION: "5" } })).resolves.toBe(5);
  });

  it("falls back to the default for a missing or unusable value", async () => {
    await expect(resolveLogRetention({ env: {} })).resolves.toBe(10);

    await fs.writeFile(envFilePath, "LOG_RETENTION=abc\n", "utf-8");
    await expect(resolveLogRetention({ env: {} })).resolves.toBe(10);
  });

  it("falls back to the default when .env cannot be read", async () => {
    await fs.mkdir(envFilePath);

    await expect(resolveLogRetention({ env: {} })).resolves.toBe(10);
  });
});
