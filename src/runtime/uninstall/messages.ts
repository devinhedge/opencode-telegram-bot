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
// BOT_LOCALE may exist only in the file. The real environment wins over the file. A missing or
// unreadable file, or an unsupported value, yields undefined (the translator then uses the
// default locale): the locale is a convenience and must never stop the uninstall.
export async function resolveUninstallLocale(
  env: NodeJS.ProcessEnv,
  envFilePath: string,
): Promise<Locale | undefined> {
  const fromEnv = resolveSupportedLocale(env[BOT_LOCALE_KEY]);
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const content = await fs.readFile(envFilePath, "utf-8");
    return resolveSupportedLocale(dotenv.parse(content)[BOT_LOCALE_KEY]) ?? undefined;
  } catch {
    return undefined;
  }
}

// Translates with an explicit locale so the global runtime locale is never mutated.
export function createUninstallTranslator(locale: Locale | undefined): UninstallTranslator {
  return (key, params) => t(key, params, locale);
}
