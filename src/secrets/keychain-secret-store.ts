import { AsyncEntry } from "@napi-rs/keyring";
import { KEYCHAIN_SERVICE_NAME } from "./keychain-service.js";
import type { SecretStore } from "./secret-store.js";

const PROBE_ACCOUNT = "__opencode_telegram_bot_availability_probe__";

export class KeychainSecretStore implements SecretStore {
  public readonly name = "keychain";

  async isAvailable(): Promise<boolean> {
    try {
      const entry = new AsyncEntry(KEYCHAIN_SERVICE_NAME, PROBE_ACCOUNT);
      await entry.getPassword();
      return true;
    } catch {
      return false;
    }
  }

  async getSecret(account: string): Promise<string | null> {
    const entry = new AsyncEntry(KEYCHAIN_SERVICE_NAME, account);
    return entry.getPassword();
  }

  async setSecret(account: string, value: string): Promise<void> {
    const entry = new AsyncEntry(KEYCHAIN_SERVICE_NAME, account);
    await entry.setPassword(value);
  }

  async deleteSecret(account: string): Promise<void> {
    const entry = new AsyncEntry(KEYCHAIN_SERVICE_NAME, account);
    try {
      await entry.deletePassword();
    } catch {
      // No-op if absent or unavailable.
    }
  }

  /**
   * Deletes the credential and reports the outcome. The library resolves `true` when it deleted
   * a credential, `false` when none existed, and rejects when the store could not be changed.
   */
  async removeSecret(account: string): Promise<"removed" | "absent" | "failed"> {
    try {
      const entry = new AsyncEntry(KEYCHAIN_SERVICE_NAME, account);
      return (await entry.deletePassword()) ? "removed" : "absent";
    } catch {
      return "failed";
    }
  }
}
