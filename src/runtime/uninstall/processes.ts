import { execFile, execFileSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const PS_TIMEOUT_MS = 5000;
const LSOF_TIMEOUT_MS = 5000;
const NPM_ROOT_TIMEOUT_MS = 5000;
const PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const NODE_BINARIES = new Set(["node", "nodejs"]);
const GLOBAL_PACKAGE_NAME = "@grinev/opencode-telegram-bot";
const CLI_ENTRY_BASENAME = "cli.js";
const CLI_START_SUBCOMMAND = "start";

// pid ppid user lstart(Www Mmm dd hh:mm:ss yyyy) args
const PS_LINE_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;

export interface RawProcess {
  pid: number;
  ppid: number;
  user: string;
  startedAt: string;
  args: string;
}

export interface BotProcess {
  pid: number;
  user: string;
  startedAt: string;
  commandLine: string;
  /** False when the script path is relative and the process cwd could not be read. */
  verified: boolean;
}

export interface ScanDeps {
  listProcesses(): Promise<RawProcess[]>;
  realpath(p: string): Promise<string>;
  cwdOf(pid: number): Promise<string | null>;
  entryPoints: readonly string[];
  ownPid: number;
  excludePids: readonly number[];
}

/** Parses `ps -axo pid=,ppid=,user=,lstart=,args=` output; empty and malformed lines are dropped. */
export function parseProcessList(output: string): RawProcess[] {
  const processes: RawProcess[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = PS_LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }

    const [, pidText, ppidText, user, startedAt, args] = match;
    const pid = Number.parseInt(pidText ?? "", 10);
    const ppid = Number.parseInt(ppidText ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !user || !startedAt || !args) {
      continue;
    }

    processes.push({ pid, ppid, user, startedAt, args });
  }

  return processes;
}

function collectOwnChain(processes: readonly RawProcess[], ownPid: number): Set<number> {
  const parentOf = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const chain = new Set<number>([ownPid]);

  let current = parentOf.get(ownPid);
  while (current !== undefined && current > 0 && !chain.has(current)) {
    chain.add(current);
    current = parentOf.get(current);
  }

  return chain;
}

async function realpathOrLexical(deps: ScanDeps, target: string): Promise<string> {
  try {
    return await deps.realpath(target);
  } catch {
    return target;
  }
}

interface ScriptInvocation {
  script: string;
  nextArgument: string | undefined;
}

/** The script of a `node` command line (first non-option argument), or null for any other command. */
function parseNodeInvocation(args: string): ScriptInvocation | null {
  const tokens = args.trim().split(/\s+/);
  const argv0 = tokens[0];
  if (!argv0 || !NODE_BINARIES.has(path.basename(argv0))) {
    return null;
  }

  const scriptIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith("-"));
  const script = tokens[scriptIndex];
  if (scriptIndex < 0 || !script) {
    return null;
  }

  return { script, nextArgument: tokens[scriptIndex + 1] };
}

function entryAcceptsArgument(entryPoint: string, nextArgument: string | undefined): boolean {
  return path.basename(entryPoint) !== CLI_ENTRY_BASENAME || nextArgument === CLI_START_SUBCOMMAND;
}

async function matchEntryPoint(
  deps: ScanDeps,
  pid: number,
  invocation: ScriptInvocation,
): Promise<{ matched: boolean; verified: boolean }> {
  const { script, nextArgument } = invocation;
  const noMatch = { matched: false, verified: true };

  const isAbsolute = path.isAbsolute(script);
  const cwd = isAbsolute ? null : await deps.cwdOf(pid);

  if (isAbsolute || cwd !== null) {
    const lexical = cwd === null ? path.normalize(script) : path.resolve(cwd, script);
    const real = await realpathOrLexical(deps, lexical);

    for (const entryPoint of deps.entryPoints) {
      const entryReal = await realpathOrLexical(deps, entryPoint);
      const sameFile = [lexical, real].some((c) => c === entryPoint || c === entryReal);
      if (sameFile && entryAcceptsArgument(entryPoint, nextArgument)) {
        return { matched: true, verified: true };
      }
    }

    return noMatch;
  }

  // Relative script and unknown cwd: accept only a script that is a path suffix of an entry point.
  const relative = path.normalize(script);
  if (relative.startsWith("..")) {
    return noMatch;
  }

  const suffixMatch = deps.entryPoints.some(
    (entryPoint) =>
      entryPoint.endsWith(path.sep + relative) && entryAcceptsArgument(entryPoint, nextArgument),
  );

  return { matched: suffixMatch, verified: false };
}

/**
 * Finds bots running outside the daemon: `node` processes whose first script argument is an entry
 * point (`cli.js` only with `start`). The own pid, its ancestors, and `excludePids` are never
 * returned. Reads only the injected dependencies.
 */
export async function findBotProcesses(deps: ScanDeps): Promise<BotProcess[]> {
  const processes = await deps.listProcesses();
  const excluded = collectOwnChain(processes, deps.ownPid);
  for (const pid of deps.excludePids) {
    excluded.add(pid);
  }

  const found: BotProcess[] = [];
  for (const entry of processes) {
    if (excluded.has(entry.pid)) {
      continue;
    }

    const invocation = parseNodeInvocation(entry.args);
    if (!invocation) {
      continue;
    }

    const { matched, verified } = await matchEntryPoint(deps, entry.pid, invocation);
    if (matched) {
      found.push({
        pid: entry.pid,
        user: entry.user,
        startedAt: entry.startedAt,
        commandLine: entry.args,
        verified,
      });
    }
  }

  return found;
}

function entryPointsOf(root: string): string[] {
  return [path.join(root, "dist", "cli.js"), path.join(root, "dist", "index.js")];
}

function globalPackageRoot(): string | null {
  if (process.platform === "win32") {
    return null;
  }

  try {
    const globalNodeModules = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: NPM_ROOT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return globalNodeModules ? path.join(globalNodeModules, GLOBAL_PACKAGE_NAME) : null;
  } catch {
    return null;
  }
}

async function listProcessesWithPs(): Promise<RawProcess[]> {
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,user=,lstart=,args="], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER_BYTES,
    env: { ...process.env, LC_ALL: "C" },
  });
  return parseProcessList(stdout);
}

async function cwdWithLsof(pid: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { timeout: LSOF_TIMEOUT_MS },
    );
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("n"));
    const cwd = line?.slice(1) ?? "";
    return cwd || null;
  } catch {
    return null;
  }
}

/** Real dependencies: `ps`, `fs.realpath`, and `lsof` (macOS and Linux). */
export function defaultScanDeps(packageRoots: readonly string[]): ScanDeps {
  const roots = [...packageRoots];
  const globalRoot = globalPackageRoot();
  if (globalRoot) {
    roots.push(globalRoot);
  }

  return {
    listProcesses: listProcessesWithPs,
    realpath: (target) => fsPromises.realpath(target),
    cwdOf: cwdWithLsof,
    entryPoints: roots.flatMap(entryPointsOf),
    ownPid: process.pid,
    excludePids: [],
  };
}
