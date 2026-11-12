import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileSecretStore } from "../../src/secrets/encrypted-file-secret-store.js";

describe("EncryptedFileSecretStore", () => {
  let dir: string;
  let filePath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "efs-"));
    filePath = join(dir, "secrets.enc");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("has name encrypted-file", () => {
    expect(new EncryptedFileSecretStore(filePath).name).toBe("encrypted-file");
  });

  it("round-trips set/get", async () => {
    const store = new EncryptedFileSecretStore(filePath);
    await store.unlock("pw");
    await store.setSecret("acct", "value");
    const store2 = new EncryptedFileSecretStore(filePath);
    await store2.unlock("pw");
    expect(await store2.getSecret("acct")).toBe("value");
  });

  it("wrong password rejects", async () => {
    const store = new EncryptedFileSecretStore(filePath);
    await store.unlock("pw");
    await store.setSecret("acct", "value");
    const store2 = new EncryptedFileSecretStore(filePath);
    await expect(store2.unlock("wrong")).rejects.toThrow();
  });

  it("tampered ciphertext rejects", async () => {
    const store = new EncryptedFileSecretStore(filePath);
    await store.unlock("pw");
    await store.setSecret("acct", "value");
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = await readFile(filePath, "utf8");
    const payload = JSON.parse(raw);
    payload.ciphertext = payload.ciphertext.slice(0, -2) + "AA";
    await writeFile(filePath, JSON.stringify(payload), "utf8");
    const store2 = new EncryptedFileSecretStore(filePath);
    await expect(store2.unlock("pw")).rejects.toThrow();
  });

  it("tampered tag rejects", async () => {
    const store = new EncryptedFileSecretStore(filePath);
    await store.unlock("pw");
    await store.setSecret("acct", "value");
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = await readFile(filePath, "utf8");
    const payload = JSON.parse(raw);
    payload.tag = payload.tag.slice(0, -2) + "AA";
    await writeFile(filePath, JSON.stringify(payload), "utf8");
    const store2 = new EncryptedFileSecretStore(filePath);
    await expect(store2.unlock("pw")).rejects.toThrow();
  });

  it("file format shape", async () => {
    const store = new EncryptedFileSecretStore(filePath);
    await store.unlock("pw");
    await store.setSecret("acct", "value");
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath, "utf8");
    const payload = JSON.parse(raw);
    expect(payload).toHaveProperty("salt");
    expect(payload).toHaveProperty("iv");
    expect(payload).toHaveProperty("tag");
    expect(payload).toHaveProperty("ciphertext");
  });

  it("deleteSecret removes", async () => {
    const store = new EncryptedFileSecretStore(filePath);
    await store.unlock("pw");
    await store.setSecret("acct", "value");
    await store.deleteSecret("acct");
    const store2 = new EncryptedFileSecretStore(filePath);
    await store2.unlock("pw");
    expect(await store2.getSecret("acct")).toBeNull();
  });

  it("isAvailable true", async () => {
    expect(await new EncryptedFileSecretStore(filePath).isAvailable()).toBe(true);
  });
});

describe("EncryptedFileSecretStore file mode", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "efs-mode-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("creates secrets.enc as 0600", async () => {
    const filePath = join(dir, "secrets.enc");
    const store = new EncryptedFileSecretStore(filePath);
    await store.unlock("pw");
    await store.setSecret("acct", "value");

    const { stat } = await import("node:fs/promises");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("keeps working when secrets.enc already exists", async () => {
    const filePath = join(dir, "secrets.enc");
    const first = new EncryptedFileSecretStore(filePath);
    await first.unlock("pw");
    await first.setSecret("acct", "one");
    await first.setSecret("acct", "two");

    const second = new EncryptedFileSecretStore(filePath);
    await second.unlock("pw");
    expect(await second.getSecret("acct")).toBe("two");
  });
});
