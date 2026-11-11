import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../../src/secrets/fake-secret-store.js";

describe("SecretStore contract (FakeSecretStore)", () => {
  it("isAvailable returns true", async () => {
    const store = new FakeSecretStore();
    expect(await store.isAvailable()).toBe(true);
  });

  it("set/get round-trip", async () => {
    const store = new FakeSecretStore();
    await store.setSecret("acct", "value");
    expect(await store.getSecret("acct")).toBe("value");
  });

  it("getSecret returns null for missing account", async () => {
    const store = new FakeSecretStore();
    expect(await store.getSecret("missing")).toBeNull();
  });

  it("deleteSecret removes value", async () => {
    const store = new FakeSecretStore();
    await store.setSecret("acct", "value");
    await store.deleteSecret("acct");
    expect(await store.getSecret("acct")).toBeNull();
  });

  it("unlock is a no-op", async () => {
    const store = new FakeSecretStore();
    await expect(store.unlock?.("pw")).resolves.toBeUndefined();
  });

  it("has a name", () => {
    const store = new FakeSecretStore();
    expect(typeof store.name).toBe("string");
    expect(store.name.length).toBeGreaterThan(0);
  });
});
