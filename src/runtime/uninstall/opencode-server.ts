import { promises as fsPromises } from "node:fs";
import dotenv from "dotenv";
import {
  DEFAULT_OPENCODE_API_URLS,
  findServerPid,
  getProcessCommandLine,
  killServerProcess,
  resolveLocalOpencodeTarget,
} from "../../opencode/process-control.js";

// This module must not import config.js: it loads .env into process.env and can throw at
// import. The environment keys are read here from the real environment, then from .env.

export interface OpencodeServer {
  pid: number;
  port: number;
  commandLine: string | null;
}

async function readEnvFile(envFilePath: string): Promise<Record<string, string>> {
  try {
    return dotenv.parse(await fsPromises.readFile(envFilePath));
  } catch {
    return {};
  }
}

function pickValue(
  key: string,
  env: NodeJS.ProcessEnv,
  fileValues: Record<string, string>,
): string {
  return (env[key]?.trim() || fileValues[key]?.trim() || "").trim();
}

/**
 * The port of the local OpenCode API the bot used: OPENCODE_API_URL, else the default for
 * OPENCODE_SERVER_VERSION (v2, otherwise v1), each read from the real environment first and
 * then from the .env file. Null when the URL is not a local one, so a remote server is never
 * a stop target.
 */
export async function resolveOpencodePort(
  env: NodeJS.ProcessEnv,
  envFilePath: string,
): Promise<number | null> {
  const fileValues = await readEnvFile(envFilePath);
  const configuredUrl = pickValue("OPENCODE_API_URL", env, fileValues);
  const version =
    pickValue("OPENCODE_SERVER_VERSION", env, fileValues).toLowerCase() === "v2" ? "v2" : "v1";
  const apiUrl = configuredUrl || DEFAULT_OPENCODE_API_URLS[version];

  return resolveLocalOpencodeTarget(apiUrl)?.port ?? null;
}

export async function findOpencodeServer(deps: {
  port: number | null;
  findPid: typeof findServerPid;
  commandLine: typeof getProcessCommandLine;
}): Promise<OpencodeServer | null> {
  if (deps.port === null) {
    return null;
  }

  const pid = await deps.findPid(deps.port);
  if (pid === null) {
    return null;
  }

  return { pid, port: deps.port, commandLine: await deps.commandLine(pid) };
}

/**
 * Stops the process through SIGTERM then SIGKILL. A pid that is not a positive integer is
 * refused: kill(0) and kill(-n) would signal a process group.
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
