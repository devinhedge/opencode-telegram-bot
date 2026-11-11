import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
// This module runs before the logger is initialized: never import src/utils/logger.ts here,
// directly or transitively.
import { t } from "../i18n/index.js";
import { persistEnvValue } from "./env-file.js";
import { getRuntimePaths } from "./paths.js";
import { askVisible } from "./prompts.js";
import { getServiceLogsDirFromEnv, isServiceChildProcess } from "./service/env.js";

export type LogLocation = "default" | "app";

export type LogLocationSetting =
  { kind: "unset" } | { kind: "valid"; value: LogLocation } | { kind: "invalid"; raw: string };

const APP_DIR_NAME = "opencode-telegram-bot";

export function parseLogLocation(raw: string | undefined): LogLocationSetting {
  const normalized = (raw ?? "").trim().toLowerCase();

  if (normalized === "") {
    return { kind: "unset" };
  }

  if (normalized === "default" || normalized === "app") {
    return { kind: "valid", value: normalized };
  }

  // raw is the unmodified input (not trimmed) so warnings show exactly what the user typed.
  return { kind: "invalid", raw: raw ?? "" };
}

export function resolveCanonicalLogsDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base = localAppData || path.win32.join(homedir, "AppData", "Local");
    return path.win32.join(base, APP_DIR_NAME, "Logs");
  }

  if (platform === "darwin") {
    return path.posix.join(homedir, "Library", "Logs", APP_DIR_NAME);
  }

  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome && path.posix.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.posix.join(homedir, ".local", "state");
  return path.posix.join(stateHome, APP_DIR_NAME, "logs");
}

export interface ResolveLogsDirOptions {
  env?: NodeJS.ProcessEnv;
  isInteractive?: boolean;
  ask?: (prompt: string) => Promise<string>;
  warn?: (message: string) => void;
}

const LOG_LOCATION_KEY = "LOG_LOCATION";

let resolvedLogsDir: Promise<string> | undefined;

function writeStderr(message: string): void {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Returns undefined when the file does not exist; any other read error propagates.
async function readEnvFileLogLocation(envFilePath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.readFile(envFilePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  return dotenv.parse(content)[LOG_LOCATION_KEY];
}

async function promptForLogLocation(
  raw: string,
  envFilePath: string,
  ask: (prompt: string) => Promise<string>,
  warn: (message: string) => void,
): Promise<LogLocation> {
  warn(t("runtime.logs.location_invalid", { value: raw }));

  for (;;) {
    const answer = (await ask(t("runtime.logs.ask_location", { envPath: envFilePath })))
      .trim()
      .toLowerCase();

    if (answer !== "default" && answer !== "app") {
      warn(t("runtime.logs.location_choice_invalid"));
      continue;
    }

    try {
      await persistEnvValue(envFilePath, LOG_LOCATION_KEY, answer);
    } catch (error) {
      warn(
        t("runtime.logs.location_persist_failed", {
          envPath: envFilePath,
          reason: describeError(error),
        }),
      );
    }

    return answer;
  }
}

async function resolveLogsDir(options: ResolveLogsDirOptions): Promise<string> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? writeStderr;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ask = options.ask ?? askVisible;

  if (isServiceChildProcess(env)) {
    const serviceLogsDir = getServiceLogsDirFromEnv(env);
    if (serviceLogsDir) {
      return serviceLogsDir;
    }
  }

  const runtimePaths = getRuntimePaths();
  const canonicalDir = resolveCanonicalLogsDir(process.platform, env, os.homedir());

  let setting = parseLogLocation(env[LOG_LOCATION_KEY]);
  const fromRealEnv = setting.kind !== "unset";

  if (!fromRealEnv) {
    try {
      setting = parseLogLocation(await readEnvFileLogLocation(runtimePaths.envFilePath));
    } catch (error) {
      warn(
        t("runtime.logs.env_read_failed", {
          envPath: runtimePaths.envFilePath,
          reason: describeError(error),
        }),
      );
      return canonicalDir;
    }
  }

  if (setting.kind === "unset") {
    return canonicalDir;
  }

  let location: LogLocation;
  if (setting.kind === "valid") {
    location = setting.value;
  } else if (fromRealEnv) {
    warn(t("runtime.logs.location_invalid_env", { value: setting.raw }));
    location = "default";
  } else if (isInteractive) {
    location = await promptForLogLocation(setting.raw, runtimePaths.envFilePath, ask, warn);
  } else {
    warn(t("runtime.logs.location_invalid_no_tty", { value: setting.raw }));
    location = "default";
  }

  return location === "app" ? runtimePaths.logsDirPath : canonicalDir;
}

export function resolveLogsDirPath(options: ResolveLogsDirOptions = {}): Promise<string> {
  if (!resolvedLogsDir) {
    const pending = resolveLogsDir(options);
    resolvedLogsDir = pending;
    // A rejected resolution must not stay memoized, so the next call retries.
    pending.catch(() => {
      if (resolvedLogsDir === pending) {
        resolvedLogsDir = undefined;
      }
    });
  }
  return resolvedLogsDir;
}

export function __resetLogsDirForTests(): void {
  resolvedLogsDir = undefined;
}
