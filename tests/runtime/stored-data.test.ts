import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INTEGRITY_CHECKSUM_ACCOUNT,
  INTEGRITY_USER_ID_ACCOUNT,
} from "../../src/secrets/integrity.js";
import { KEYCHAIN_SERVICE_NAME } from "../../src/secrets/keychain-secret-store.js";
import { SECRET_ENV_VARS } from "../../src/secrets/migrate-secrets.js";
import {
  KEYCHAIN_SERVICE,
  PRESERVED_APP_HOME_ENTRIES,
  STORED_APP_HOME_ENTRIES,
  STORED_KEYCHAIN_ACCOUNTS,
  listAppHomeTargets,
} from "../../src/runtime/stored-data.js";

const SRC_ROOT = path.resolve(__dirname, "../../src");

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

describe("runtime/stored-data", () => {
  let appHome: string;

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

  it("lists the SECRET_ENV_VARS accounts plus both integrity accounts", () => {
    expect([...STORED_KEYCHAIN_ACCOUNTS].sort()).toEqual(
      [
        ...Object.values(SECRET_ENV_VARS),
        INTEGRITY_CHECKSUM_ACCOUNT,
        INTEGRITY_USER_ID_ACCOUNT,
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
    await fs.writeFile(path.join(appHome, ".env.1.abc.tmp"), "x");
    await fs.writeFile(path.join(appHome, "secrets.enc.1.abc.tmp"), "x");
    await fs.mkdir(path.join(appHome, "logs"));
    await fs.writeFile(path.join(appHome, "notes.txt"), "x");

    const targets = await listAppHomeTargets(appHome);

    const expected = [
      ...STORED_APP_HOME_ENTRIES.map((entry) => path.join(appHome, entry.name)),
      path.join(appHome, ".env.1.abc.tmp"),
      path.join(appHome, "secrets.enc.1.abc.tmp"),
    ];
    expect([...targets].sort()).toEqual(expected.sort());
  });

  it("returns an empty list when the app home does not exist", async () => {
    expect(await listAppHomeTargets(path.join(appHome, "missing"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("lists a dangling symlink named .env", async () => {
    await fs.symlink(path.join(appHome, "nowhere"), path.join(appHome, ".env"));

    expect(await listAppHomeTargets(appHome)).toEqual([path.join(appHome, ".env")]);
  });

  it("covers every keychain account literal used in src", async () => {
    const pattern = /(?:set|get|delete)Secret\(\s*"([a-z_]+)"/g;
    const found = new Set<string>();
    for (const file of await listTsFiles(SRC_ROOT)) {
      const content = await fs.readFile(file, "utf-8");
      for (const match of content.matchAll(pattern)) {
        found.add(match[1] ?? "");
      }
    }

    expect(found.size).toBeGreaterThan(0);
    for (const account of found) {
      expect(STORED_KEYCHAIN_ACCOUNTS).toContain(account);
    }
  });
});
