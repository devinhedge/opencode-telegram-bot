import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { RuntimeMode } from "../runtime/mode.js";

export const LOG_FILE_PREFIX = "opencode-telegram-bot";

const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
const DEFAULT_LOG_RETENTION = 10;

// Number of log files to keep per kind. A missing, non-numeric, zero, or
// negative LOG_RETENTION falls back to the default.
export function getLogRetention(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.LOG_RETENTION;
  if (!value) {
    return DEFAULT_LOG_RETENTION;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_LOG_RETENTION;
  }

  return parsed;
}

function formatTimestampForFile(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/:/g, "-").replace("T", "_");
}

export function buildMainLogFileName(mode: RuntimeMode, now: Date, pid: number): string {
  if (mode === "installed") {
    return `${LOG_FILE_PREFIX}-${now.toISOString().slice(0, 10)}.log`;
  }

  return `${LOG_FILE_PREFIX}-${formatTimestampForFile(now)}_${pid}.log`;
}

export function getMainLogFilePattern(mode: RuntimeMode): RegExp {
  if (mode === "installed") {
    return new RegExp(`^${LOG_FILE_PREFIX}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
  }

  return new RegExp(`^${LOG_FILE_PREFIX}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}_\\d+\\.log$`);
}

export function buildServiceLogFileName(now: Date): string {
  return `${LOG_FILE_PREFIX}-service-${formatTimestampForFile(now)}.log`;
}

export const SERVICE_LOG_FILE_PATTERN = new RegExp(
  `^${LOG_FILE_PREFIX}-service-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.log$`,
);

// Creates the directory (and parents) owner-only, and tightens a pre-existing
// directory. Permission bits are not enforced on Windows, so chmod is skipped there.
// Errors (path is a file, mkdir or chmod failure) are deliberately NOT caught:
// callers decide whether to warn (logger) or fail startup (daemon service).
export async function ensureLogsDir(dirPath: string): Promise<void> {
  await fsPromises.mkdir(dirPath, { recursive: true, mode: DIR_MODE });

  if (process.platform !== "win32") {
    await fsPromises.chmod(dirPath, DIR_MODE);
  }
}

// Restricts the file to owner read/write. Errors (for example ENOENT when the
// file does not exist) propagate to the caller; chmod is skipped on Windows.
export async function secureLogFile(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    await fsPromises.chmod(filePath, FILE_MODE);
  }
}

// Synchronous variant of ensureLogsDir for the logger's synchronous rotation
// path. Same behavior and constants; errors are thrown to the caller.
export function ensureLogsDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });

  if (process.platform !== "win32") {
    fs.chmodSync(dirPath, DIR_MODE);
  }
}

// Synchronous variant of secureLogFile. Errors (for example ENOENT) are thrown
// to the caller; chmod is skipped on Windows.
export function secureLogFileSync(filePath: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, FILE_MODE);
  }
}

const PID_SUFFIX_PATTERN = /^(.*)_(\d+)\.log$/;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Strict total order, oldest first:
//   1. Names without a trailing "_<digits>.log" sort before names with one,
//      and compare lexically within their group.
//   2. Names with a pid suffix compare by the part before the pid lexically,
//      then by pid numerically ("9" before "10"), then by the full name so
//      equal-valued pids such as "07" and "7" still have a fixed order.
export function compareLogNames(a: string, b: string): number {
  const matchA = PID_SUFFIX_PATTERN.exec(a);
  const matchB = PID_SUFFIX_PATTERN.exec(b);

  if (!matchA || !matchB) {
    if (matchA) {
      return 1;
    }
    if (matchB) {
      return -1;
    }
    return compareStrings(a, b);
  }

  const [, headA = "", pidA = ""] = matchA;
  const [, headB = "", pidB = ""] = matchB;
  const byHead = compareStrings(headA, headB);
  if (byHead !== 0) {
    return byHead;
  }

  // Numeric compare on digit strings without precision loss.
  const digitsA = pidA.replace(/^0+/, "");
  const digitsB = pidB.replace(/^0+/, "");
  if (digitsA.length !== digitsB.length) {
    return digitsA.length - digitsB.length;
  }
  return compareStrings(digitsA, digitsB) || compareStrings(a, b);
}

export async function pruneLogFiles(
  dirPath: string,
  pattern: RegExp,
  retention: number,
  onError: (message: string, error: unknown) => void,
): Promise<void> {
  let fileNames: string[];

  try {
    fileNames = await fsPromises.readdir(dirPath);
  } catch (error) {
    onError(`Failed to read log directory ${dirPath}.`, error);
    return;
  }

  const matchingFiles = fileNames
    .filter((fileName) => pattern.test(fileName))
    .sort(compareLogNames);
  const filesToDelete = matchingFiles.slice(0, Math.max(0, matchingFiles.length - retention));

  await Promise.all(
    filesToDelete.map(async (fileName) => {
      try {
        await fsPromises.unlink(path.join(dirPath, fileName));
      } catch (error) {
        onError(`Failed to delete old log file ${fileName}.`, error);
      }
    }),
  );
}
