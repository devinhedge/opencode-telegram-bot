import { execFile, spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/opencode-telegram-bot.service";

const SYSTEMD_SERVICE_NAME = "opencode-telegram-bot";

/** Each command runs as `sudo <command>`; the list is also printed when it cannot be run. */
export const SYSTEMD_COMMANDS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["systemctl", "stop", SYSTEMD_SERVICE_NAME]),
  Object.freeze(["systemctl", "disable", SYSTEMD_SERVICE_NAME]),
  Object.freeze(["rm", "-f", SYSTEMD_UNIT_PATH]),
  Object.freeze(["systemctl", "daemon-reload"]),
]);

export interface SystemdDeps {
  platform: NodeJS.Platform;
  /** May throw (for example EACCES); the caller reports the step as failed. */
  unitExists(): Promise<boolean>;
  hasSudo(): Promise<boolean>;
  isInteractive: boolean;
  /**
   * Runs `sudo <command>` (the command carries no `sudo` prefix) and resolves the exit code.
   * Rejects with `SudoUnavailableError` when `sudo` cannot be started.
   */
  run(command: readonly string[]): Promise<number>;
}

export type SystemdOutcome =
  "not-applicable" | "absent" | "removed" | "skipped-no-terminal" | "skipped-no-sudo" | "failed";

export interface SystemdResult {
  outcome: SystemdOutcome;
  /**
   * The commands to print: every command for the skipped outcomes; for `failed` the failing
   * command followed by the ones not yet run (steps that already succeeded are not repeated);
   * the full list for `removed`; empty for `not-applicable` and `absent`.
   */
  commands: readonly (readonly string[])[];
  failedCommand?: readonly string[] | undefined;
}

/** Thrown by `run` when `sudo` cannot be started (spawn ENOENT). */
export class SudoUnavailableError extends Error {
  constructor() {
    super("sudo could not be started");
    this.name = "SudoUnavailableError";
  }
}

/** The exact line to print for a command: `sudo` exactly once, then the arguments. */
export function formatSystemdCommand(command: readonly string[]): string {
  return ["sudo", ...command].join(" ");
}

function copyCommands(commands: readonly (readonly string[])[]): (readonly string[])[] {
  return commands.map((command) => [...command]);
}

/**
 * Removes the documented systemd unit through `sudo`. Never reads or passes a password: sudo
 * prompts on the terminal itself. Without a terminal or without `sudo`, returns the exact commands
 * so the caller can print them.
 *
 * Idempotence is file existence only: a stray running service or a dangling enable link without
 * the unit file is out of scope (spec decision 6).
 *
 * Ctrl-C during the sudo prompt can leave a partial state (service stopped, disabled, unit file
 * still present). The result is then `failed` with the failing command and the remaining ones.
 */
export async function removeSystemdUnit(deps: SystemdDeps): Promise<SystemdResult> {
  if (deps.platform !== "linux") {
    return { outcome: "not-applicable", commands: [] };
  }

  if (!(await deps.unitExists())) {
    return { outcome: "absent", commands: [] };
  }

  if (!deps.isInteractive) {
    return { outcome: "skipped-no-terminal", commands: copyCommands(SYSTEMD_COMMANDS) };
  }

  if (!(await deps.hasSudo())) {
    return { outcome: "skipped-no-sudo", commands: copyCommands(SYSTEMD_COMMANDS) };
  }

  for (const [index, command] of SYSTEMD_COMMANDS.entries()) {
    const remaining = copyCommands(SYSTEMD_COMMANDS.slice(index));
    let exitCode: number;
    try {
      exitCode = await deps.run(command);
    } catch (error) {
      if (error instanceof SudoUnavailableError) {
        return { outcome: "skipped-no-sudo", commands: remaining };
      }
      throw error;
    }

    if (exitCode !== 0) {
      return { outcome: "failed", commands: remaining, failedCommand: [...command] };
    }
  }

  return { outcome: "removed", commands: copyCommands(SYSTEMD_COMMANDS) };
}

/** Injectable system access for `defaultSystemdDeps`; tests replace these, never the real ones. */
export interface SystemdIo {
  unitPath: string;
  lstat: (path: string) => Promise<unknown>;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  execFile: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
    callback: (error: Error | null) => void,
  ) => unknown;
  env: NodeJS.ProcessEnv;
  isTerminal: () => boolean;
}

const realIo: SystemdIo = {
  unitPath: SYSTEMD_UNIT_PATH,
  lstat,
  spawn,
  execFile: (file, args, options, callback) => execFile(file, args, options, callback),
  env: process.env,
  isTerminal: () => Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
};

/** Only these variables reach sudo, so SUDO_ASKPASS and SUDO_PROMPT are never inherited. */
function minimalEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TERM", "LANG", "LC_ALL"]) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

const SYSTEMCTL_SHOW_TIMEOUT_MS = 5000;

/** Runs a command without a shell and resolves its stdout; rejects on any error. */
export type ExecFileText = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<string>;

export interface SystemdMainPidDeps {
  platform: NodeJS.Platform;
  /** May throw; a throw gives null. */
  unitExists(): Promise<boolean>;
  execFileText: ExecFileText;
  env: NodeJS.ProcessEnv;
}

/**
 * The main pid of the documented unit, read with `systemctl show` (no sudo, no shell, minimal
 * environment, short timeout), so a bot run by systemd is stopped through the unit and never
 * asked about as a separate process. Null off Linux, without the unit, for 0 or empty output,
 * and on any error.
 */
export async function getSystemdMainPid(deps: SystemdMainPidDeps): Promise<number | null> {
  if (deps.platform !== "linux") {
    return null;
  }

  try {
    if (!(await deps.unitExists())) {
      return null;
    }
    const stdout = await deps.execFileText(
      "systemctl",
      ["show", "-p", "MainPID", "--value", SYSTEMD_SERVICE_NAME],
      { env: minimalEnv(deps.env), timeout: SYSTEMCTL_SHOW_TIMEOUT_MS },
    );
    const text = stdout.trim();
    if (!/^\d+$/.test(text)) {
      return null;
    }
    const pid = Number.parseInt(text, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const realExecFileText: ExecFileText = async (file, args, options) =>
  (await promisify(execFile)(file, [...args], options)).stdout;

/** Real dependencies for getSystemdMainPid; tests inject their own. */
export function defaultSystemdMainPidDeps(
  systemd: Pick<SystemdDeps, "unitExists">,
): SystemdMainPidDeps {
  return {
    platform: process.platform,
    unitExists: () => systemd.unitExists(),
    execFileText: realExecFileText,
    env: process.env,
  };
}

export function defaultSystemdDeps(overrides: Partial<SystemdIo> = {}): SystemdDeps {
  const io: SystemdIo = { ...realIo, ...overrides };

  return {
    platform: process.platform,
    // lstat so a dangling symlink at the unit path counts as present. Only ENOENT and ENOTDIR
    // mean absent; any other error (EACCES, ...) is rethrown.
    unitExists: async () => {
      try {
        await io.lstat(io.unitPath);
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") {
          return false;
        }
        throw error;
      }
    },
    // `sudo --version` never prompts; a spawn failure or non-zero exit means no usable sudo.
    hasSudo: () =>
      new Promise<boolean>((resolve) => {
        io.execFile("sudo", ["--version"], { env: minimalEnv(io.env) }, (error) =>
          resolve(error === null),
        );
      }),
    // Requires stdin and stdout to be terminals (conservative; sudo itself reads /dev/tty).
    // A getter, so the state is read when the removal runs rather than at construction.
    get isInteractive() {
      return io.isTerminal();
    },
    run: (command) =>
      new Promise<number>((resolve, reject) => {
        // Inherited stdio lets sudo prompt on the terminal; no password is read or passed here.
        const child = io.spawn("sudo", [...command], {
          stdio: "inherit",
          env: minimalEnv(io.env),
        });
        child.on("error", (error) => {
          if (errorCode(error) === "ENOENT") {
            reject(new SudoUnavailableError());
          } else {
            resolve(1);
          }
        });
        // A null code means the child was killed by a signal: treated as failed.
        child.on("close", (code) => resolve(code ?? 1));
      }),
  };
}
