import { promises as fs } from "node:fs";
import path from "node:path";
import type { SecretStore } from "./secret-store.js";
import { KeychainSecretStore } from "./keychain-secret-store.js";
import { EncryptedFileSecretStore } from "./encrypted-file-secret-store.js";

export interface CreateSecretStoreOptions {
  appHome: string;
  passwordSource?: string | (() => string | null | undefined | Promise<string | null | undefined>);
}

const CONTAINER_PASSWORD_PATHS = ["/run/secrets/keystore_password"];

async function resolvePassword(
  source: CreateSecretStoreOptions["passwordSource"],
  appHome: string,
): Promise<string | null> {
  if (typeof source === "function") {
    const value = await source();
    if (typeof value === "string" && value.length > 0) return value;
  } else if (typeof source === "string" && source.length > 0) {
    // Treat a string as either a literal password or a file path if it exists.
    try {
      const stat = await fs.stat(source);
      if (stat.isFile()) {
        const content = await fs.readFile(source, "utf8");
        const trimmed = content.trim();
        if (trimmed.length > 0) return trimmed;
      }
    } catch {
      // Not a file path; use as literal password.
    }
    return source;
  }

  // Container / tmpfs resolution.
  for (const candidate of [...CONTAINER_PASSWORD_PATHS, path.join(appHome, "keystore_password")]) {
    try {
      const content = await fs.readFile(candidate, "utf8");
      const trimmed = content.trim();
      if (trimmed.length > 0) return trimmed;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

export async function createSecretStore(options: CreateSecretStoreOptions): Promise<SecretStore> {
  const keychain = new KeychainSecretStore();
  if (await keychain.isAvailable()) {
    return keychain;
  }

  const password = await resolvePassword(options.passwordSource, options.appHome);
  if (!password) {
    throw new Error("No password source available for encrypted secret store");
  }

  const filePath = path.join(options.appHome, "secrets.enc");
  const store = new EncryptedFileSecretStore(filePath);
  await store.unlock(password);
  return store;
}