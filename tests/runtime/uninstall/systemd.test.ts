import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEMD_COMMANDS,
  SYSTEMD_UNIT_PATH,
  SudoUnavailableError,
  defaultSystemdDeps,
  formatSystemdCommand,
  removeSystemdUnit,
  type SystemdDeps,
  type SystemdIo,
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

  it("freezes the command list and every command", () => {
    expect(Object.isFrozen(SYSTEMD_COMMANDS)).toBe(true);
    for (const command of SYSTEMD_COMMANDS) {
      expect(Object.isFrozen(command)).toBe(true);
    }
  });

  it("formats a command with sudo exactly once", () => {
    expect(formatSystemdCommand(["systemctl", "daemon-reload"])).toBe(
      "sudo systemctl daemon-reload",
    );
    expect(formatSystemdCommand(SYSTEMD_COMMANDS[2]!)).toBe(`sudo rm -f ${SYSTEMD_UNIT_PATH}`);
  });

  it.each(["darwin", "win32"] as const)("is not applicable on %s", async (platform) => {
    const deps = createDeps({ platform });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("not-applicable");
    expect(result.commands).toEqual([]);
    expect(deps.unitExists).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("reports absent with no commands when the unit file does not exist", async () => {
    const deps = createDeps({ unitExists: vi.fn(async () => false) });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("absent");
    expect(result.commands).toEqual([]);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("reports absent, not skipped-no-terminal, when there is no terminal and no unit", async () => {
    const deps = createDeps({ unitExists: vi.fn(async () => false), isInteractive: false });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("absent");
  });

  it("runs the four commands in order, without a sudo prefix, and reports removed", async () => {
    const deps = createDeps();

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("removed");
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    const received = vi.mocked(deps.run).mock.calls.map((call) => call[0]);
    expect(received).toEqual(SYSTEMD_COMMANDS);
    for (const command of received) {
      expect(command[0]).not.toBe("sudo");
    }
  });

  it("returns copies, so a caller cannot change the constant", async () => {
    const result = await removeSystemdUnit(createDeps());

    expect(result.commands).not.toBe(SYSTEMD_COMMANDS);
    expect(result.commands[0]).not.toBe(SYSTEMD_COMMANDS[0]);
  });

  it("returns the commands without running them when there is no terminal", async () => {
    const deps = createDeps({ isInteractive: false });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("skipped-no-terminal");
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    expect(deps.hasSudo).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("returns the commands without running them when sudo is missing", async () => {
    const deps = createDeps({ hasSudo: vi.fn(async () => false) });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("skipped-no-sudo");
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("reports skipped-no-sudo, not failed, when run cannot start sudo", async () => {
    const deps = createDeps({
      run: vi.fn(async () => {
        throw new SudoUnavailableError();
      }),
    });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("skipped-no-sudo");
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
  });

  it("propagates an unexpected error from run", async () => {
    const deps = createDeps({
      run: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(removeSystemdUnit(deps)).rejects.toThrow("boom");
  });

  it("propagates an error from unitExists so the caller reports the step as failed", async () => {
    const deps = createDeps({
      unitExists: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });

    await expect(removeSystemdUnit(deps)).rejects.toThrow("EACCES");
  });

  it("stops at the second command and returns it with the commands not yet run", async () => {
    const run = vi.fn(async (command: readonly string[]) =>
      command.join(" ") === SYSTEMD_COMMANDS[1]!.join(" ") ? 1 : 0,
    );
    const deps = createDeps({ run });

    const result = await removeSystemdUnit(deps);

    expect(result.outcome).toBe("failed");
    expect(result.failedCommand).toEqual(SYSTEMD_COMMANDS[1]);
    expect(result.commands).toEqual(SYSTEMD_COMMANDS.slice(1));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails on the first command with every command remaining", async () => {
    const run = vi.fn(async () => 1);

    const result = await removeSystemdUnit(createDeps({ run }));

    expect(result.outcome).toBe("failed");
    expect(result.failedCommand).toEqual(SYSTEMD_COMMANDS[0]);
    expect(result.commands).toEqual(SYSTEMD_COMMANDS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails on the last command (daemon-reload) with only it remaining", async () => {
    const run = vi.fn(async (command: readonly string[]) =>
      command[1] === "daemon-reload" ? 1 : 0,
    );

    const result = await removeSystemdUnit(createDeps({ run }));

    expect(result.outcome).toBe("failed");
    expect(result.failedCommand).toEqual(["systemctl", "daemon-reload"]);
    expect(result.commands).toEqual([["systemctl", "daemon-reload"]]);
    expect(run).toHaveBeenCalledTimes(4);
  });
});

describe("runtime/uninstall/systemd defaultSystemdDeps", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "systemd-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function unitDeps(unitPath: string, lstatFn: SystemdIo["lstat"] = lstat) {
    return defaultSystemdDeps({ unitPath, lstat: lstatFn });
  }

  it("reports a regular file as present and a missing file as absent", async () => {
    const present = path.join(tempDir, "present.service");
    await writeFile(present, "x");

    expect(await unitDeps(present).unitExists()).toBe(true);
    expect(await unitDeps(path.join(tempDir, "missing.service")).unitExists()).toBe(false);
  });

  it("reports absent when a parent of the path is not a directory (ENOTDIR)", async () => {
    const file = path.join(tempDir, "file");
    await writeFile(file, "x");

    expect(await unitDeps(path.join(file, "unit.service")).unitExists()).toBe(false);
  });

  it.skipIf(process.platform === "win32")("reports a dangling symlink as present", async () => {
    const link = path.join(tempDir, "dangling.service");
    await symlink(path.join(tempDir, "nowhere"), link);

    expect(await unitDeps(link).unitExists()).toBe(true);
  });

  it("rethrows an error that is not ENOENT or ENOTDIR", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const deps = unitDeps(
      "/unused",
      vi.fn(async () => {
        throw denied;
      }),
    );

    await expect(deps.unitExists()).rejects.toBe(denied);
  });

  it("depends on whether stdin and stdout are terminals, read at each access", () => {
    let terminal = false;
    const deps = defaultSystemdDeps({ isTerminal: () => terminal });

    expect(deps.isInteractive).toBe(false);
    terminal = true;
    expect(deps.isInteractive).toBe(true);
  });

  function fakeChild(): ChildProcess {
    return new EventEmitter() as ChildProcess;
  }

  const hostileEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    TERM: "xterm",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    SUDO_ASKPASS: "/bin/steal",
    SUDO_PROMPT: "give me",
    SECRET: "x",
  };

  it("runs sudo with an argument array, inherited stdio, and a minimal environment", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const deps = defaultSystemdDeps({ spawn: spawnFn, env: hostileEnv });

    const pending = deps.run(SYSTEMD_COMMANDS[0]!);
    child.emit("close", 0);

    expect(await pending).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { stdio: string; env: NodeJS.ProcessEnv },
    ];
    expect(file).toBe("sudo");
    expect(args).toEqual(SYSTEMD_COMMANDS[0]);
    expect(options.stdio).toBe("inherit");
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
    });
  });

  it("omits LC_ALL and other variables that are unset", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const deps = defaultSystemdDeps({ spawn: spawnFn, env: { PATH: "/bin", HOME: "/h" } });

    const pending = deps.run(["rm", "-f", "x"]);
    child.emit("close", 0);
    await pending;

    const options = (spawnFn.mock.calls[0] as unknown as [string, string[], { env: object }])[2];
    expect(options.env).toEqual({ PATH: "/bin" });
  });

  it("resolves the exit code of a non-zero exit", async () => {
    const child = fakeChild();
    const deps = defaultSystemdDeps({ spawn: () => child, env: {} });

    const pending = deps.run(["rm", "-f", "x"]);
    child.emit("close", 3);

    expect(await pending).toBe(3);
  });

  it("treats a child killed by a signal (null code) as failed", async () => {
    const child = fakeChild();
    const deps = defaultSystemdDeps({ spawn: () => child, env: {} });

    const pending = deps.run(["rm", "-f", "x"]);
    child.emit("close", null);

    expect(await pending).not.toBe(0);
  });

  it("rejects with SudoUnavailableError when spawn reports ENOENT", async () => {
    const child = fakeChild();
    const deps = defaultSystemdDeps({ spawn: () => child, env: {} });

    const pending = deps.run(["rm", "-f", "x"]);
    child.emit("error", Object.assign(new Error("spawn sudo ENOENT"), { code: "ENOENT" }));

    await expect(pending).rejects.toBeInstanceOf(SudoUnavailableError);
  });

  it("treats another spawn error as a failed run", async () => {
    const child = fakeChild();
    const deps = defaultSystemdDeps({ spawn: () => child, env: {} });

    const pending = deps.run(["rm", "-f", "x"]);
    child.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }));

    expect(await pending).not.toBe(0);
  });

  it("probes sudo with --version and a minimal environment, never through a shell", async () => {
    const execFileFn = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: { env: NodeJS.ProcessEnv },
        callback: (error: Error | null) => void,
      ) => callback(null),
    );
    const deps = defaultSystemdDeps({ execFile: execFileFn, env: hostileEnv });

    expect(await deps.hasSudo()).toBe(true);
    const [file, args, options] = execFileFn.mock.calls[0]!;
    expect(file).toBe("sudo");
    expect(args).toEqual(["--version"]);
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
    });
    expect(options.env).not.toHaveProperty("SUDO_ASKPASS");
    expect(options.env).not.toHaveProperty("SUDO_PROMPT");
  });

  it("settles a run once when the child emits both error and close", async () => {
    const child = fakeChild();
    const deps = defaultSystemdDeps({ spawn: () => child, env: {} });

    const pending = deps.run(["rm", "-f", "x"]);
    // A promise settles once, so the first event wins.
    child.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }));
    child.emit("close", 0);

    expect(await pending).toBe(1);
  });

  it("reports no sudo when the probe fails", async () => {
    const deps = defaultSystemdDeps({
      execFile: (_file, _args, _options, callback) => callback(new Error("ENOENT")),
      env: {},
    });

    expect(await deps.hasSudo()).toBe(false);
  });
});
