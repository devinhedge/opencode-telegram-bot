import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSecretStore } from "../../src/secrets/fake-secret-store.js";
import { migrateSecretsIfNeeded } from "../../src/secrets/migrate-secrets.js";

describe("migrateSecretsIfNeeded", () => {
  let dir: string;
  let envFilePath: string;
  let store: FakeSecretStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "migrate-"));
    envFilePath = join(dir, ".env");
    store = new FakeSecretStore();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const SECRET_ENV_VARS = {
    TELEGRAM_BOT_TOKEN: "telegram_bot_token",
    TELEGRAM_PROXY_SECRET: "telegram_proxy_secret",
    OPENCODE_SERVER_PASSWORD: "opencode_server_password",
    STT_API_KEY: "stt_api_key",
    TTS_API_KEY: "tts_api_key",
    DOC_EXTRACTOR_API_KEY: "doc_extractor_api_key",
    TELEGRAM_ALLOWED_USER_ID: "allowed_user_id",
  } as const;

  function writeEnv(content: string): Promise<void> {
    return writeFile(envFilePath, content, "utf8");
  }

  function readEnv(): Promise<string> {
    return readFile(envFilePath, "utf8");
  }

  function readBak(): Promise<string> {
    return readFile(`${envFilePath}.bak`, "utf8");
  }

  it("migrates all secrets from .env to store and cleans .env", async () => {
    const envContent = `
TELEGRAM_BOT_TOKEN=bot_token_123
TELEGRAM_PROXY_SECRET=proxy_secret_456
OPENCODE_SERVER_PASSWORD=server_pass_789
STT_API_KEY=stt_key_abc
TTS_API_KEY=tts_key_def
DOC_EXTRACTOR_API_KEY=doc_key_ghi
TELEGRAM_ALLOWED_USER_ID=123456789
OTHER_VAR=should_remain
`;
    await writeEnv(envContent);

    const result = await migrateSecretsIfNeeded(store, envFilePath);

    expect(result.migrated).toBe(true);
    expect(result.secretsMigrated).toBe(7);

    // Verify all secrets were written to store
    for (const account of Object.values(SECRET_ENV_VARS)) {
      const value = await store.getSecret(account);
      expect(value).not.toBeNull();
      expect(value).toMatch(/^[a-zA-Z0-9_]+$/); // basic validation
    }

    // Verify .env no longer contains secrets
    const cleanedEnv = await readEnv();
    for (const envVar of Object.keys(SECRET_ENV_VARS)) {
      expect(cleanedEnv).not.toContain(envVar);
    }
    expect(cleanedEnv).toContain("OTHER_VAR=should_remain");

    // Verify .env.bak was created with original content
    const bakContent = await readBak();
    for (const envVar of Object.keys(SECRET_ENV_VARS)) {
      expect(bakContent).toContain(`${envVar}=`);
    }
    expect(bakContent).toContain("OTHER_VAR=should_remain");
  });

  it("creates .env.bak without secrets (only non-secret vars)", async () => {
    const envContent = `
TELEGRAM_BOT_TOKEN=bot_token_123
OTHER_VAR=should_remain
ANOTHER_VAR=also_remain
`;
    await writeEnv(envContent);

    await migrateSecretsIfNeeded(store, envFilePath);

    const bakContent = await readBak();
    expect(bakContent).toContain("TELEGRAM_BOT_TOKEN=bot_token_123");
    expect(bakContent).toContain("OTHER_VAR=should_remain");
    expect(bakContent).toContain("ANOTHER_VAR=also_remain");
  });

  it("partial failure leaves .env intact (no migration, no .env.bak)", async () => {
    // Create a store that fails on the third secret
    class FailingStore extends FakeSecretStore {
      private callCount = 0;
      override async setSecret(account: string, value: string): Promise<void> {
        this.callCount++;
        if (this.callCount === 3) {
          throw new Error("Simulated failure");
        }
        return super.setSecret(account, value);
      }
    }

    const failingStore = new FailingStore();
    const envContent = `
TELEGRAM_BOT_TOKEN=bot_token_123
TELEGRAM_PROXY_SECRET=proxy_secret_456
OPENCODE_SERVER_PASSWORD=server_pass_789
STT_API_KEY=stt_key_abc
`;
    await writeEnv(envContent);

    await expect(migrateSecretsIfNeeded(failingStore, envFilePath)).rejects.toThrow("Simulated failure");

    // .env should be unchanged
    const envAfter = await readEnv();
    expect(envAfter).toBe(envContent);

    // .env.bak should not exist
    try {
      await readBak();
      throw new Error(".env.bak should not exist");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  it("is idempotent - second run does nothing when already migrated", async () => {
    const envContent = `
TELEGRAM_BOT_TOKEN=bot_token_123
OTHER_VAR=should_remain
`;
    await writeEnv(envContent);

    // First run
    const result1 = await migrateSecretsIfNeeded(store, envFilePath);
    expect(result1.migrated).toBe(true);
    expect(result1.secretsMigrated).toBe(1);

    // Second run - should detect no secrets in .env and do nothing
    const result2 = await migrateSecretsIfNeeded(store, envFilePath);
    expect(result2.migrated).toBe(false);
    expect(result2.secretsMigrated).toBe(0);

    // .env should still only have non-secret vars
    const envAfter = await readEnv();
    expect(envAfter).toContain("OTHER_VAR=should_remain");
    expect(envAfter).not.toContain("TELEGRAM_BOT_TOKEN");

    // .env.bak should exist from first run
    const bakContent = await readBak();
    expect(bakContent).toContain("TELEGRAM_BOT_TOKEN=bot_token_123");
    expect(bakContent).toContain("OTHER_VAR=should_remain");
  });

  it("handles missing .env file gracefully (no migration needed)", async () => {
    // Don't create .env file
    const result = await migrateSecretsIfNeeded(store, envFilePath);
    expect(result.migrated).toBe(false);
    expect(result.secretsMigrated).toBe(0);
  });

  it("handles empty .env file gracefully", async () => {
    await writeEnv("");
    const result = await migrateSecretsIfNeeded(store, envFilePath);
    expect(result.migrated).toBe(false);
    expect(result.secretsMigrated).toBe(0);
  });

  it("handles .env with only non-secret variables", async () => {
    await writeEnv("OTHER_VAR=value\nANOTHER=value2\n");
    const result = await migrateSecretsIfNeeded(store, envFilePath);
    expect(result.migrated).toBe(false);
    expect(result.secretsMigrated).toBe(0);
    const envAfter = await readEnv();
    expect(envAfter).toContain("OTHER_VAR=value");
    expect(envAfter).toContain("ANOTHER=value2");
  });

  it("atomically rewrites .env using temporary file", async () => {
    const envContent = `
TELEGRAM_BOT_TOKEN=bot_token_123
OTHER_VAR=should_remain
`;
    await writeEnv(envContent);

    await migrateSecretsIfNeeded(store, envFilePath);

    // Check no temp files left behind
    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const tempFiles = files.filter((f) => f.startsWith(".env.") && f !== ".env" && f !== ".env.bak");
    expect(tempFiles).toHaveLength(0);
  });

  it("verifies reads after writing to store", async () => {
    const envContent = `
TELEGRAM_BOT_TOKEN=bot_token_123
TELEGRAM_PROXY_SECRET=proxy_secret_456
`;
    await writeEnv(envContent);

    // Create a store that fails on getSecret after successful setSecret
    class VerifyFailingStore extends FakeSecretStore {
      override async getSecret(account: string): Promise<string | null> {
        if (account === "telegram_proxy_secret") {
          return null; // Simulate verification failure
        }
        return super.getSecret(account);
      }
    }

    const verifyFailingStore = new VerifyFailingStore();
    await expect(migrateSecretsIfNeeded(verifyFailingStore, envFilePath)).rejects.toThrow(
      /verification failed/i
    );

    // .env should be unchanged
    const envAfter = await readEnv();
    expect(envAfter).toBe(envContent);
  });
});