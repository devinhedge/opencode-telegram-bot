import { AsyncEntry } from "@napi-rs/keyring";
import type { SecretStore } from "./secret-store.js";

export const KEYCHAIN_SERVICE_NAME = "opencode-telegram-bot";
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
}
