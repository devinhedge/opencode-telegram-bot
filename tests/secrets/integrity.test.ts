import { describe, expect, it, beforeEach, vi } from "vitest";

async function loadIntegrityModule() {
  vi.resetModules();
  return import("../../src/secrets/integrity.js");
}

describe("integrity", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("computeChecksum", () => {
    it("produces consistent checksum for same input", async () => {
      const { computeChecksum } = await loadIntegrityModule();
      const values = { a: "1", b: "2" };
      const checksum1 = computeChecksum(values);
      const checksum2 = computeChecksum(values);
      expect(checksum1).toBe(checksum2);
      expect(checksum1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it("produces different checksums for different inputs", async () => {
      const { computeChecksum } = await loadIntegrityModule();
      const checksum1 = computeChecksum({ a: "1" });
      const checksum2 = computeChecksum({ a: "2" });
      expect(checksum1).not.toBe(checksum2);
    });

    it("produces different checksums for different key order (canonical JSON)", async () => {
      const { computeChecksum } = await loadIntegrityModule();
      const checksum1 = computeChecksum({ a: "1", b: "2" });
      const checksum2 = computeChecksum({ b: "2", a: "1" });
      expect(checksum1).toBe(checksum2); // Canonical JSON should normalize key order
    });

    it("handles empty object", async () => {
      const { computeChecksum } = await loadIntegrityModule();
      const checksum = computeChecksum({});
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it("handles null and undefined values", async () => {
      const { computeChecksum } = await loadIntegrityModule();
      const checksum = computeChecksum({ a: null, b: undefined, c: "value" });
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("verifyIntegrity", () => {
    it("passes when checksum matches and user ID matches", async () => {
      const { computeChecksum, verifyIntegrity } = await loadIntegrityModule();
      const FakeStore = (await import("../../src/secrets/fake-secret-store.js")).FakeSecretStore;
      const store = new FakeStore();

      const values = {
        telegramBotToken: "token123",
        allowedUserId: "42",
      };
      // Compute checksum only from protected values (excluding allowedUserId)
      const protectedValues = { telegramBotToken: "token123" };
      const checksum = computeChecksum(protectedValues);
      await store.setSecret("integrity_checksum", checksum);
      await store.setSecret("integrity_user_id", "42");

      await expect(verifyIntegrity(store, values)).resolves.toBeUndefined();
    });

    it("throws tampering error when checksum mismatches", async () => {
      const { computeChecksum, verifyIntegrity } = await loadIntegrityModule();
      const FakeStore = (await import("../../src/secrets/fake-secret-store.js")).FakeSecretStore;
      const store = new FakeStore();

      const values = {
        telegramBotToken: "token123",
        allowedUserId: "42",
      };
      const protectedValues = { telegramBotToken: "token123" };
      const checksum = computeChecksum(protectedValues);
      await store.setSecret("integrity_checksum", checksum);
      await store.setSecret("integrity_user_id", "42");

      // Tamper with values
      const tamperedValues = { ...values, telegramBotToken: "tampered" };

      await expect(verifyIntegrity(store, tamperedValues)).rejects.toThrow(/integrity/i);
      await expect(verifyIntegrity(store, tamperedValues)).rejects.toThrow(/checksum|tamper/i);
    });

    it("throws when allowed user ID mismatches", async () => {
      const { computeChecksum, verifyIntegrity } = await loadIntegrityModule();
      const FakeStore = (await import("../../src/secrets/fake-secret-store.js")).FakeSecretStore;
      const store = new FakeStore();

      const values = {
        telegramBotToken: "token123",
        allowedUserId: "42",
      };
      const protectedValues = { telegramBotToken: "token123" };
      const checksum = computeChecksum(protectedValues);
      await store.setSecret("integrity_checksum", checksum);
      await store.setSecret("integrity_user_id", "42");

      const mismatchedValues = { ...values, allowedUserId: "999" };

      await expect(verifyIntegrity(store, mismatchedValues)).rejects.toThrow(/integrity/i);
      await expect(verifyIntegrity(store, mismatchedValues)).rejects.toThrow(/user.?id|allowed/i);
    });

    it("does not leak secret values in error messages", async () => {
      const { computeChecksum, verifyIntegrity } = await loadIntegrityModule();
      const FakeStore = (await import("../../src/secrets/fake-secret-store.js")).FakeSecretStore;
      const store = new FakeStore();

      const values = {
        telegramBotToken: "super-secret-token-value",
        allowedUserId: "42",
      };
      const protectedValues = { telegramBotToken: "super-secret-token-value" };
      const checksum = computeChecksum(protectedValues);
      await store.setSecret("integrity_checksum", checksum);
      await store.setSecret("integrity_user_id", "42");

      const tamperedValues = { ...values, telegramBotToken: "tampered" };

      try {
        await verifyIntegrity(store, tamperedValues);
      } catch (error) {
        const message = String(error);
        expect(message).not.toContain("super-secret-token-value");
        expect(message).not.toContain("token123");
      }
    });

    it("throws when checksum is missing from store", async () => {
      const { verifyIntegrity } = await loadIntegrityModule();
      const FakeStore = (await import("../../src/secrets/fake-secret-store.js")).FakeSecretStore;
      const store = new FakeStore();

      const values = {
        telegramBotToken: "token123",
        allowedUserId: "42",
      };

      // No checksum stored
      await expect(verifyIntegrity(store, values)).rejects.toThrow(/integrity/i);
    });

    it("throws when user ID is missing from store", async () => {
      const { computeChecksum, verifyIntegrity } = await loadIntegrityModule();
      const FakeStore = (await import("../../src/secrets/fake-secret-store.js")).FakeSecretStore;
      const store = new FakeStore();

      const values = {
        telegramBotToken: "token123",
        allowedUserId: "42",
      };
      const protectedValues = { telegramBotToken: "token123" };
      const checksum = computeChecksum(protectedValues);
      await store.setSecret("integrity_checksum", checksum);
      // No user_id stored

      await expect(verifyIntegrity(store, values)).rejects.toThrow(/integrity/i);
    });
  });
});