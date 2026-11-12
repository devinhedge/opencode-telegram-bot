import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

// This module must stay free of config.js: config loads .env into process.env and can
// throw at import, and the uninstaller needs process control without either effect.

// Promisified per call: config.ts imports this module, and tests that mock
// node:child_process without exec or execFile must still be able to load config.ts.
function execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
  return promisify(exec)(command);
}

function execFileAsync(
  file: string,
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(file, args, options);
}

const PS_TIMEOUT_MS = 5000;
const DEFAULT_OPENCODE_PORT = 4096;
const PROCESS_EXIT_POLL_MS = 100;

export type OpencodeServerVersion = "v1" | "v2";

export const DEFAULT_OPENCODE_API_URLS: Record<OpencodeServerVersion, string> = {
  v1: "http://localhost:4096",
  v2: "http://127.0.0.1:49374",
};

export interface LocalOpencodeTarget {
  host: string;
  port: number;
}

function isLocalHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname.toLowerCase());
}

export function resolveLocalOpencodeTarget(apiUrl: string): LocalOpencodeTarget | null {
  try {
    const parsedUrl = new URL(apiUrl);

    if (!isLocalHostname(parsedUrl.hostname)) {
      return null;
    }

    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : DEFAULT_OPENCODE_PORT;

    if (!Number.isInteger(port) || port <= 0) {
      return null;
    }

    return {
      host: parsedUrl.hostname,
      port,
    };
  } catch {
    return null;
  }
}

function parsePid(value: string): number | null {
  const pid = Number.parseInt(value.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseSocketPort(value: string): number | null {
  const trimmedValue = value.trim();
  const match = trimmedValue.match(/:(\d+)$/);
  if (!match) {
    return null;
  }

  const portText = match[1];
  if (!portText) {
    return null;
  }
  const port = Number.parseInt(portText, 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function findWindowsListeningPidInNetstat(stdout: string, port: number): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const columns = trimmedLine.split(/\s+/);
    const localAddress = columns[1] ?? "";
    const localPort = parseSocketPort(localAddress);
    if (localPort !== port) {
      continue;
    }

    const pid = parsePid(columns[columns.length - 1] ?? "");
    if (pid !== null) {
      return pid;
    }
  }

  return null;
}

export function findUnixListeningPidInSs(stdout: string, port: number): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const columns = trimmedLine.split(/\s+/);
    const localAddress = columns[3] ?? "";
    const localPort = parseSocketPort(localAddress);
    if (localPort !== port) {
      continue;
    }

    const pidMatch = trimmedLine.match(/pid=(\d+)/);
    const pidText = pidMatch?.[1];
    const pid = pidText ? parsePid(pidText) : null;
    if (pid !== null) {
      return pid;
    }
  }

  return null;
}

async function findWindowsServerPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await execAsync("netstat -ano | findstr LISTENING");
    return findWindowsListeningPidInNetstat(stdout, port);
  } catch {
    return null;
  }
}

function parseUnixPidList(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const pid = parsePid(line);
    if (pid !== null) {
      return pid;
    }
  }

  return null;
}

async function findUnixServerPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
    const pid = parseUnixPidList(stdout);
    if (pid !== null) {
      return pid;
    }
  } catch {
    // Fall back to ss when lsof is unavailable.
  }

  try {
    const { stdout } = await execAsync("ss -ltnp");
    return findUnixListeningPidInSs(stdout, port);
  } catch {
    return null;
  }
}

export async function findServerPid(port: number): Promise<number | null> {
  return process.platform === "win32" ? findWindowsServerPid(port) : findUnixServerPid(port);
}

/**
 * The command line of a running process via POSIX `ps`, or null on an invalid pid, any error
 * (including a ps timeout), or empty output. macOS and Linux only: process finding is out of
 * scope on Windows, where this always returns null.
 */
export async function getProcessCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", String(pid)], {
      timeout: PS_TIMEOUT_MS,
    });
    const commandLine = stdout.trim();
    return commandLine || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }

  return !isProcessAlive(pid);
}

async function killWindowsProcess(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    await execAsync(`taskkill /PID ${pid} /T`);
  } catch {
    // Continue with forced stop if the process is still alive.
  }

  if (await waitForProcessExit(pid, timeoutMs)) {
    return true;
  }

  try {
    await execAsync(`taskkill /F /PID ${pid} /T`);
  } catch {
    return !isProcessAlive(pid);
  }

  return waitForProcessExit(pid, timeoutMs);
}

async function killUnixProcess(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
  }

  if (await waitForProcessExit(pid, timeoutMs)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isProcessAlive(pid);
  }

  return waitForProcessExit(pid, timeoutMs);
}

export async function killServerProcess(pid: number, timeoutMs: number = 5000): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return true;
  }

  return process.platform === "win32"
    ? killWindowsProcess(pid, timeoutMs)
    : killUnixProcess(pid, timeoutMs);
}
