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

const MAX_COMMAND_LINE_LENGTH = 4096;
const REDACTED = "***";
// Case-insensitive substrings that mark an option or assignment name as sensitive. Over-masking
// is fine; leaking is not.
const SENSITIVE_PARTS = [
  "token",
  "password",
  "passwd",
  "passphrase",
  "pass",
  "pwd",
  "pw",
  "secret",
  "key",
  "auth",
  "credential",
  "cookie",
  "session",
  "bearer",
];
const HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie"]);
const AUTH_SCHEMES = new Set(["bearer", "basic", "digest", "token"]);

interface Separator {
  // Index in the decoded text of the = or : character.
  decodedIndex: number;
  // Index in the raw token just after that character.
  rawEnd: number;
}

interface Token {
  raw: string;
  decoded: string;
  separators: Separator[];
  unterminated: boolean;
}

type Piece = { space: string } | { token: Token };

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

// One linear pass, shell-like: whitespace separates tokens, quotes group, and a backslash escapes
// the next character outside single quotes. Every character is visited once.
function tokenize(input: string): Piece[] {
  const pieces: Piece[] = [];
  let index = 0;

  while (index < input.length) {
    if (isWhitespace(input.charAt(index))) {
      const start = index;
      while (index < input.length && isWhitespace(input.charAt(index))) {
        index += 1;
      }
      pieces.push({ space: input.slice(start, index) });
      continue;
    }

    const start = index;
    let decoded = "";
    const separators: Separator[] = [];
    let quote: string | null = null;

    while (index < input.length) {
      const char = input.charAt(index);
      if (quote === null && isWhitespace(char)) {
        break;
      }
      if (char === "\\" && quote !== "'") {
        index += 1;
        if (index < input.length) {
          decoded += input.charAt(index);
          index += 1;
        }
        continue;
      }
      if (quote !== null && char === quote) {
        quote = null;
        index += 1;
        continue;
      }
      if (quote === null && (char === '"' || char === "'")) {
        quote = char;
        index += 1;
        continue;
      }
      if (char === "=" || char === ":") {
        separators.push({ decodedIndex: decoded.length, rawEnd: index + 1 - start });
      }
      decoded += char;
      index += 1;
    }

    pieces.push({
      token: { raw: input.slice(start, index), decoded, separators, unterminated: quote !== null },
    });
  }

  return pieces;
}

function stripLeadingDashes(name: string): string {
  let start = 0;
  while (start < name.length && name.charAt(start) === "-") {
    start += 1;
  }
  return name.slice(start);
}

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_PARTS.some((part) => lower.includes(part));
}

// Masks the userinfo of every scheme://userinfo@host: everything between :// and the last @ before
// the next /. Each search resumes after the previous match, so the scan stays linear.
function maskUserinfo(raw: string): string {
  let result = "";
  let position = 0;

  for (;;) {
    const schemeIndex = raw.indexOf("://", position);
    if (schemeIndex < 0) {
      break;
    }
    const authorityStart = schemeIndex + 3;
    const slash = raw.indexOf("/", authorityStart);
    const authorityEnd = slash < 0 ? raw.length : slash;
    const at = raw.slice(authorityStart, authorityEnd).lastIndexOf("@");
    if (at >= 0) {
      result += raw.slice(position, authorityStart) + REDACTED;
      position = authorityStart + at;
    } else {
      result += raw.slice(position, authorityEnd);
      position = authorityEnd;
    }
  }

  return result + raw.slice(position);
}

// Masks secrets in a process command line before it is shown. The input is cut at 4096 characters
// (with "..." appended) and tokenized in one linear pass, with no backtracking regular expressions,
// so hostile input cannot stall it. Rules per token, where a name is sensitive when it contains
// token, password, passwd, passphrase, pass, pwd, pw, secret, key, auth, credential, cookie,
// session, or bearer (case-insensitive):
// - name=value or name:value with a sensitive name masks the whole value, quoted or escaped text
//   included.
// - a sensitive option (--name or -name) without = masks the next token, even if it starts with
//   a dash; -p and -P do too. A trailing option with no value masks nothing more.
// - Authorization:, Proxy-Authorization:, and Cookie: with no value mask every following token;
//   the words Bearer, Basic, Digest, and Token mask the token after them.
// - the userinfo of scheme://userinfo@host is replaced, leaving scheme://***@host.
// - an unterminated quote masks everything from the start of its token to the end (fail closed).
// Known limit: option names in non-English scripts are not detected. This is best effort, not a
// guarantee. Task 10 passes every {command} through this function.
export function redactCommandLine(commandLine: string): string {
  const truncated = commandLine.length > MAX_COMMAND_LINE_LENGTH;
  const input = truncated ? commandLine.slice(0, MAX_COMMAND_LINE_LENGTH) : commandLine;
  const out: string[] = [];
  let maskNext = false;
  let maskRest = false;

  const redactToken = (token: Token): string => {
    if (token.unterminated) {
      maskRest = true;
      return REDACTED;
    }
    if (maskRest) {
      return REDACTED;
    }
    if (maskNext) {
      maskNext = AUTH_SCHEMES.has(token.decoded.toLowerCase());
      return REDACTED;
    }

    let segmentStart = 0;
    for (const separator of token.separators) {
      const name = token.decoded.slice(segmentStart, separator.decodedIndex);
      if (isSensitiveName(name)) {
        if (separator.decodedIndex < token.decoded.length - 1) {
          return token.raw.slice(0, separator.rawEnd) + REDACTED;
        }
        if (HEADER_NAMES.has(stripLeadingDashes(name).toLowerCase())) {
          maskRest = true;
        } else {
          maskNext = true;
        }
        return token.raw;
      }
      segmentStart = separator.decodedIndex + 1;
    }

    if (token.separators.length === 0) {
      if (token.decoded.startsWith("-")) {
        if (token.decoded === "-p" || token.decoded === "-P" || isSensitiveName(token.decoded)) {
          maskNext = true;
        }
      } else if (AUTH_SCHEMES.has(token.decoded.toLowerCase())) {
        maskNext = true;
      }
    }

    return maskUserinfo(token.raw);
  };

  for (const piece of tokenize(input)) {
    out.push("space" in piece ? piece.space : redactToken(piece.token));
  }

  return out.join("") + (truncated ? "..." : "");
}
