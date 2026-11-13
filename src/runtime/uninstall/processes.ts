import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseCliArgs } from "../../cli/args.js";
import { getProcessCommandLine } from "../../opencode/process-control.js";

const PS_TIMEOUT_MS = 5000;
const LSOF_TIMEOUT_MS = 5000;
const NPM_ROOT_TIMEOUT_MS = 5000;
const PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const NODE_BINARIES = new Set(["node", "nodejs"]);
const GLOBAL_PACKAGE_NAME = "@grinev/opencode-telegram-bot";
const CLI_ENTRY_BASENAME = "cli.js";
const MIN_RELATIVE_SCRIPT_COMPONENTS = 2;

// node options whose next argument is a value, not the script.
const NODE_OPTIONS_WITH_VALUE = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
]);

// Known node flags that take no value. Before the script only these, the value-taking options
// above, and `-x=value` forms are allowed; any other option makes the script undeterminable
// (it could take a separate value), so the process is not matched (a safe false negative).
const NODE_FLAGS_WITHOUT_VALUE = new Set([
  "--no-warnings",
  "--enable-source-maps",
  "--trace-warnings",
  "--trace-deprecation",
  "--trace-uncaught",
  "--no-deprecation",
  "--preserve-symlinks",
  "--experimental-vm-modules",
  "--expose-gc",
  "--harmony",
]);

// node options after which no script file runs at all.
const NODE_OPTIONS_WITHOUT_SCRIPT = new Set(["-e", "--eval", "-p", "--print", "-pe"]);

const PS_COLUMNS_WITH_START = "pid=,ppid=,uid=,user=,lstart=,args=";
const PS_COLUMNS_WITHOUT_START = "pid=,ppid=,uid=,user=,args=";

// pid ppid uid user [lstart: Www Mmm dd hh:mm:ss yyyy] args
const PS_LINE_WITH_START =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;
const PS_LINE_WITHOUT_START = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/;

export interface RawProcess {
  pid: number;
  ppid: number;
  uid: number;
  user: string;
  /** Null when `ps` has no `lstart` column (BusyBox). */
  startedAt: string | null;
  args: string;
}

export interface BotProcess {
  pid: number;
  user: string;
  startedAt: string | null;
  commandLine: string;
  /** False when the script path is relative and the process cwd could not be read. */
  verified: boolean;
}

export interface ScanDeps {
  listProcesses(): Promise<RawProcess[]>;
  realpath(p: string): Promise<string>;
  cwdOf(pid: number): Promise<string | null>;
  commandLine(pid: number): Promise<string | null>;
  entryPoints: readonly string[];
  ownPid: number;
  ownPpid: number;
  /** Only processes of this uid are scanned; null (no uid on the platform) scans nothing. */
  currentUid: number | null;
  excludePids: readonly number[];
}

export type ReverifyDeps = Pick<
  ScanDeps,
  "realpath" | "cwdOf" | "commandLine" | "entryPoints" | "ownPid" | "excludePids"
>;

/**
 * Parses `ps -axo pid=,ppid=,uid=,user=,lstart=,args=` output (`withStartTime: false` parses the
 * output without the `lstart` column and sets `startedAt` to null). Empty and malformed lines are
 * dropped. A pid that appears on more than one row is dropped entirely: an argv with an embedded
 * newline could forge a row for another pid, and an ambiguous pid must never be listed.
 */
export function parseProcessList(output: string, withStartTime = true): RawProcess[] {
  const rows = new Map<number, RawProcess | null>();

  for (const line of output.split(/\r?\n/)) {
    const row = parseProcessRow(line, withStartTime);
    if (!row) {
      continue;
    }

    rows.set(row.pid, rows.has(row.pid) ? null : row);
  }

  return [...rows.values()].filter((row): row is RawProcess => row !== null);
}

function parseProcessRow(line: string, withStartTime: boolean): RawProcess | null {
  const match = (withStartTime ? PS_LINE_WITH_START : PS_LINE_WITHOUT_START).exec(line);
  if (!match) {
    return null;
  }

  const pid = Number.parseInt(match[1] ?? "", 10);
  const ppid = Number.parseInt(match[2] ?? "", 10);
  const uid = Number.parseInt(match[3] ?? "", 10);
  const user = match[4];
  const startedAt = withStartTime ? (match[5] ?? null) : null;
  const args = match[withStartTime ? 6 : 5];
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(uid)) {
    return null;
  }
  if (!user || !args || (withStartTime && !startedAt)) {
    return null;
  }

  return { pid, ppid, uid, user, startedAt, args };
}

/**
 * The own pid, its ancestors, and the own parent. Fails closed: a listing without the own pid
 * throws, because the chain cannot be known and nothing may be listed.
 */
export function collectOwnChain(
  processes: readonly RawProcess[],
  ownPid: number,
  ownPpid: number,
): Set<number> {
  const parentOf = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  if (!parentOf.has(ownPid)) {
    throw new Error(`Process listing does not contain the own pid ${ownPid}; cannot scan safely`);
  }

  const chain = new Set<number>([ownPid]);
  let current = parentOf.get(ownPid);
  while (current !== undefined && current > 0 && !chain.has(current)) {
    chain.add(current);
    current = parentOf.get(current);
  }

  chain.add(ownPpid);
  return chain;
}

async function realpathOrLexical(deps: ReverifyDeps, target: string): Promise<string> {
  try {
    return await deps.realpath(target);
  } catch {
    return target;
  }
}

interface ResolvedEntry {
  entryPoint: string;
  real: string;
}

async function resolveEntryPoints(deps: ReverifyDeps): Promise<ResolvedEntry[]> {
  return Promise.all(
    deps.entryPoints.map(async (entryPoint) => ({
      entryPoint,
      real: await realpathOrLexical(deps, entryPoint),
    })),
  );
}

interface ScriptInvocation {
  script: string;
  scriptArgs: string[];
}

/**
 * The script of a `node` command line, or null for any other command and whenever the script
 * cannot be determined (no script, or `-e`/`-p` evaluation). Arguments are split on whitespace, so
 * a script path with spaces is not recognized (a false negative, never a false positive).
 */
function parseNodeInvocation(args: string): ScriptInvocation | null {
  const tokens = args.trim().split(/\s+/);
  const argv0 = tokens[0];
  if (!argv0 || !NODE_BINARIES.has(path.basename(argv0))) {
    return null;
  }

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (NODE_OPTIONS_WITHOUT_SCRIPT.has(token)) {
      return null;
    }
    if (NODE_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (NODE_FLAGS_WITHOUT_VALUE.has(token) || (token.startsWith("-") && token.includes("="))) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      // Unknown option: it may take a separate value that would be misread as the script.
      return null;
    }
    break;
  }

  const script = tokens[index];
  if (!script) {
    return null;
  }

  return { script, scriptArgs: tokens.slice(index + 1) };
}

/** `cli.js` runs the bot only for the `start` command (the default when no command is given). */
function cliArgumentsStartTheBot(scriptArgs: string[]): boolean {
  const parsed = parseCliArgs(scriptArgs);
  return !parsed.error && !parsed.showHelp && parsed.command === "start";
}

function entryAcceptsArguments(entryPoint: string, scriptArgs: string[]): boolean {
  return path.basename(entryPoint) !== CLI_ENTRY_BASENAME || cliArgumentsStartTheBot(scriptArgs);
}

function isSuffixOnComponentBoundary(entryPoint: string, relative: string): boolean {
  return entryPoint.endsWith(path.sep + relative);
}

/**
 * Relative script and unknown cwd: the script must have at least two path components, no
 * leading `..`, and be a path suffix of an entry point (never a bare `index.js`).
 */
function matchesRelativeWithoutCwd(
  entries: readonly ResolvedEntry[],
  invocation: ScriptInvocation,
): boolean {
  const relative = path.normalize(invocation.script);
  const components = relative.split(path.sep).filter(Boolean);
  if (components.length < MIN_RELATIVE_SCRIPT_COMPONENTS || components[0] === "..") {
    return false;
  }

  return entries.some(
    ({ entryPoint }) =>
      isSuffixOnComponentBoundary(entryPoint, relative) &&
      entryAcceptsArguments(entryPoint, invocation.scriptArgs),
  );
}

async function matchesResolvedScript(
  deps: ReverifyDeps,
  entries: readonly ResolvedEntry[],
  invocation: ScriptInvocation,
  lexical: string,
): Promise<boolean> {
  const real = await realpathOrLexical(deps, lexical);

  return entries.some(
    ({ entryPoint, real: entryReal }) =>
      [lexical, real].some((candidate) => candidate === entryPoint || candidate === entryReal) &&
      entryAcceptsArguments(entryPoint, invocation.scriptArgs),
  );
}

async function matchEntryPoint(
  deps: ReverifyDeps,
  entries: readonly ResolvedEntry[],
  pid: number,
  invocation: ScriptInvocation,
): Promise<{ matched: boolean; verified: boolean }> {
  const { script } = invocation;

  if (path.isAbsolute(script)) {
    const matched = await matchesResolvedScript(deps, entries, invocation, path.normalize(script));
    return { matched, verified: true };
  }

  const cwd = await deps.cwdOf(pid);
  if (cwd !== null) {
    const matched = await matchesResolvedScript(
      deps,
      entries,
      invocation,
      path.resolve(cwd, script),
    );
    return { matched, verified: true };
  }

  return { matched: matchesRelativeWithoutCwd(entries, invocation), verified: false };
}

/**
 * Finds bots running outside the daemon: `node` processes of the current user whose script is
 * an entry point (`cli.js` only when its arguments mean `start`, including the default). The own
 * pid, its ancestors, and `excludePids` are never returned, so a bot that is an ancestor of the
 * uninstall run is never reported (intentional safety). Global installs under pnpm, volta, or
 * fnm are not covered unless their package root is passed in (a false negative). Throws when the
 * listing does not contain the own pid; the caller treats that as the step being skipped.
 */
export async function findBotProcesses(deps: ScanDeps): Promise<BotProcess[]> {
  const processes = await deps.listProcesses();
  const excluded = collectOwnChain(processes, deps.ownPid, deps.ownPpid);
  for (const pid of deps.excludePids) {
    excluded.add(pid);
  }

  const entries = await resolveEntryPoints(deps);
  const found: BotProcess[] = [];
  for (const entry of processes) {
    if (excluded.has(entry.pid) || entry.uid !== deps.currentUid) {
      continue;
    }

    const invocation = parseNodeInvocation(entry.args);
    if (!invocation) {
      continue;
    }

    const { matched, verified } = await matchEntryPoint(deps, entries, entry.pid, invocation);
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

/**
 * Re-reads the pid's command line and returns true only when it is non-null, equal to the listed
 * one, and still matches an entry point. Call it before every signal, including SIGKILL, so a
 * pid reused by another command is never signaled.
 */
export async function reverifyBotProcess(found: BotProcess, deps: ReverifyDeps): Promise<boolean> {
  if (found.pid === deps.ownPid || deps.excludePids.includes(found.pid)) {
    return false;
  }

  const current = await deps.commandLine(found.pid);
  if (current === null || current !== found.commandLine) {
    return false;
  }

  const invocation = parseNodeInvocation(current);
  if (!invocation) {
    return false;
  }

  const entries = await resolveEntryPoints(deps);
  const { matched, verified } = await matchEntryPoint(deps, entries, found.pid, invocation);
  return matched && (verified || !found.verified);
}

export interface CommandRunner {
  (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string }>;
}

// Promisified per call, as in process-control.ts, so tests that mock node:child_process
// without execFile can still load this module.
const defaultRunner: CommandRunner = (file, args, options) =>
  promisify(execFile)(file, args, options);

async function runPs(runner: CommandRunner, columns: string): Promise<string> {
  // LC_ALL=C pins the `lstart` format (English month and day names) that the parser expects.
  const { stdout } = await runner("ps", ["-axo", columns], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER_BYTES,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

/**
 * Lists processes with `ps`. When `ps` rejects the `lstart` column (BusyBox), it retries once
 * without it and every entry gets `startedAt: null`.
 */
export async function listProcessesWithPs(
  runner: CommandRunner = defaultRunner,
): Promise<RawProcess[]> {
  try {
    return parseProcessList(await runPs(runner, PS_COLUMNS_WITH_START), true);
  } catch {
    return parseProcessList(await runPs(runner, PS_COLUMNS_WITHOUT_START), false);
  }
}

/** The cwd path from `lsof -Fn` output (the line after `fcwd` that starts with `n`). */
export function parseLsofCwd(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("n"));
  const cwd = line?.slice(1) ?? "";
  return cwd || null;
}

export interface CwdIo {
  platform: NodeJS.Platform;
  readlink(target: string): Promise<string>;
  lsofCwd(pid: number): Promise<string | null>;
}

/** On Linux reads `/proc/<pid>/cwd` first and falls back to `lsof`; elsewhere uses `lsof`. */
export function createCwdReader(io: CwdIo): (pid: number) => Promise<string | null> {
  return async (pid) => {
    if (io.platform === "linux") {
      try {
        const cwd = await io.readlink(`/proc/${pid}/cwd`);
        if (cwd) {
          return cwd;
        }
      } catch {
        // Fall back to lsof.
      }
    }

    return io.lsofCwd(pid);
  };
}

async function lsofCwdWith(runner: CommandRunner, pid: number): Promise<string | null> {
  try {
    const { stdout } = await runner("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: LSOF_TIMEOUT_MS,
    });
    return parseLsofCwd(stdout);
  } catch {
    return null;
  }
}

/** The global package root from `npm root -g`, or null on Windows or any failure. */
export async function globalPackageRoot(
  runner: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform === "win32") {
    return null;
  }

  try {
    const { stdout } = await runner("npm", ["root", "-g"], { timeout: NPM_ROOT_TIMEOUT_MS });
    const globalNodeModules = stdout.trim();
    return globalNodeModules ? path.join(globalNodeModules, GLOBAL_PACKAGE_NAME) : null;
  } catch {
    return null;
  }
}

function entryPointsOf(root: string): string[] {
  return [path.join(root, "dist", "cli.js"), path.join(root, "dist", "index.js")];
}

/** Builds scan dependencies from injectable runners; `defaultScanDeps` passes the real ones. */
export async function buildScanDeps(
  packageRoots: readonly string[],
  runner: CommandRunner,
  io: Pick<CwdIo, "platform" | "readlink">,
): Promise<ScanDeps> {
  const roots = [...packageRoots];
  const globalRoot = await globalPackageRoot(runner, io.platform);
  if (globalRoot) {
    roots.push(globalRoot);
  }

  return {
    listProcesses: () => listProcessesWithPs(runner),
    realpath: (target) => fsPromises.realpath(target),
    cwdOf: createCwdReader({ ...io, lsofCwd: (pid) => lsofCwdWith(runner, pid) }),
    commandLine: getProcessCommandLine,
    entryPoints: roots.flatMap(entryPointsOf),
    ownPid: process.pid,
    ownPpid: process.ppid,
    currentUid: typeof process.getuid === "function" ? process.getuid() : null,
    excludePids: [],
  };
}

/** Real dependencies: `ps`, `fs.realpath`, `/proc` and `lsof`, and `npm root -g` (macOS, Linux). */
export function defaultScanDeps(packageRoots: readonly string[]): Promise<ScanDeps> {
  return buildScanDeps(packageRoots, defaultRunner, {
    platform: process.platform,
    readlink: (target) => fsPromises.readlink(target),
  });
}
