import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { config, type OpencodeServerMode, type OpencodeServerVersion } from "../config.js";
import { logger } from "../utils/logger.js";
import type { LocalOpencodeTarget } from "./process-control.js";

const execFileAsync = promisify(execFile);
/** Stand-only. Not a published setting: the e2e launcher sets it, production does not. */
const STAND_SERVER_PID_ENV = "OPENCODE_STAND_PID_FILE";
const VERSION_READ_TIMEOUT_MS = 10_000;

export interface OpencodeServeSpawnCommand {
  command: string;
  args: string[];
  windowsHide: boolean;
}

/** The exe an npm `.cmd` shim runs, e.g. `"%dp0%\node_modules\@opencode\cli\bin\opencode.exe"`. */
export function readNpmShimTarget(shimPath: string): string | null {
  try {
    const match = /"%~?dp0%?\\([^"]+?\.exe)"/i.exec(readFileSync(shimPath, "utf8"));
    const relativeTarget = match?.[1];
    return relativeTarget ? path.join(path.dirname(shimPath), ...relativeTarget.split("\\")) : null;
  } catch {
    return null;
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) {
      return false;
    }
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Set it to an absolute executable path to override the search below. */
const OPENCODE_BIN_PATH_ENV = "OPENCODE_BIN_PATH";

/** Directories the installers and package managers use, not a service PATH. */
const POSIX_OPENCODE_FALLBACK_DIRS = [
  path.join(".opencode", "bin"),
  path.join(".local", "bin"),
  path.join(".npm-global", "bin"),
  path.join(".bun", "bin"),
  path.join(".local", "share", "pnpm"),
  path.join("Library", "pnpm"),
  path.join(".yarn", "bin"),
  path.join(".config", "yarn", "global", "bin"),
];

const POSIX_OPENCODE_FALLBACK_PATHS = [
  "/usr/local/bin/opencode",
  "/opt/homebrew/bin/opencode",
  "/usr/bin/opencode",
];

/**
 * The `opencode` command to run on Linux and macOS. An explicit
 * `OPENCODE_BIN_PATH` wins, then PATH keeps precedence, so the bot starts
 * whichever opencode the shell would. Service managers (systemd, cron, a desktop
 * launcher) start the bot with a PATH that usually lacks the installer's
 * directory, so fall back to the places the installers and package managers use.
 */
export function resolvePosixOpencodeExecutable(): string {
  const configured = process.env[OPENCODE_BIN_PATH_ENV]?.trim();
  // Only an absolute path: a relative value would let spawn resolve the bare
  // name through PATH and start a different executable than the one checked here.
  if (configured && path.isAbsolute(configured) && isExecutableFile(configured)) {
    return configured;
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    if (isExecutableFile(path.join(entry, "opencode"))) {
      return "opencode";
    }
  }

  const home = os.homedir();
  for (const relativeDir of POSIX_OPENCODE_FALLBACK_DIRS) {
    const candidate = path.join(home, relativeDir, "opencode");
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  for (const candidate of POSIX_OPENCODE_FALLBACK_PATHS) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return "opencode";
}

function resolveWindowsOpencodeExe(): string {
  const pathEnv = process.env.PATH ?? "";
  const pathEntries = pathEnv.split(path.delimiter).filter(Boolean);

  // First pass: look for opencode.exe directly on PATH.
  // Covers non-npm installations (install script, scoop, choco, manual download, etc.).
  for (const entry of pathEntries) {
    const candidateExe = path.join(entry, "opencode.exe");
    if (existsSync(candidateExe)) {
      return candidateExe;
    }
  }

  // Second pass: look for opencode.cmd (npm global install).
  // Follow the shim to the exe it runs: V1 (opencode-ai) and V2 (@opencode/cli) both
  // install an `opencode` shim, so the package cannot be guessed from the name.
  for (const entry of pathEntries) {
    const opencodeCmd = path.join(entry, "opencode.cmd");
    if (!existsSync(opencodeCmd)) {
      continue;
    }

    const shimTarget = readNpmShimTarget(opencodeCmd);
    if (shimTarget && existsSync(shimTarget)) {
      return shimTarget;
    }

    const candidateExe = path.join(entry, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(candidateExe)) {
      return candidateExe;
    }

    // Found the shim but not the exe where it usually lives. Stop searching.
    break;
  }

  return "";
}

/** The local `opencode` executable with the given arguments, resolved per platform. */
function createOpencodeCommand(args: string[]): OpencodeServeSpawnCommand {
  let command: OpencodeServeSpawnCommand;

  if (process.platform === "win32") {
    const resolvedExe = resolveWindowsOpencodeExe();

    command = resolvedExe
      ? { command: resolvedExe, args, windowsHide: true }
      : // Safe fallback: works with default npm installs where only opencode.cmd is on PATH.
        { command: "cmd.exe", args: ["/c", "opencode", ...args], windowsHide: true };
  } else {
    command = { command: resolvePosixOpencodeExecutable(), args, windowsHide: false };
  }

  logger.debug(`[OpenCode] Using executable: ${command.command}`);
  return command;
}

/**
 * V1 and V2 standalone run a plain server. V2 service mode runs the registered
 * background server (`--service`) so a regular V2 CLI connects to it. The port
 * applies to this launch only. The child inherits the bot environment, which is
 * how a standalone server receives OPENCODE_SERVER_PASSWORD.
 */
export function createOpencodeServeSpawnCommand(
  target: LocalOpencodeTarget,
  version: OpencodeServerVersion,
  mode: OpencodeServerMode = config.opencode.serverMode,
): OpencodeServeSpawnCommand {
  const port = target.port.toString();
  const serveArgs = version === "v2" && mode === "service" ? ["serve", "--service"] : ["serve"];
  return createOpencodeCommand([...serveArgs, "--port", port]);
}

function standServerPidFile(): string | null {
  const pidFile = process.env[STAND_SERVER_PID_ENV]?.trim();
  return pidFile || null;
}

/** Records the server this process just spawned, so stand teardown can tell it from a stranger on the same port. */
export function recordStandServerPid(pid: number | undefined): void {
  const pidFile = standServerPidFile();
  if (!pidFile || !pid) {
    return;
  }

  mkdirSync(path.dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${pid}\n`, "utf8");
}

/** Drops the record only when the stopped pid is the one the stand started. */
export function clearStandServerPid(pid: number): void {
  const pidFile = standServerPidFile();
  if (!pidFile) {
    return;
  }

  let recorded = "";
  try {
    recorded = readFileSync(pidFile, "utf8").trim();
  } catch {
    return;
  }

  if (recorded !== String(pid)) {
    return;
  }

  rmSync(pidFile, { force: true });
}

export function parseOpencodeVersionOutput(stdout: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
}

/** OpenCode 2.x serves the V2 API; earlier releases serve V1. */
export function getOpencodeApiVersion(version: string): OpencodeServerVersion {
  const major = Number.parseInt(version, 10);
  return major >= 2 ? "v2" : "v1";
}

/** Version of the local `opencode` executable, or null when it cannot be read. */
export async function readLocalOpencodeVersion(): Promise<string | null> {
  const versionCommand = createOpencodeCommand(["--version"]);
  try {
    const { stdout } = await execFileAsync(versionCommand.command, versionCommand.args, {
      timeout: VERSION_READ_TIMEOUT_MS,
      windowsHide: versionCommand.windowsHide,
    });
    return parseOpencodeVersionOutput(stdout);
  } catch {
    return null;
  }
}

export function startLocalOpencodeServer(
  target: LocalOpencodeTarget,
  version: OpencodeServerVersion,
): ChildProcess {
  const spawnCommand = createOpencodeServeSpawnCommand(target, version);

  const child = spawn(spawnCommand.command, spawnCommand.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: spawnCommand.windowsHide,
  });
  recordStandServerPid(child.pid);
  return child;
}

export {
  DEFAULT_OPENCODE_API_URLS,
  findServerPid,
  findUnixListeningPidInSs,
  findWindowsListeningPidInNetstat,
  getProcessCommandLine,
  killServerProcess,
  resolveLocalOpencodeTarget,
  type LocalOpencodeTarget,
} from "./process-control.js";
