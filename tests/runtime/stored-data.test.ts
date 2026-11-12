import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYCHAIN_SERVICE_NAME } from "../../src/secrets/keychain-service.js";
import {
  KEYCHAIN_SERVICE,
  PRESERVED_APP_HOME_ENTRIES,
  STORED_APP_HOME_ENTRIES,
  STORED_KEYCHAIN_ACCOUNTS,
  listAppHomeTargets,
} from "../../src/runtime/stored-data.js";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const SECRETS_DIR = path.join(SRC_ROOT, "secrets");
const INVENTORY_FILE = path.join(SRC_ROOT, "runtime", "stored-data.ts");

/**
 * Files in src whose secret-store calls pass the account as a variable or constant instead of a
 * literal. A call with a non-literal account in any other file fails the guard test, which forces
 * a review of the inventory.
 */
const INDIRECT_CALL_SITES = new Set([
  // Passes INTEGRITY_CHECKSUM_ACCOUNT and INTEGRITY_USER_ID_ACCOUNT (both in the inventory).
  "secrets/integrity.ts",
  // Passes accounts taken from SECRET_ENV_VARS values (all in the inventory).
  "secrets/migrate-secrets.ts",
  // Passes accounts taken from SECRET_ENV_VARS in its migration helper.
  "runtime/bootstrap.ts",
  // Passes accounts taken from its SECRET_ACCOUNTS map.
  "config.ts",
]);

/** Account constants that are read-only probes and never stored. */
const NON_STORED_ACCOUNT_CONSTANTS = new Set(["PROBE_ACCOUNT"]);

const CALL_PATTERN = /\b(?:set|get|delete|remove)Secret\(/g;
const LITERAL_PATTERN = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const ACCOUNT_CONSTANT_PATTERN =
  /\b(?:export\s+)?const\s+(\w*ACCOUNT\w*)\s*(?::[^=]+)?=\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;

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

async function collectSecretCalls(): Promise<SecretCall[]> {
  const calls: SecretCall[] = [];
  for (const file of await listTsFiles(SRC_ROOT)) {
    if (file === INVENTORY_FILE) {
      continue;
    }
    const content = await fs.readFile(file, "utf-8");
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    for (const match of content.matchAll(CALL_PATTERN)) {
      const rest = content.slice(match.index + match[0].length);
      // A method definition or interface member, not a call: `getSecret(account: string)`.
      if (/^\s*\w+\s*:/.test(rest)) {
        continue;
      }
      const literal = LITERAL_PATTERN.exec(rest);
      const quote = literal?.[1];
      const text = literal?.[2] ?? "";
      const interpolated = quote === "`" && text.includes("${");
      calls.push({
        file: relative,
        literal: literal !== null && !interpolated ? text : null,
        argument: (rest.split(/[,)]/)[0] ?? "").trim(),
      });
    }
  }
  return calls;
}

describe("runtime/stored-data", () => {
  let appHome: string;
  const tempSuffix = `${process.pid}.${randomUUID()}.tmp`;

  beforeEach(async () => {
    appHome = await fs.mkdtemp(path.join(os.tmpdir(), "stored-data-"));
  });

  afterEach(async () => {
    await fs.rm(appHome, { recursive: true, force: true });
  });

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

  describe("keychain account guard", () => {
    it("covers every literal account passed to the secret store in src", async () => {
      const calls = await collectSecretCalls();
      const literals = calls.filter((call) => call.literal !== null);

      expect(calls.length).toBeGreaterThan(0);
      expect(literals.length).toBeGreaterThan(0);
      for (const call of literals) {
        expect(
          STORED_KEYCHAIN_ACCOUNTS,
          `${call.file} passes the account "${call.literal}" which is not in the inventory`,
        ).toContain(call.literal);
      }
    });

    it("limits non-literal account arguments to known indirect call sites", async () => {
      const calls = await collectSecretCalls();
      const indirect = calls.filter((call) => call.literal === null);

      expect(indirect.length).toBeGreaterThan(0);
      for (const call of indirect) {
        expect(
          INDIRECT_CALL_SITES.has(call.file),
          `${call.file} passes "${call.argument}" as an account; review the inventory and list the file`,
        ).toBe(true);
      }
    });

    it("covers every account constant defined in src/secrets", async () => {
      let inspected = 0;
      for (const file of await listTsFiles(SECRETS_DIR)) {
        const content = await fs.readFile(file, "utf-8");
        for (const match of content.matchAll(ACCOUNT_CONSTANT_PATTERN)) {
          if (NON_STORED_ACCOUNT_CONSTANTS.has(match[1] ?? "")) {
            continue;
          }
          inspected += 1;
          expect(
            STORED_KEYCHAIN_ACCOUNTS,
            `${match[1]} = "${match[3]}" is not in the inventory`,
          ).toContain(match[3]);
        }
      }

      expect(inspected).toBeGreaterThan(0);
    });
  });
});
