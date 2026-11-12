import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KEYCHAIN_SERVICE_NAME } from "../../src/secrets/keychain-service.js";
import {
  KEYCHAIN_SERVICE,
  PRESERVED_APP_HOME_ENTRIES,
  STORED_APP_HOME_ENTRIES,
  STORED_KEYCHAIN_ACCOUNTS,
  listAppHomeTargets,
} from "../../src/runtime/stored-data.js";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const INVENTORY_FILE = path.join(SRC_ROOT, "runtime", "stored-data.ts");

const GUARD_TIMEOUT_MS = 60_000;

/**
 * Files in src whose secret-store calls pass the account as a variable or constant instead of a
 * literal, with the exact argument expressions each file may pass. A non-literal call in any
 * other file, or a new or changed expression in a listed file, fails the guard test, which
 * forces a review of the inventory.
 */
const INDIRECT_CALL_SITES: Record<string, string[]> = {
  // Passes INTEGRITY_CHECKSUM_ACCOUNT and INTEGRITY_USER_ID_ACCOUNT (both in the inventory).
  "secrets/integrity.ts": ["INTEGRITY_CHECKSUM_ACCOUNT", "INTEGRITY_USER_ID_ACCOUNT"],
  // Passes accounts taken from SECRET_ENV_VARS values (all in the inventory).
  "secrets/migrate-secrets.ts": ["account", "acc"],
  // Passes accounts taken from SECRET_ENV_VARS in its migration helper.
  "runtime/bootstrap.ts": ["account"],
  // Passes accounts taken from its SECRET_ACCOUNTS map.
  "config.ts": ["account"],
};

/** Account constants that are read-only probes and never stored. */
const NON_STORED_ACCOUNT_CONSTANTS = new Set(["PROBE_ACCOUNT"]);

const CALL_PATTERN = /\b(?:set|get|delete|remove)Secret\(/g;
const LITERAL_PATTERN = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/;
// Covers constants whose name contains "account" (any case) and whose initializer is a plain
// string literal. Constants built from templates or expressions are not matched here; their
// values reach the store only through a non-literal call, which the indirect call site record
// pins per file.
const ACCOUNT_CONSTANT_PATTERN =
  /\b(?:export\s+)?const\s+(\w*account\w*)\s*(?::[^=]+)?=\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/gi;

/**
 * Returns the trimmed text of the first call argument, given the source right after the opening
 * parenthesis: reads up to the top-level comma or the closing parenthesis of the call, balancing
 * (), [] and {} and skipping string literals.
 */
function readFirstArgument(rest: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest.charAt(index);
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        return rest.slice(0, index).trim();
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return rest.slice(0, index).trim();
    }
  }
  return rest.trim();
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listTsFiles(full);
      }
      return entry.name.endsWith(".ts") ? [full] : [];
    }),
  );
  return nested.flat();
}

interface SecretCall {
  file: string;
  literal: string | null;
  argument: string;
}

interface AccountConstant {
  file: string;
  name: string;
  value: string;
}

interface SourceScan {
  calls: SecretCall[];
  accountConstants: AccountConstant[];
}

/** Reads every src file once (except the inventory) and collects secret-store calls and constants. */
async function scanSource(): Promise<SourceScan> {
  const calls: SecretCall[] = [];
  const accountConstants: AccountConstant[] = [];
  for (const file of await listTsFiles(SRC_ROOT)) {
    if (file === INVENTORY_FILE) {
      continue;
    }
    const content = await fs.readFile(file, "utf-8");
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    for (const match of content.matchAll(CALL_PATTERN)) {
      const rest = content.slice(match.index + match[0].length);
      // Skips only method definitions and interface signatures such as
      // `getSecret(account: string)`: an identifier directly followed by a colon (a parameter
      // with a type annotation). A call argument is an expression, and an expression cannot
      // start with `identifier :` (a ternary has `?` first, an object literal starts with `{`).
      if (/^\s*\w+\s*:/.test(rest)) {
        continue;
      }
      const argument = readFirstArgument(rest);
      const literal = LITERAL_PATTERN.exec(argument);
      const interpolated = literal?.[1] === "`" && (literal[2] ?? "").includes("${");
      calls.push({
        file: relative,
        literal: literal !== null && !interpolated ? (literal[2] ?? "") : null,
        argument,
      });
    }
    for (const match of content.matchAll(ACCOUNT_CONSTANT_PATTERN)) {
      accountConstants.push({ file: relative, name: match[1] ?? "", value: match[3] ?? "" });
    }
  }
  return { calls, accountConstants };
}

describe("runtime/stored-data declarations", () => {
  it("re-exports the keychain service name", () => {
    expect(KEYCHAIN_SERVICE).toBe(KEYCHAIN_SERVICE_NAME);
    expect(KEYCHAIN_SERVICE).toBe("opencode-telegram-bot");
  });

  it("declares exactly the known keychain accounts without duplicates", () => {
    expect(new Set(STORED_KEYCHAIN_ACCOUNTS).size).toBe(STORED_KEYCHAIN_ACCOUNTS.length);
    expect([...STORED_KEYCHAIN_ACCOUNTS].sort()).toEqual(
      [
        "telegram_bot_token",
        "telegram_proxy_secret",
        "opencode_server_password",
        "stt_api_key",
        "tts_api_key",
        "doc_extractor_api_key",
        "allowed_user_id",
        "integrity_checksum",
        "integrity_user_id",
      ].sort(),
    );
  });

  it("preserves logs", () => {
    expect(PRESERVED_APP_HOME_ENTRIES).toEqual(["logs"]);
  });
});

describe("runtime/stored-data listAppHomeTargets", () => {
  let appHome: string;
  const tempSuffix = `${process.pid}.${randomUUID()}.tmp`;

  beforeEach(async () => {
    appHome = await fs.mkdtemp(path.join(os.tmpdir(), "stored-data-"));
  });

  afterEach(async () => {
    await fs.rm(appHome, { recursive: true, force: true });
  });

  it("lists stored entries and temp siblings but not logs or unrelated files", async () => {
    for (const entry of STORED_APP_HOME_ENTRIES) {
      const target = path.join(appHome, entry.name);
      if (entry.kind === "dir") {
        await fs.mkdir(target);
      } else {
        await fs.writeFile(target, "x");
      }
    }
    await fs.writeFile(path.join(appHome, `.env.${tempSuffix}`), "x");
    await fs.writeFile(path.join(appHome, `secrets.enc.${tempSuffix}`), "x");
    await fs.mkdir(path.join(appHome, "logs"));
    await fs.writeFile(path.join(appHome, "notes.txt"), "x");

    const targets = await listAppHomeTargets(appHome);

    const expected = [
      ...STORED_APP_HOME_ENTRIES.map((entry) => path.join(appHome, entry.name)),
      path.join(appHome, `.env.${tempSuffix}`),
      path.join(appHome, `secrets.enc.${tempSuffix}`),
    ];
    expect([...targets].sort()).toEqual(expected.sort());
  });

  it.each([
    ".env.example",
    ".envrc",
    ".env.local.tmp",
    "secrets.enc.tmp",
    ".env.1.not-a-uuid.tmp",
    `.env.abc.${randomUUID()}.tmp`,
    `other.${process.pid}.${randomUUID()}.tmp`,
  ])("does not list %s", async (name) => {
    await fs.writeFile(path.join(appHome, name), "x");

    expect(await listAppHomeTargets(appHome)).toEqual([]);
  });

  it("returns an empty list when the app home does not exist", async () => {
    expect(await listAppHomeTargets(path.join(appHome, "missing"))).toEqual([]);
  });

  it("returns an empty list when the app home is not a directory", async () => {
    const file = path.join(appHome, "file");
    await fs.writeFile(file, "x");

    expect(await listAppHomeTargets(file)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects when the app home is unreadable",
    async () => {
      const locked = path.join(appHome, "locked");
      await fs.mkdir(locked);
      await fs.chmod(locked, 0o000);
      try {
        await expect(listAppHomeTargets(locked)).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await fs.chmod(locked, 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32")("lists a dangling symlink named .env", async () => {
    await fs.symlink(path.join(appHome, "nowhere"), path.join(appHome, ".env"));

    expect(await listAppHomeTargets(appHome)).toEqual([path.join(appHome, ".env")]);
  });

  it.skipIf(process.platform === "win32")(
    "lists a symlink to a directory as a path without following it",
    async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stored-data-outside-"));
      try {
        await fs.writeFile(path.join(outside, ".env"), "x");
        await fs.symlink(outside, path.join(appHome, "run"));

        expect(await listAppHomeTargets(appHome)).toEqual([path.join(appHome, "run")]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("never lists a symlink named logs", async () => {
    await fs.symlink(path.join(appHome, "nowhere"), path.join(appHome, "logs"));

    expect(await listAppHomeTargets(appHome)).toEqual([]);
  });
});

describe("keychain account guard helpers", () => {
  it.each([
    ["account, value);", "account"],
    ["map.get(key), value);", "map.get(key)"],
    ["fn(a, b)", "fn(a, b)"],
    ["cond ? list[0] : { a: 1, b: 2 }.a, v)", "cond ? list[0] : { a: 1, b: 2 }.a"],
    ['"a,)b", v)', '"a,)b"'],
    ["`x${fn(1, 2)}`)", "`x${fn(1, 2)}`"],
  ])("reads the first argument of %s whole", (rest, expected) => {
    expect(readFirstArgument(rest)).toBe(expected);
  });

  it("matches account constants by name in any case", () => {
    const names = [
      ..."const secretAccount = 'x'; export const OTHER_ACCOUNT = `y`;".matchAll(
        ACCOUNT_CONSTANT_PATTERN,
      ),
    ].map((match) => match[1]);

    expect(names).toEqual(["secretAccount", "OTHER_ACCOUNT"]);
  });
});

describe("keychain account guard", () => {
  let scan: SourceScan;

  beforeAll(async () => {
    scan = await scanSource();
  }, GUARD_TIMEOUT_MS);

  it(
    "covers every literal account passed to the secret store in src",
    () => {
      const literals = scan.calls.filter((call) => call.literal !== null);

      expect(scan.calls.length).toBeGreaterThan(0);
      expect(literals.length).toBeGreaterThan(0);
      for (const call of literals) {
        expect(
          STORED_KEYCHAIN_ACCOUNTS,
          `${call.file} passes the account "${call.literal}" which is not in the inventory`,
        ).toContain(call.literal);
      }
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "limits non-literal account arguments to the recorded call sites and expressions",
    () => {
      const found = new Map<string, Set<string>>();
      for (const call of scan.calls.filter((entry) => entry.literal === null)) {
        const expressions = found.get(call.file) ?? new Set<string>();
        expressions.add(call.argument);
        found.set(call.file, expressions);
      }

      expect(found.size).toBeGreaterThan(0);
      for (const [file, expressions] of found) {
        const permitted = INDIRECT_CALL_SITES[file];
        expect(
          permitted,
          `${file} passes ${[...expressions].join(", ")} as an account; review the inventory and record the file`,
        ).toBeDefined();
        expect(
          [...expressions].sort(),
          `${file} changed its non-literal account arguments; review the inventory and update the record`,
        ).toEqual([...(permitted ?? [])].sort());
      }
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "has no stale entry in the indirect call site record",
    async () => {
      const filesWithIndirectCalls = new Set(
        scan.calls.filter((call) => call.literal === null).map((call) => call.file),
      );

      for (const file of Object.keys(INDIRECT_CALL_SITES)) {
        await expect(fs.stat(path.join(SRC_ROOT, file))).resolves.toBeDefined();
        expect(
          filesWithIndirectCalls.has(file),
          `${file} is recorded as an indirect call site but makes no non-literal call`,
        ).toBe(true);
      }
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "covers every account constant defined in src",
    () => {
      const constants = scan.accountConstants.filter(
        (constant) => !NON_STORED_ACCOUNT_CONSTANTS.has(constant.name),
      );

      expect(constants.length).toBeGreaterThan(0);
      for (const constant of constants) {
        expect(
          STORED_KEYCHAIN_ACCOUNTS,
          `${constant.file}: ${constant.name} = "${constant.value}" is not in the inventory`,
        ).toContain(constant.value);
      }
    },
    GUARD_TIMEOUT_MS,
  );
});
