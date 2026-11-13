import { promises as fsPromises } from "node:fs";
import dotenv from "dotenv";
import {
  DEFAULT_OPENCODE_API_URLS,
  findServerPid,
  getProcessCommandLine,
  isLocalHostname,
  killServerProcess,
} from "../../opencode/process-control.js";

// This module must not import config.js: it loads .env into process.env and can throw at
// import. The environment keys are read here from the real environment, then from .env.

const MAX_PORT = 65535;

export interface OpencodeServer {
  pid: number;
  port: number;
  commandLine: string | null;
}

// Missing .env gives no values; any other read error (EACCES, EISDIR, EIO) gives null because
// the configured URL is then unknowable and the caller must refuse to act.
async function readEnvFile(envFilePath: string): Promise<Record<string, string> | null> {
  try {
    return dotenv.parse(await fsPromises.readFile(envFilePath));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

function pickValue(
  key: string,
  env: NodeJS.ProcessEnv,
  fileValues: Record<string, string>,
): string {
  return env[key]?.trim() || fileValues[key]?.trim() || "";
}

// The port of a local http(s) URL: the explicit port, else the scheme default (80 or 443).
// Null for a remote host, another scheme, an unparseable URL, or a port outside 1-65535.
function resolveLocalPort(apiUrl: string): number | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }

  // URL.hostname keeps the brackets of an IPv6 literal.
  const hostname = parsedUrl.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!isLocalHostname(hostname)) {
    return null;
  }

  const schemeDefaultPort = parsedUrl.protocol === "https:" ? 443 : 80;
  const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : schemeDefaultPort;

  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : null;
}

/** Marks a URL that is not a local one: there is nothing local to look up or stop. */
export const NOT_LOCAL = "not-local";

/**
 * The port of the local OpenCode API the bot used: OPENCODE_API_URL, else the default for
 * OPENCODE_SERVER_VERSION (v2, otherwise v1), each read from the real environment first and
 * then from the .env file. A configured URL without a port resolves to its scheme default
 * (80 or 443), never to the OpenCode default. NOT_LOCAL when the URL is not a local one (a
 * remote server is never a stop target) and null when .env exists but cannot be read (the
 * configured URL is unknowable).
 *
 * OPENCODE_SERVER_MODE is deliberately not consulted: config.ts refuses standalone mode
 * without OPENCODE_API_URL for v2, so the v2 default port is only reached in service mode.
 */
export async function resolveOpencodeTarget(
  env: NodeJS.ProcessEnv,
  envFilePath: string,
): Promise<number | typeof NOT_LOCAL | null> {
  const fileValues = await readEnvFile(envFilePath);
  if (fileValues === null) {
    return null;
  }

  const configuredUrl = pickValue("OPENCODE_API_URL", env, fileValues);
  const version =
    pickValue("OPENCODE_SERVER_VERSION", env, fileValues).toLowerCase() === "v2" ? "v2" : "v1";

  return resolveLocalPort(configuredUrl || DEFAULT_OPENCODE_API_URLS[version]) ?? NOT_LOCAL;
}

/**
 * The outcome of a lookup. `not-listening` is the only definite "nothing is there": the port is
 * known and the pid lookup found no listener. `not-local` means the configured URL is remote (or
 * not a local http(s) URL): nothing local to look up. `excluded` means the listener is this
 * process, its parent, or an excluded pid. `unknown` means the answer cannot be trusted: the
 * configured port could not be resolved (unreadable .env) or the pid lookup threw.
 */
export type OpencodeLookup =
  | { kind: "found"; server: OpencodeServer }
  | { kind: "not-listening" }
  | { kind: "not-local" }
  | { kind: "excluded" }
  | { kind: "unknown" };

/**
 * The process listening on the port. findServerPid returns only the first listener pid, so
 * callers word their output "the process found", never "the OpenCode server". A listener that
 * is this process, its parent, or in `excludePids` (the caller passes the own process chain and
 * the bot daemon) is never offered (excluded). On win32 the command line is always null:
 * the caller must print the pid, say the command line is unavailable, and mention in the
 * prompt that stopping kills the whole process tree (taskkill /T).
 *
 * findServerPid itself returns null both when nothing listens and when lsof and ss cannot run, so
 * a null pid is reported as not-listening (the residual limit of that helper).
 */
export async function findOpencodeServer(deps: {
  /** From resolveOpencodeTarget: a port, NOT_LOCAL for a remote URL, null when unknowable. */
  port: number | typeof NOT_LOCAL | null;
  findPid: typeof findServerPid;
  commandLine: typeof getProcessCommandLine;
  excludePids?: readonly number[];
}): Promise<OpencodeLookup> {
  if (deps.port === NOT_LOCAL) {
    return { kind: "not-local" };
  }
  if (deps.port === null) {
    return { kind: "unknown" };
  }

  let pid: number | null;
  try {
    pid = await deps.findPid(deps.port);
  } catch {
    return { kind: "unknown" };
  }
  if (pid === null) {
    return { kind: "not-listening" };
  }
  if (pid === process.pid || pid === process.ppid || (deps.excludePids ?? []).includes(pid)) {
    return { kind: "excluded" };
  }

  return {
    kind: "found",
    server: { pid, port: deps.port, commandLine: await deps.commandLine(pid) },
  };
}

/**
 * Stops the process through killServerProcess (SIGTERM then SIGKILL) with its default 5000 ms
 * timeout, the same as /opencode_stop. A pid that is not a positive integer is refused: kill(0)
 * and kill(-n) would signal a process group.
 *
 * Time of check to time of use: the caller must re-run findOpencodeServer immediately before
 * the kill and refuse when the fresh pid differs from the pid the user confirmed.
 */
export async function stopOpencodeServer(
  pid: number,
  kill: typeof killServerProcess = killServerProcess,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  return kill(pid);
}
