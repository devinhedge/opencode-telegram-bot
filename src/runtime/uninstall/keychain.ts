import type { KeychainSecretStore } from "../../secrets/keychain-secret-store.js";
import { STORED_KEYCHAIN_ACCOUNTS } from "../stored-data.js";

export type KeychainRemovalStore = Pick<KeychainSecretStore, "isAvailable" | "removeSecret">;

export interface KeychainRemoval {
  available: boolean;
  results: { account: string; status: "removed" | "absent" | "failed" }[];
}

/**
 * Removes each account from the OS keychain and reports per-account status. Never reads or
 * returns a secret value.
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
