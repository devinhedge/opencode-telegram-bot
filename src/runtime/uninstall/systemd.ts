import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";

export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/opencode-telegram-bot.service";

const SYSTEMD_SERVICE_NAME = "opencode-telegram-bot";

/** Each command runs as `sudo <command>`; the list is also printed when it cannot be run. */
export const SYSTEMD_COMMANDS: readonly (readonly string[])[] = [
  ["systemctl", "stop", SYSTEMD_SERVICE_NAME],
  ["systemctl", "disable", SYSTEMD_SERVICE_NAME],
  ["rm", "-f", SYSTEMD_UNIT_PATH],
  ["systemctl", "daemon-reload"],
];

export interface SystemdDeps {
  platform: NodeJS.Platform;
  unitExists(): Promise<boolean>;
  hasSudo(): Promise<boolean>;
  isInteractive: boolean;
  /** Runs `sudo <command>` and resolves the exit code. */
  run(command: readonly string[]): Promise<number>;
}

export type SystemdOutcome =
  | "not-applicable"
  | "absent"
  | "removed"
  | "skipped-no-terminal"
  | "skipped-no-sudo"
  | "failed";

export interface SystemdResult {
  outcome: SystemdOutcome;
  commands: readonly (readonly string[])[];
  failedCommand?: readonly string[] | undefined;
}

/**
 * Removes the documented systemd unit through `sudo`. Never reads or passes a password: sudo
 * prompts on the terminal itself. Without a terminal or without `sudo`, returns the exact commands
 * so the caller can print them.
 */
export async function removeSystemdUnit(deps: SystemdDeps): Promise<SystemdResult> {
  if (deps.platform !== "linux") {
    return { outcome: "not-applicable", commands: [] };
  }

  if (!(await deps.unitExists())) {
    return { outcome: "absent", commands: [] };
  }

  if (!deps.isInteractive) {
    return { outcome: "skipped-no-terminal", commands: SYSTEMD_COMMANDS };
  }

  if (!(await deps.hasSudo())) {
    return { outcome: "skipped-no-sudo", commands: SYSTEMD_COMMANDS };
  }

  for (const command of SYSTEMD_COMMANDS) {
    const exitCode = await deps.run(command);
    if (exitCode !== 0) {
      return { outcome: "failed", commands: SYSTEMD_COMMANDS, failedCommand: command };
    }
  }

  return { outcome: "removed", commands: SYSTEMD_COMMANDS };
}

export function defaultSystemdDeps(): SystemdDeps {
  return {
    platform: process.platform,
    unitExists: async () => {
      try {
        await access(SYSTEMD_UNIT_PATH);
        return true;
      } catch {
        return false;
      }
    },
    hasSudo: () =>
      new Promise<boolean>((resolve) => {
        execFile("which", ["sudo"], (error) => resolve(error === null));
      }),
    isInteractive: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
    run: (command) =>
      new Promise<number>((resolve) => {
        // Inherited stdio lets sudo prompt on the terminal; no password is read or passed here.
        const child = spawn("sudo", [...command], { stdio: "inherit" });
        child.on("error", () => resolve(1));
        child.on("close", (code) => resolve(code ?? 1));
      }),
  };
}
