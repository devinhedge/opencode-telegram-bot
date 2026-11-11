import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli/args.js";

describe("cli/args", () => {
  it("uses start command by default", () => {
    const parsed = parseCliArgs([]);

    expect(parsed).toEqual({
      command: "start",
      daemon: false,
      restart: false,
      mode: undefined,
      showHelp: false,
    });
  });

  it("parses explicit start command and installed mode", () => {
    const parsed = parseCliArgs(["start", "--mode", "installed"]);

    expect(parsed).toEqual({
      command: "start",
      daemon: false,
      restart: false,
      mode: "installed",
      showHelp: false,
    });
  });

  it("parses explicit sources mode", () => {
    const parsed = parseCliArgs(["start", "--mode", "sources"]);

    expect(parsed).toEqual({
      command: "start",
      daemon: false,
      restart: false,
      mode: "sources",
      showHelp: false,
    });
  });

  it("parses daemon flag for start", () => {
    const parsed = parseCliArgs(["start", "--daemon"]);

    expect(parsed).toEqual({
      command: "start",
      daemon: true,
      restart: false,
      mode: undefined,
      showHelp: false,
    });
  });

  it("rejects unknown mode as invalid", () => {
    const parsed = parseCliArgs(["start", "--mode=invalid"]);

    expect(parsed.command).toBe("start");
    expect(parsed.daemon).toBe(false);
    expect(parsed.showHelp).toBe(true);
    expect(parsed.error).toContain("Invalid mode value");
  });

  it("shows help for unknown command", () => {
    const parsed = parseCliArgs(["deploy"]);

    expect(parsed.command).toBe("start");
    expect(parsed.daemon).toBe(false);
    expect(parsed.showHelp).toBe(true);
    expect(parsed.error).toContain("Unknown command");
  });

  it("shows help for invalid mode", () => {
    const parsed = parseCliArgs(["start", "--mode", "qa"]);

    expect(parsed.command).toBe("start");
    expect(parsed.daemon).toBe(false);
    expect(parsed.showHelp).toBe(true);
    expect(parsed.error).toContain("Invalid mode value");
  });

  it("rejects --mode for non-start commands", () => {
    const parsed = parseCliArgs(["status", "--mode", "sources"]);

    expect(parsed.command).toBe("status");
    expect(parsed.daemon).toBe(false);
    expect(parsed.showHelp).toBe(true);
    expect(parsed.error).toContain("supported only for the start command");
  });

  it("rejects --daemon for non-start commands", () => {
    const parsed = parseCliArgs(["status", "--daemon"]);

    expect(parsed.command).toBe("status");
    expect(parsed.daemon).toBe(true);
    expect(parsed.restart).toBe(false);
    expect(parsed.showHelp).toBe(true);
    expect(parsed.error).toContain("--daemon");
  });

  it("parses restart flag for start", () => {
    const parsed = parseCliArgs(["start", "--restart"]);

    expect(parsed).toEqual({
      command: "start",
      daemon: false,
      restart: true,
      mode: undefined,
      showHelp: false,
    });
  });

  it("parses restart flag with daemon", () => {
    const parsed = parseCliArgs(["start", "--restart", "--daemon"]);

    expect(parsed).toEqual({
      command: "start",
      daemon: true,
      restart: true,
      mode: undefined,
      showHelp: false,
    });
  });

  it("rejects --restart for non-start commands", () => {
    const parsed = parseCliArgs(["status", "--restart"]);

    expect(parsed.command).toBe("status");
    expect(parsed.restart).toBe(true);
    expect(parsed.showHelp).toBe(true);
    expect(parsed.error).toContain("--restart");
  });

  it("shows help when requested", () => {
    const parsed = parseCliArgs(["--help"]);

    expect(parsed).toEqual({
      command: "start",
      daemon: false,
      restart: false,
      mode: undefined,
      showHelp: true,
    });
  });
});
