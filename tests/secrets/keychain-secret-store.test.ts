import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetPassword, mockSetPassword, mockDeletePassword, mockEntryConstructed } = vi.hoisted(
  () => ({
    mockGetPassword: vi.fn(),
    mockSetPassword: vi.fn(),
    mockDeletePassword: vi.fn(),
    mockEntryConstructed: vi.fn(),
  }),
);

vi.mock("@napi-rs/keyring", () => {
  class AsyncEntry {
    constructor(service: string, account: string) {
      mockEntryConstructed(service, account);
    }
    getPassword = mockGetPassword;
    setPassword = mockSetPassword;
    deletePassword = mockDeletePassword;
  }
  return { AsyncEntry };
});

import { KeychainSecretStore } from "../../src/secrets/keychain-secret-store.js";
import { KEYCHAIN_SERVICE_NAME } from "../../src/secrets/keychain-service.js";

describe("KeychainSecretStore", () => {
  beforeEach(() => {
    mockGetPassword.mockReset();
    mockSetPassword.mockReset();
    mockDeletePassword.mockReset();
    mockEntryConstructed.mockReset();
  });

  it("has name keychain", () => {
    expect(new KeychainSecretStore().name).toBe("keychain");
  });

  it("getSecret returns value", async () => {
    mockGetPassword.mockResolvedValue("secret");
    const store = new KeychainSecretStore();
    expect(await store.getSecret("acct")).toBe("secret");
  });

  it("getSecret returns null when absent", async () => {
    mockGetPassword.mockResolvedValue(null);
    const store = new KeychainSecretStore();
    expect(await store.getSecret("acct")).toBeNull();
  });

  it("setSecret calls setPassword", async () => {
    mockSetPassword.mockResolvedValue(undefined);
    const store = new KeychainSecretStore();
    await store.setSecret("acct", "value");
    expect(mockSetPassword).toHaveBeenCalledWith("value");
  });

  it("deleteSecret calls deletePassword", async () => {
    mockDeletePassword.mockResolvedValue(true);
    const store = new KeychainSecretStore();
    await store.deleteSecret("acct");
    expect(mockDeletePassword).toHaveBeenCalled();
  });

  it("deleteSecret is no-op when throws", async () => {
    mockDeletePassword.mockRejectedValue(new Error("boom"));
    const store = new KeychainSecretStore();
    await expect(store.deleteSecret("acct")).resolves.toBeUndefined();
  });

  it("removeSecret returns removed when the credential was deleted", async () => {
    mockDeletePassword.mockResolvedValue(true);
    const store = new KeychainSecretStore();
    expect(await store.removeSecret("acct")).toBe("removed");
    expect(mockDeletePassword).toHaveBeenCalledTimes(1);
    expect(mockGetPassword).not.toHaveBeenCalled();
  });

  it("removeSecret targets the keychain service and the given account", async () => {
    mockDeletePassword.mockResolvedValue(true);
    const store = new KeychainSecretStore();
    await store.removeSecret("acct");
    expect(mockEntryConstructed).toHaveBeenCalledTimes(1);
    expect(mockEntryConstructed).toHaveBeenCalledWith(KEYCHAIN_SERVICE_NAME, "acct");
  });

  it("removeSecret returns absent when the library reports no credential", async () => {
    mockDeletePassword.mockResolvedValue(false);
    const store = new KeychainSecretStore();
    expect(await store.removeSecret("acct")).toBe("absent");
    expect(mockGetPassword).not.toHaveBeenCalled();
  });

  it("removeSecret returns failed when deletion rejects", async () => {
    mockDeletePassword.mockRejectedValue(new Error("store locked"));
    const store = new KeychainSecretStore();
    expect(await store.removeSecret("acct")).toBe("failed");
    expect(mockGetPassword).not.toHaveBeenCalled();
  });

  it("isAvailable false when keyring throws", async () => {
    mockGetPassword.mockRejectedValue(new Error("no keychain"));
    const store = new KeychainSecretStore();
    expect(await store.isAvailable()).toBe(false);
  });

  it("isAvailable true when keyring works", async () => {
    mockGetPassword.mockResolvedValue(null);
    const store = new KeychainSecretStore();
    expect(await store.isAvailable()).toBe(true);
  });
});
