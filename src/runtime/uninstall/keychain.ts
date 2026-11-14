import type { KeychainSecretStore } from "../../secrets/keychain-secret-store.js";
import { STORED_KEYCHAIN_ACCOUNTS } from "../stored-data.js";

export type KeychainRemovalStore = Pick<KeychainSecretStore, "isAvailable" | "removeSecret">;

export interface KeychainRemoval {
  available: boolean;
  results: { account: string; status: "removed" | "absent" | "failed" }[];
}

/**
 * Removes each account from the OS keychain and reports per-account status. An unavailable
 * store returns `available: false` with empty results; the caller must report that. Never reads
 * a stored secret (`isAvailable` probes a dedicated probe account).
 */
export async function removeKeychainAccounts(
  store: KeychainRemovalStore,
  accounts: readonly string[] = STORED_KEYCHAIN_ACCOUNTS,
): Promise<KeychainRemoval> {
  if (!(await store.isAvailable())) {
    return { available: false, results: [] };
  }

  const results: KeychainRemoval["results"] = [];
  for (const account of accounts) {
    results.push({ account, status: await store.removeSecret(account) });
  }

  return { available: true, results };
}
