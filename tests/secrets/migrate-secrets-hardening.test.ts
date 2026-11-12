import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSecretStore } from "../../src/secrets/fake-secret-store.js";
import { migrateSecretsIfNeeded } from "../../src/secrets/migrate-secrets.js";
import { simulateWindowsReadOnlyRenameFailure } from "../helpers/windows-rename-guard.js";

describe("migrateSecretsIfNeeded file hardening", () => {
  let dir: string;
  let envFilePath: string;
  const legacyContent = "TELEGRAM_BOT_TOKEN=bot_token_123\nOTHER_VAR=keep\n";

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "migrate-hardening-"));
    envFilePath = join(dir, ".env");
    await fs.writeFile(envFilePath, legacyContent, "utf8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "migrates a read-only .env, hardens it to 0600 and keeps a 0600 backup",
    async () => {
      // The real failure (rename over a read-only file) is only provable on Windows.
      await fs.chmod(envFilePath, 0o400);
      simulateWindowsReadOnlyRenameFailure();

      const result = await migrateSecretsIfNeeded(new FakeSecretStore(), envFilePath);

      expect(result.migrated).toBe(true);
      expect(await fs.readFile(envFilePath, "utf8")).toBe("OTHER_VAR=keep\n");
      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(`${envFilePath}.bak`, "utf8")).toBe(legacyContent);
      expect((await fs.stat(`${envFilePath}.bak`)).mode & 0o777).toBe(0o600);
      expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "writes the backup of the original secrets owner-only from creation",
    async () => {
      const writeFileSpy = vi.spyOn(fs, "writeFile");

      await migrateSecretsIfNeeded(new FakeSecretStore(), envFilePath);

      const bakWrites = writeFileSpy.mock.calls.filter(([target]) =>
        String(target).endsWith(".bak"),
      );
      expect(bakWrites).toHaveLength(1);
      expect(bakWrites[0]?.[2]).toMatchObject({ mode: 0o600 });
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves the read-only .env unchanged and removes the backup when the replace fails",
    async () => {
      await fs.chmod(envFilePath, 0o400);
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

      await expect(migrateSecretsIfNeeded(new FakeSecretStore(), envFilePath)).rejects.toThrow(
        "rename failed",
      );

      expect(await fs.readFile(envFilePath, "utf8")).toBe(legacyContent);
      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o400);
      expect((await fs.readdir(dir)).sort()).toEqual([".env"]);
    },
  );
});
