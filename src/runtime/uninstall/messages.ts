import { constants } from "node:fs";
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
// A null path (the app home is unknown) uses the environment only. The file is opened without
// blocking (O_NONBLOCK where the platform has it), the open handle is checked to be a regular file
// (a symlink to one is fine), and the content is read from that same handle, so a FIFO or device
// at the path can never block the run and nothing can be swapped in between check and read.
export async function resolveUninstallLocale(
  env: NodeJS.ProcessEnv,
  envFilePath: string | null,
): Promise<Locale | undefined> {
  const fromEnv = env[BOT_LOCALE_KEY];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return resolveSupportedLocale(fromEnv) ?? undefined;
  }
  if (envFilePath === null) {
    return undefined;
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(envFilePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) {
      return undefined;
    }
    const content = await handle.readFile("utf-8");
    return resolveSupportedLocale(dotenv.parse(content)[BOT_LOCALE_KEY]) ?? undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Translates with an explicit locale so the global runtime locale is never mutated. An undefined
// locale is English, never the process BOT_LOCALE: the resolver already decided.
export function createUninstallTranslator(locale: Locale | undefined): UninstallTranslator {
  return (key, params) => t(key, params, locale ?? "en");
}

const MAX_COMMAND_LINE_LENGTH = 4096;
const REDACTED = "***";
// Path characters, after an optional Windows drive prefix that needs a following separator so
// that C:SECRET is not a path.
const EXECUTABLE_PATTERN = /^(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.\/+@~\\-]+$/;
const SCRIPT_PATTERN = /^(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.\/+@~\\-]+\.(?:js|mjs|cjs|ts)$/;
const NUMBER_PATTERN = /^\d{1,5}$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const WHITESPACE_PATTERN = /\s/;
const KNOWN_FLAGS = new Set([
  "--daemon",
  "--restart",
  "--mode",
  "--port",
  "--hostname",
  "--print-logs",
  "--no-warnings",
  "--enable-source-maps",
  "--help",
  "-h",
]);
const KNOWN_WORDS = new Set([
  "start",
  "stop",
  "status",
  "config",
  "serve",
  "uninstall",
  "installed",
  "sources",
  "localhost",
  "v1",
  "v2",
]);

function isSeparator(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x20 || code === 0x7f || WHITESPACE_PATTERN.test(char);
}

// Splits on Unicode whitespace, NUL, and the other control characters. One pass, no quote or
// escape handling: a quote or backslash is just a character that makes a token unknown.
function splitTokens(input: string): string[] {
  const tokens: string[] = [];
  let start = -1;

  for (let index = 0; index < input.length; index += 1) {
    if (isSeparator(input.charAt(index))) {
      if (start >= 0) {
        tokens.push(input.slice(start, index));
        start = -1;
      }
    } else if (start < 0) {
      start = index;
    }
  }
  if (start >= 0) {
    tokens.push(input.slice(start));
  }

  return tokens;
}

function isAllowedWord(token: string): boolean {
  return KNOWN_WORDS.has(token) || NUMBER_PATTERN.test(token) || IPV4_PATTERN.test(token);
}

function isAllowedFlag(token: string): boolean {
  if (KNOWN_FLAGS.has(token)) {
    return true;
  }
  const equals = token.indexOf("=");
  return (
    equals > 0 && KNOWN_FLAGS.has(token.slice(0, equals)) && isAllowedWord(token.slice(equals + 1))
  );
}

function isAllowedToken(token: string, isFirst: boolean): boolean {
  if (isFirst && !token.startsWith("-") && EXECUTABLE_PATTERN.test(token)) {
    return true;
  }
  return SCRIPT_PATTERN.test(token) || isAllowedFlag(token) || isAllowedWord(token);
}

// Hides everything in a process command line that is not known to be safe before it is shown. This
// is an allow-list and fails closed: the input is cut at 4096 characters ("..." appended), split on
// Unicode whitespace and control characters, and every token is replaced with *** unless it is
// (a) the first token and looks like an executable path (not starting with a dash, no =), (b) a
// script path ending in .js, .mjs, .cjs, or .ts, (c) a known flag, alone or as flag=value with an
// allowed value, or (d) a known word, a number of up to five digits, or a dotted IPv4 address.
// Paths may contain @ and ~, and may start with a Windows drive such as C:\ and use backslashes.
// Output tokens are joined with a single space. When the cut falls inside a token, that last token
// is a fragment that could prefix a longer secret, so it is masked too.
// Unknown text is hidden, so readability is deliberately limited: unknown arguments, options,
// URLs, assignments, quoted text, package names such as @scope/pkg, and non-English text all show
// as ***. Accepted residual exposures, pinned by tests so a change is deliberate: a standalone
// token of up to five digits is shown; the first token is shown when it matches the executable
// pattern; any token ending in .js, .mjs, .cjs, or .ts is shown; and --flag=<number|word|IPv4>
// values are shown for known flags. There is no deny-list, no quote or escape parsing, and no
// regular expression over the whole input, so hostile input cannot stall it. Task 10 passes every
// {command} through this function.
export function redactCommandLine(commandLine: string): string {
  const truncated = commandLine.length > MAX_COMMAND_LINE_LENGTH;
  const input = truncated ? commandLine.slice(0, MAX_COMMAND_LINE_LENGTH) : commandLine;
  const tokens = splitTokens(input);
  const cutInsideToken =
    truncated &&
    !isSeparator(input.charAt(input.length - 1)) &&
    !isSeparator(commandLine.charAt(MAX_COMMAND_LINE_LENGTH));
  const lastIndex = tokens.length - 1;
  const redacted = tokens.map((token, index) =>
    (cutInsideToken && index === lastIndex) || !isAllowedToken(token, index === 0)
      ? REDACTED
      : token,
  );

  return redacted.join(" ") + (truncated ? "..." : "");
}
