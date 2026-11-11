import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { getRuntimeMode, type RuntimeMode } from "../runtime/mode.js";
import { resolveLogsDirPath } from "../runtime/log-location.js";
import {
  buildMainLogFileName,
  ensureLogsDir,
  getMainLogFilePattern,
  pruneLogFiles,
  secureLogFile,
} from "./log-files.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_LOG_RETENTION = 10;
const LOGGER_ERROR_PREFIX = "[LOGGER]";
const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let logStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let logsDirPath: string | null = null;
let initializePromise: Promise<void> | null = null;
let cleanupPromise: Promise<void> | null = null;
let streamErrorReported = false;
const CONSOLE_BROKEN_KEY = "__opencodeTelegramBotConsoleOutputBroken";

function normalizeLogLevel(value: string): LogLevel {
  if (value in LOG_LEVELS) {
    return value as LogLevel;
  }

  return DEFAULT_LOG_LEVEL;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function getConfiguredLogLevel(): LogLevel {
  return normalizeLogLevel(process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL);
}

function getConfiguredLogRetention(): number {
  return parsePositiveInteger(process.env.LOG_RETENTION, DEFAULT_LOG_RETENTION);
}

function formatPrefix(level: LogLevel): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
}

function formatArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }

  return arg;
}

function formatArgForFile(arg: unknown): string {
  const formatted = formatArg(arg);

  if (typeof formatted === "string") {
    return formatted;
  }

  return inspect(formatted, {
    colors: false,
    compact: true,
    depth: 8,
    breakLength: Infinity,
  });
}

function withPrefix(level: LogLevel, args: unknown[]): unknown[] {
  const formattedArgs = args.map((arg) => formatArg(arg));
  const prefix = formatPrefix(level);

  if (formattedArgs.length === 0) {
    return [prefix];
  }

  if (typeof formattedArgs[0] === "string") {
    return [`${prefix} ${formattedArgs[0]}`, ...formattedArgs.slice(1)];
  }

  return [prefix, ...formattedArgs];
}

function formatLine(level: LogLevel, args: unknown[]): string {
  const prefix = formatPrefix(level);
  const formattedArgs = args.map((arg) => formatArgForFile(arg));

  if (formattedArgs.length === 0) {
    return prefix;
  }

  return `${prefix} ${formattedArgs.join(" ")}`;
}

function shouldLog(level: LogLevel): boolean {
  const configuredLevel = getConfiguredLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[configuredLevel];
}

function getLogFilePathForMode(logsDirPath: string, mode: RuntimeMode): string {
  return path.join(logsDirPath, buildMainLogFileName(mode, new Date(), process.pid));
}

function reportLoggerInternalError(message: string, error?: unknown): void {
  if (isConsoleOutputBroken()) {
    return;
  }
  const details =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error ?? "");
  const suffix = details && details !== "undefined" ? ` ${details}` : "";
  process.stderr.write(`${formatPrefix("error")} ${LOGGER_ERROR_PREFIX} ${message}${suffix}\n`);
}

function isConsoleOutputBroken(): boolean {
  return (globalThis as Record<string, unknown>)[CONSOLE_BROKEN_KEY] === true;
}

// A closed console pipe makes each console write raise EPIPE. Without an
// "error" listener, Node escalates that to an uncaught exception, whose
// handler logs through this same console — an unbounded loop that grew a
// log file to 2 GB once. Swallow EPIPE and stop console logging instead.
const CONSOLE_PIPE_GUARD_KEY = "__opencodeTelegramBotConsolePipeGuardInstalled";

function installConsolePipeGuard(): void {
  if ((globalThis as Record<string, unknown>)[CONSOLE_PIPE_GUARD_KEY]) {
    return;
  }
  (globalThis as Record<string, unknown>)[CONSOLE_PIPE_GUARD_KEY] = true;

  const handleStreamError = (error: unknown): void => {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EPIPE") {
      (globalThis as Record<string, unknown>)[CONSOLE_BROKEN_KEY] = true;
      return;
    }

    // Re-throw non-EPIPE errors to preserve fatal EventEmitter semantics
    throw error;
  };

  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}

installConsolePipeGuard();

function handleLogStreamError(error: unknown): void {
  if (!streamErrorReported) {
    streamErrorReported = true;
    reportLoggerInternalError("Failed to write to log file.", error);
  }

  if (logStream) {
    logStream.destroy();
    logStream = null;
  }
}

function closeLogStream(): void {
  if (!logStream) {
    return;
  }

  logStream.removeAllListeners("error");
  logStream.end();
  logStream = null;
}

function ensureLogStream(filePath: string): void {
  if (logStream && logFilePath === filePath) {
    return;
  }

  closeLogStream();
  streamErrorReported = false;

  const stream = fs.createWriteStream(filePath, { flags: "a" });
  stream.on("error", handleLogStreamError);

  logStream = stream;
  logFilePath = filePath;
}

async function cleanupOldLogs(dirPath: string, mode: RuntimeMode): Promise<void> {
  await pruneLogFiles(
    dirPath,
    getMainLogFilePattern(mode),
    getConfiguredLogRetention(),
    reportLoggerInternalError,
  );
}

function cleanupOldLogsInBackground(dirPath: string, mode: RuntimeMode): void {
  if (cleanupPromise) {
    return;
  }

  cleanupPromise = cleanupOldLogs(dirPath, mode)
    .catch((error) => {
      reportLoggerInternalError(`Failed to clean up old logs in ${dirPath}.`, error);
    })
    .finally(() => {
      cleanupPromise = null;
    });
}

function rotateInstalledLogIfNeeded(): void {
  const mode = getRuntimeMode();
  if (mode !== "installed" || !logFilePath) {
    return;
  }

  if (!logsDirPath) {
    return;
  }

  const nextLogFilePath = getLogFilePathForMode(logsDirPath, mode);
  if (logFilePath === nextLogFilePath) {
    return;
  }

  try {
    // Rotation runs inside the synchronous write path, so it cannot use the
    // async ensureLogsDir/secureLogFile helpers; it applies the same modes.
    fs.mkdirSync(logsDirPath, { recursive: true, mode: LOG_DIR_MODE });
    fs.appendFileSync(nextLogFilePath, "");
    if (process.platform !== "win32") {
      fs.chmodSync(nextLogFilePath, LOG_FILE_MODE);
    }
    ensureLogStream(nextLogFilePath);
    cleanupOldLogsInBackground(logsDirPath, mode);
  } catch (error) {
    reportLoggerInternalError(`Failed to rotate file logging to ${nextLogFilePath}.`, error);
    closeLogStream();
    logFilePath = null;
  }
}

function writeToFile(line: string): void {
  if (!logStream) {
    return;
  }

  try {
    rotateInstalledLogIfNeeded();
    if (!logStream) {
      return;
    }

    logStream.write(`${line}\n`);
  } catch (error) {
    handleLogStreamError(error);
  }
}

async function initializeLoggerInternal(): Promise<void> {
  if (logStream && logFilePath) {
    return;
  }

  const mode = getRuntimeMode();
  let resolvedDirPath = "the logs directory";

  try {
    resolvedDirPath = await resolveLogsDirPath();
    logsDirPath = resolvedDirPath;
    await ensureLogsDir(resolvedDirPath);
    const nextLogFilePath = getLogFilePathForMode(resolvedDirPath, mode);
    await fsPromises.appendFile(nextLogFilePath, "");
    await secureLogFile(nextLogFilePath);
    ensureLogStream(nextLogFilePath);
    await cleanupOldLogs(resolvedDirPath, mode);
  } catch (error) {
    reportLoggerInternalError(`Failed to initialize file logging in ${resolvedDirPath}.`, error);
    closeLogStream();
    logFilePath = null;
    logsDirPath = null;
  }
}

export async function initializeLogger(): Promise<void> {
  if (initializePromise) {
    await initializePromise;
    return;
  }

  initializePromise = initializeLoggerInternal();

  try {
    await initializePromise;
  } finally {
    initializePromise = null;
  }
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

export async function flushLogger(): Promise<void> {
  if (cleanupPromise) {
    await cleanupPromise;
  }

  if (!logStream) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    logStream?.write("", (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function __flushLoggerForTests(): Promise<void> {
  await flushLogger();
}

export function __resetLoggerForTests(): void {
  initializePromise = null;
  cleanupPromise = null;
  logFilePath = null;
  logsDirPath = null;
  streamErrorReported = false;
  (globalThis as Record<string, unknown>)[CONSOLE_BROKEN_KEY] = false;
  closeLogStream();
}

function writeToConsole(level: LogLevel, args: unknown[]): void {
  if (isConsoleOutputBroken()) {
    return;
  }

  const prefixedArgs = withPrefix(level, args);
  if (level === "warn") {
    console.warn(...prefixedArgs);
  } else if (level === "error") {
    console.error(...prefixedArgs);
  } else {
    console.log(...prefixedArgs);
  }
}

export const logger = {
  debug: (...args: unknown[]): void => {
    if (shouldLog("debug")) {
      writeToConsole("debug", args);
      writeToFile(formatLine("debug", args));
    }
  },

  info: (...args: unknown[]): void => {
    if (shouldLog("info")) {
      writeToConsole("info", args);
      writeToFile(formatLine("info", args));
    }
  },

  warn: (...args: unknown[]): void => {
    if (shouldLog("warn")) {
      writeToConsole("warn", args);
      writeToFile(formatLine("warn", args));
    }
  },

  error: (...args: unknown[]): void => {
    if (shouldLog("error")) {
      writeToConsole("error", args);
      writeToFile(formatLine("error", args));
    }
  },
};
