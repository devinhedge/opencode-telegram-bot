import type { SecretStore } from "./secret-store.js";

/**
 * In-memory SecretStore used for tests and development. Not persistent.
 */
export class FakeSecretStore implements SecretStore {
  public readonly name: string;
  private readonly secrets = new Map<string, string>();

  constructor(name = "fake") {
    this.name = name;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getSecret(account: string): Promise<string | null> {
    return this.secrets.get(account) ?? null;
  }

  async setSecret(account: string, value: string): Promise<void> {
    this.secrets.set(account, value);
  }

  async deleteSecret(account: string): Promise<void> {
    this.secrets.delete(account);
  }

  async unlock(_password: string): Promise<void> {
    // no-op
  }
}
