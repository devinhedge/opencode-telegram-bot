/**
 * Pluggable interface for OS keychain / secret storage backends.
 *
 * Implementations must never log secret values. All methods are async.
 */
export interface SecretStore {
  /** Human-readable backend name. */
  readonly name: string;

  /** Whether this backend is usable in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Returns the secret value for the given account, or null if absent. */
  getSecret(account: string): Promise<string | null>;

  /** Stores (or overwrites) the secret value for the given account. */
  setSecret(account: string, value: string): Promise<void>;

  /** Removes the secret for the given account. No-op if absent. */
  deleteSecret(account: string): Promise<void>;

  /** Optional: unlock the backend with a password (no-op for most). */
  unlock?(password: string): Promise<void>;
}
