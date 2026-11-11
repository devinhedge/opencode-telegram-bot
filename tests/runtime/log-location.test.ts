import { describe, expect, it } from "vitest";
import { parseLogLocation, resolveCanonicalLogsDir } from "../../src/runtime/log-location.js";

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
});
