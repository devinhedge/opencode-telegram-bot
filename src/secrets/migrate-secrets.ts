import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { SecretStore } from "./secret-store.js";
import { hardenEnvFile } from "./file-permissions.js";

/**
 * Environment variable names that are considered secrets and should be migrated to the secret store.
 * The value is the corresponding account name in the secret store.
 */
export const SECRET_ENV_VARS = {
  TELEGRAM_BOT_TOKEN: "telegram_bot_token",
  TELEGRAM_PROXY_SECRET: "telegram_proxy_secret",
  OPENCODE_SERVER_PASSWORD: "opencode_server_password",
  STT_API_KEY: "stt_api_key",
  TTS_API_KEY: "tts_api_key",
  DOC_EXTRACTOR_API_KEY: "doc_extractor_api_key",
  TELEGRAM_ALLOWED_USER_ID: "allowed_user_id",
} as const;

export type SecretEnvVar = keyof typeof SECRET_ENV_VARS;
export type SecretAccount = (typeof SECRET_ENV_VARS)[SecretEnvVar];

export interface MigrationResult {
  /** Whether migration was performed. */
  migrated: boolean;
  /** Number of secrets migrated. */
  secretsMigrated: number;
}

/**
 * Parses .env file content into key-value pairs.
 * Ignores comments and empty lines.
 */
function parseEnv(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) {
      result.set(key, value);
    }
  }
  return result;
}

/**
 * Serializes key-value pairs to .env format.
 */
function serializeEnv(env: Map<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of env) {
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/**
 * Checks if there are any secret environment variables in the parsed env.
 */
function hasSecrets(env: Map<string, string>): boolean {
  for (const key of env.keys()) {
    if (key in SECRET_ENV_VARS) return true;
  }
  return false;
}

/**
 * Migrates secrets from .env file to the secret store.
 *
 * This function is idempotent - it only migrates if secrets are found in the .env file.
 * On success:
 * - All secret values are written to the store
 * - Reads are verified against the store
 * - .env is rewritten atomically without the secret keys
 * - .env.bak is created with the original content (including secrets)
 *
 * On any failure:
 * - .env is left completely unchanged
 * - .env.bak is not created
 * - Error is thrown
 *
 * @param store - The secret store to migrate secrets to
 * @param envFilePath - Path to the .env file
 * @returns Migration result indicating whether migration occurred and how many secrets were migrated
 */
export async function migrateSecretsIfNeeded(
  store: SecretStore,
  envFilePath: string,
): Promise<MigrationResult> {
  // Read the .env file
  let originalContent: string;
  try {
    originalContent = await fs.readFile(envFilePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No .env file - nothing to migrate
      return { migrated: false, secretsMigrated: 0 };
    }
    throw err;
  }

  const env = parseEnv(originalContent);

  // Check if there are any secrets to migrate
  if (!hasSecrets(env)) {
    return { migrated: false, secretsMigrated: 0 };
  }

  // Extract secrets and non-secrets
  const secrets = new Map<SecretAccount, string>();
  const nonSecrets = new Map<string, string>();

  for (const [key, value] of env) {
    if (key in SECRET_ENV_VARS) {
      const account = SECRET_ENV_VARS[key as SecretEnvVar];
      secrets.set(account, value);
    } else {
      nonSecrets.set(key, value);
    }
  }

  // Write all secrets to the store
  for (const [account, value] of secrets) {
    await store.setSecret(account, value);
  }

  // Verify reads - ensure all secrets can be read back
  for (const [account, expectedValue] of secrets) {
    const actualValue = await store.getSecret(account);
    if (actualValue !== expectedValue) {
      // Verification failed - rollback by deleting what we wrote
      for (const [acc] of secrets) {
        try {
          await store.deleteSecret(acc);
        } catch {
          // Best effort cleanup
        }
      }
      throw new Error(`Secret verification failed for account: ${account}`);
    }
  }

  // Atomically rewrite .env without secrets
  // Use a temporary file and atomic rename
  const tempFilePath = join(dirname(envFilePath), `.env.${randomUUID()}.tmp`);
  const bakFilePath = `${envFilePath}.bak`;

  try {
    // Write cleaned .env to temp file
    const cleanedContent = serializeEnv(nonSecrets);
    await fs.writeFile(tempFilePath, cleanedContent, "utf8");

    // Create .env.bak with original content (atomic write)
    await fs.writeFile(bakFilePath, originalContent, "utf8");

    // Atomically replace .env with cleaned version
    await fs.rename(tempFilePath, envFilePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // Ignore
    }
    // Clean up .env.bak on failure
    try {
      await fs.unlink(bakFilePath);
    } catch {
      // Ignore
    }
    throw err;
  }

  // Harden file permissions after migration (0600 for owner read/write)
  await hardenEnvFile(envFilePath);

  return { migrated: true, secretsMigrated: secrets.size };
}

export default migrateSecretsIfNeeded;