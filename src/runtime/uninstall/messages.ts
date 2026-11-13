import fs from "node:fs/promises";
import dotenv from "dotenv";
// The uninstaller never initializes the file logger: do not import src/utils/logger.ts here,
// directly or transitively.
import type { I18nKey } from "../../i18n/en.js";
import { resolveSupportedLocale, t, type Locale } from "../../i18n/index.js";

export type UninstallTranslator = (
  key: I18nKey,
  params?: Record<string, string | number>,
) => string;

const BOT_LOCALE_KEY = "BOT_LOCALE";

// The CLI does not load .env into the environment, and this runs before .env is deleted, so
// BOT_LOCALE may exist only in the file. A non-blank value in the real environment wins over the
// file even when it is unsupported (the result is then undefined: English). Only a blank or
// absent environment value falls through to the file. A missing or unreadable file, or an
// unsupported value, yields undefined: the locale is a convenience and must never stop or block
// the uninstall.
export async function resolveUninstallLocale(
  env: NodeJS.ProcessEnv,
  envFilePath: string,
): Promise<Locale | undefined> {
  const fromEnv = env[BOT_LOCALE_KEY];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return resolveSupportedLocale(fromEnv) ?? undefined;
  }

  try {
    const content = await fs.readFile(envFilePath, "utf-8");
    return resolveSupportedLocale(dotenv.parse(content)[BOT_LOCALE_KEY]) ?? undefined;
  } catch {
    return undefined;
  }
}

// Translates with an explicit locale so the global runtime locale is never mutated. An undefined
// locale is English, never the process BOT_LOCALE: the resolver already decided.
export function createUninstallTranslator(locale: Locale | undefined): UninstallTranslator {
  return (key, params) => t(key, params, locale ?? "en");
}

const SENSITIVE_NAME = "(?:token|password|passwd|secret|key|auth|credential)";
const NAME_CHARS = "[A-Za-z0-9_.-]*";
const VALUE = "(?:\"[^\"]*\"|'[^']*'|[^\\s\"']+)";
const REDACTED = "***";

const USERINFO_PATTERN = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]*:[^/\s@]*@/g;
const AUTHORIZATION_PATTERN = new RegExp(
  `(authorization\\s*[:=]\\s*(?:bearer\\s+|basic\\s+|token\\s+)?)${VALUE}`,
  "gi",
);
const ASSIGNMENT_PATTERN = new RegExp(
  `(${NAME_CHARS}${SENSITIVE_NAME}${NAME_CHARS}=)${VALUE}`,
  "gi",
);
const OPTION_VALUE_PATTERN = new RegExp(
  `(\\s--?${NAME_CHARS}${SENSITIVE_NAME}${NAME_CHARS}\\s+)(?!-)${VALUE}`,
  "gi",
);

// Masks secrets in a process command line before it is shown: URL userinfo, an Authorization
// header value, NAME=value and --name=value assignments, and the value after --name, where the
// name contains token, password, passwd, secret, key, auth, or credential. Over-masking is
// acceptable; leaking is not. Task 10 passes every {command} through this function.
export function redactCommandLine(commandLine: string): string {
  return commandLine
    .replace(USERINFO_PATTERN, `$1${REDACTED}@`)
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
    .replace(ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(OPTION_VALUE_PATTERN, `$1${REDACTED}`);
}
