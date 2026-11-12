import { promises as fs } from "node:fs";
import path from "node:path";
import { INTEGRITY_CHECKSUM_ACCOUNT, INTEGRITY_USER_ID_ACCOUNT } from "../secrets/integrity.js";
import { KEYCHAIN_SERVICE_NAME } from "../secrets/keychain-secret-store.js";
import { SECRET_ENV_VARS } from "../secrets/migrate-secrets.js";

/** Keychain service name under which the bot stores its secrets. */
export const KEYCHAIN_SERVICE: string = KEYCHAIN_SERVICE_NAME;

/** Keychain accounts the bot may create under {@link KEYCHAIN_SERVICE}. */
export const STORED_KEYCHAIN_ACCOUNTS: readonly string[] = [
  ...Object.values(SECRET_ENV_VARS),
  INTEGRITY_CHECKSUM_ACCOUNT,
  INTEGRITY_USER_ID_ACCOUNT,
];

export interface StoredEntry {
  name: string;
  kind: "file" | "dir";
}

/** Entries the bot creates directly inside the app home. */
export const STORED_APP_HOME_ENTRIES: readonly StoredEntry[] = [
  { name: ".env", kind: "file" },
  { name: ".env.bak", kind: "file" },
  { name: "settings.json", kind: "file" },
  { name: "settings.json.bak", kind: "file" },
  { name: "settings.json.tmp", kind: "file" },
  { name: "secrets.enc", kind: "file" },
  { name: "keystore_password", kind: "file" },
  { name: "run", kind: "dir" },
  { name: "local-commands", kind: "dir" },
];

/** Names of interrupted atomic writes (`<name>.<pid>.<uuid>.tmp`) left next to stored files. */
export const STORED_TEMP_SIBLING_PATTERNS: readonly RegExp[] = [
  /^\.env\.[^.]+\.[^.]+\.tmp$/,
  /^secrets\.enc\.[^.]+\.[^.]+\.tmp$/,
];

/** App-home entries that an uninstall keeps. */
export const PRESERVED_APP_HOME_ENTRIES: readonly string[] = ["logs"];

/**
 * Returns absolute paths of stored entries and temp siblings that exist in the app home.
 * Existence is checked with lstat, so dangling symlinks are listed. Preserved entries are
 * never returned.
 */
export async function listAppHomeTargets(appHome: string): Promise<string[]> {
  const names = new Set<string>(STORED_APP_HOME_ENTRIES.map((entry) => entry.name));

  let children: string[] = [];
  try {
    children = await fs.readdir(appHome);
  } catch {
    // A missing or unreadable app home has no temp siblings to find.
  }
  for (const child of children) {
    if (STORED_TEMP_SIBLING_PATTERNS.some((pattern) => pattern.test(child))) {
      names.add(child);
    }
  }

  const targets: string[] = [];
  for (const name of names) {
    if (PRESERVED_APP_HOME_ENTRIES.includes(name)) {
      continue;
    }
    const target = path.join(appHome, name);
    try {
      await fs.lstat(target);
      targets.push(target);
    } catch {
      // Not present.
    }
  }
  return targets;
}
