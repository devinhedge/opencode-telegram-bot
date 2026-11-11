import { createHash } from "node:crypto";
import type { SecretStore } from "./secret-store.js";

/**
 * Computes a canonical SHA-256 checksum of the given values.
 * Uses deterministic JSON serialization (sorted keys) to ensure
 * consistent checksums regardless of key order.
 */
export function computeChecksum(values: Record<string, unknown>): string {
  // Canonical JSON: sort keys, remove undefined values, handle null
  const canonical = canonicalize(values);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Canonicalizes an object for deterministic serialization:
 * - Sorts keys alphabetically
 * - Removes undefined values
 * - Preserves null values
 * - Recursively canonicalizes nested objects
 */
function canonicalize(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    if (value === undefined) {
      continue; // Skip undefined
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      result[key] = value;
    } else {
      result[key] = canonicalize(value as Record<string, unknown>);
    }
  }

  return result;
}

export interface IntegrityData {
  checksum: string;
  userId: string;
}

const INTEGRITY_CHECKSUM_ACCOUNT = "integrity_checksum";
const INTEGRITY_USER_ID_ACCOUNT = "integrity_user_id";

/**
 * Verifies the integrity of stored secrets by comparing checksums
 * and validating the allowed user ID.
 *
 * @throws Error with generic message if integrity check fails (no secret leakage)
 */
export async function verifyIntegrity(
  store: SecretStore,
  envValues: Record<string, string | undefined>
): Promise<void> {
  // Retrieve stored integrity data
  const [storedChecksum, storedUserId] = await Promise.all([
    store.getSecret(INTEGRITY_CHECKSUM_ACCOUNT),
    store.getSecret(INTEGRITY_USER_ID_ACCOUNT),
  ]);

  // First run: no checksum stored yet, skip verification (baseline will be stored by caller)
  if (!storedChecksum) {
    return;
  }

  if (!storedUserId) {
    throw new Error("Integrity verification failed: missing user ID");
  }

  // Compute checksum from current env values (only the protected fields)
  const protectedValues = extractProtectedValues(envValues);
  const computedChecksum = computeChecksum(protectedValues);

  // Compare checksums
  if (computedChecksum !== storedChecksum) {
    throw new Error("Integrity verification failed: checksum mismatch");
  }

  // Verify allowed user ID
  const currentUserId = envValues.allowedUserId;
  if (currentUserId !== undefined && currentUserId !== storedUserId) {
    throw new Error("Integrity verification failed: user ID mismatch");
  }
}

/**
 * Extracts the values that are protected by integrity checking.
 * These are the secret values that should not be tampered with.
 * Note: allowedUserId is verified separately, not included in checksum.
 */
function extractProtectedValues(
  envValues: Record<string, string | undefined>
): Record<string, unknown> {
  const protectedKeys = [
    "telegramBotToken",
    "telegramProxySecret",
    "opencodeServerPassword",
    "sttApiKey",
    "ttsApiKey",
    "docExtractorApiKey",
  ] as const;

  const result: Record<string, unknown> = {};

  for (const key of protectedKeys) {
    const value = envValues[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Stores integrity data (checksum and user ID) for the given values.
 * Should be called after successfully loading/storing secrets.
 */
export async function storeIntegrityData(
  store: SecretStore,
  envValues: Record<string, string | undefined>
): Promise<void> {
  const protectedValues = extractProtectedValues(envValues);
  const checksum = computeChecksum(protectedValues);
  const userId = envValues.allowedUserId;

  await Promise.all([
    store.setSecret(INTEGRITY_CHECKSUM_ACCOUNT, checksum),
    ...(userId !== undefined
      ? [store.setSecret(INTEGRITY_USER_ID_ACCOUNT, userId)]
      : []),
  ]);
}

export { INTEGRITY_CHECKSUM_ACCOUNT, INTEGRITY_USER_ID_ACCOUNT };