import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
// This module runs before the logger is initialized: never import src/utils/logger.ts here,
// directly or transitively.
import type { I18nKey } from "../i18n/en.js";
import { resolveSupportedLocale, t, type Locale } from "../i18n/index.js";
import { isContainerRuntime } from "./container.js";
import { persistEnvValue } from "./env-file.js";
import { getLogRetention } from "../utils/log-files.js";
import { getRuntimePaths } from "./paths.js";
import { askVisibleOrEof } from "./prompts.js";
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

const LOG_LOCATION_CHOICES: ReadonlyArray<LogLocation> = ["default", "app"];

// Maps a prompt answer to a location: 1, 2, default, or app (case-insensitive); null otherwise.
// Shared by the runtime prompt and the config wizard so both accept the same answers.
export function parseLogLocationChoice(answer: string): LogLocation | null {
  const normalized = answer.trim().toLowerCase();

  return (
    LOG_LOCATION_CHOICES.find(
      (location, index) => normalized === location || normalized === String(index + 1),
    ) ?? null
  );
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
  // Set false to warn and use default for an invalid .env value instead of prompting; the
  // config command does this because its wizard asks the question itself. Defaults to true.
  prompt?: boolean;
  // Resolves null when input ends before an answer.
  ask?: (prompt: string) => Promise<string | null>;
  warn?: (message: string) => void;
}

type Translate = (key: I18nKey, params?: Parameters<typeof t>[1]) => string;

const LOG_LOCATION_KEY = "LOG_LOCATION";
const LOG_RETENTION_KEY = "LOG_RETENTION";
const BOT_LOCALE_KEY = "BOT_LOCALE";
const MAX_PROMPT_ATTEMPTS = 3;

let resolvedLogsDir: Promise<string> | undefined;

function writeStderr(message: string): void {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Translates with an explicit locale so the global runtime locale is never mutated; the
// resolver runs before config.ts loads .env, so BOT_LOCALE may exist only in the .env file.
function translatorFor(locale: Locale | null): Translate {
  return (key, params) => t(key, params, locale ?? undefined);
}

// Returns undefined when the file does not exist; any other read error propagates.
async function readEnvFile(envFilePath: string): Promise<Record<string, string> | undefined> {
  let content: string;
  try {
    content = await fs.readFile(envFilePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  return dotenv.parse(content);
}

// Returns null when the user gives up: input ended or too many invalid answers.
async function promptForLogLocation(
  raw: string,
  envFilePath: string,
  ask: (prompt: string) => Promise<string | null>,
  warn: (message: string) => void,
  translate: Translate,
): Promise<LogLocation | null> {
  warn(translate("runtime.logs.location_invalid", { value: raw }));

  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const reply = await ask(translate("runtime.logs.ask_location", { envPath: envFilePath }));
    if (reply === null) {
      return null;
    }

    const answer = parseLogLocationChoice(reply);
    if (answer === null) {
      if (attempt < MAX_PROMPT_ATTEMPTS - 1) {
        warn(translate("runtime.logs.location_choice_invalid"));
      }
      continue;
    }

    try {
      await persistEnvValue(envFilePath, LOG_LOCATION_KEY, answer);
    } catch (error) {
      warn(
        translate("runtime.logs.location_persist_failed", {
          envPath: envFilePath,
          reason: describeError(error),
        }),
      );
    }

    return answer;
  }

  return null;
}

async function resolveLogsDir(options: ResolveLogsDirOptions): Promise<string> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? writeStderr;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ask = options.ask ?? askVisibleOrEof;

  // The parent process already resolved LOG_LOCATION (warning or prompting as needed) and
  // passed the result down, so the child skips re-resolving it and any invalid-value warning.
  if (isServiceChildProcess(env)) {
    const serviceLogsDir = getServiceLogsDirFromEnv(env);
    if (serviceLogsDir) {
      return serviceLogsDir;
    }
  }

  const runtimePaths = getRuntimePaths();
  // Computed lazily: os.homedir() can throw (for example an arbitrary uid with no HOME), and
  // LOG_LOCATION=app never needs it.
  const getCanonicalDir = (): string =>
    resolveCanonicalLogsDir(process.platform, env, os.homedir());
  // Inside a container the default location is the app home: the canonical directory lies outside
  // the data volume and is lost with the container. A plain `docker run -e` or `--env-file`
  // replaces the image's LOG_LOCATION=app, so the rule applies to a resulting default.
  const getDefaultDir = (): string =>
    isContainerRuntime({ env }) ? runtimePaths.logsDirPath : getCanonicalDir();
  const envLocale = resolveSupportedLocale(env[BOT_LOCALE_KEY]);
  let translate = translatorFor(envLocale);

  let setting = parseLogLocation(env[LOG_LOCATION_KEY]);
  const fromRealEnv = setting.kind !== "unset";

  if (!fromRealEnv || !envLocale) {
    try {
      const fileValues = await readEnvFile(runtimePaths.envFilePath);
      if (!envLocale) {
        translate = translatorFor(resolveSupportedLocale(fileValues?.[BOT_LOCALE_KEY]));
      }
      if (!fromRealEnv) {
        setting = parseLogLocation(fileValues?.[LOG_LOCATION_KEY]);
      }
    } catch (error) {
      // A read failure matters only when .env was needed for LOG_LOCATION itself; a lookup
      // made only for the locale must not discard a valid real-env value or warn.
      if (!fromRealEnv) {
        warn(
          translate("runtime.logs.env_read_failed", {
            envPath: runtimePaths.envFilePath,
            reason: describeError(error),
          }),
        );
        return getDefaultDir();
      }
    }
  }

  if (setting.kind === "unset") {
    return getDefaultDir();
  }

  // Inside a container an invalid value never prompts and is never persisted: the app home is
  // the only location that survives the container, so one warning is all the user needs.
  if (setting.kind === "invalid" && isContainerRuntime({ env })) {
    warn(translate("runtime.logs.container_invalid_value", { value: setting.raw }));
    return runtimePaths.logsDirPath;
  }

  let location: LogLocation;
  if (setting.kind === "valid") {
    location = setting.value;
  } else if (fromRealEnv) {
    warn(translate("runtime.logs.location_invalid_env", { value: setting.raw }));
    location = "default";
  } else if (options.prompt === false) {
    warn(translate("runtime.logs.location_invalid", { value: setting.raw }));
    location = "default";
  } else {
    const answered = isInteractive
      ? await promptForLogLocation(setting.raw, runtimePaths.envFilePath, ask, warn, translate)
      : null;
    if (answered === null) {
      warn(
        translate(
          isInteractive
            ? "runtime.logs.location_invalid_gave_up"
            : "runtime.logs.location_invalid_no_tty",
          { value: setting.raw },
        ),
      );
    }
    location = answered ?? "default";
  }

  if (location === "default" && setting.kind === "valid" && isContainerRuntime({ env })) {
    warn(translate("runtime.logs.container_overrides_default"));
  }

  return location === "app" ? runtimePaths.logsDirPath : getDefaultDir();
}

// LOG_RETENTION lookup shared by the logger and the daemon manager: the real environment first,
// then the .env file in the app home (config.ts has not loaded it into process.env yet when the
// logger prunes). A missing, unreadable, or unusable value yields the default.
export async function resolveLogRetention(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const env = options.env ?? process.env;

  if (env[LOG_RETENTION_KEY]) {
    return getLogRetention(env);
  }

  try {
    const fileValues = await readEnvFile(getRuntimePaths().envFilePath);
    return getLogRetention(fileValues ?? {});
  } catch {
    return getLogRetention({});
  }
}

// Later callers' options are ignored by design: the first call decides the process-wide result,
// and concurrent callers share that same pending resolution.
export function resolveLogsDirPath(options: ResolveLogsDirOptions = {}): Promise<string> {
  if (!resolvedLogsDir) {
    const pending = resolveLogsDir(options);
    resolvedLogsDir = pending;
    // A rejected resolution must not stay memoized, so the next caller (the daemon manager, for
    // example) retries. The logger does not retry after a failed initialization, by design.
    pending.catch(() => {
      if (resolvedLogsDir === pending) {
        resolvedLogsDir = undefined;
      }
    });
  }
  return resolvedLogsDir;
}

// Matches the existing __resetLoggerForTests convention in src/utils/logger.ts.
export function __resetLogsDirForTests(): void {
  resolvedLogsDir = undefined;
}
