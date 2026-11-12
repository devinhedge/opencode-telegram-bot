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
      const realEnvFilePath = await fs.realpath(envFilePath);
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
      const chmodSpy = vi.spyOn(fs, "chmod");

      await expect(migrateSecretsIfNeeded(new FakeSecretStore(), envFilePath)).rejects.toThrow(
        "rename failed",
      );

      // The file is opened for the update (0600) and put back to read-only (0400) afterwards.
      const envModes = chmodSpy.mock.calls
        .filter(([target]) => target === realEnvFilePath)
        .map(([, mode]) => mode);
      expect(envModes).toEqual([0o600, 0o400]);
      expect(await fs.readFile(envFilePath, "utf8")).toBe(legacyContent);
      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o400);
      expect((await fs.readdir(dir)).sort()).toEqual([".env"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces a pre-existing wider .bak with a 0600 backup of the original content",
    async () => {
      const bakFilePath = `${envFilePath}.bak`;
      await fs.writeFile(bakFilePath, "stale backup\n", "utf8");
      await fs.chmod(bakFilePath, 0o644);

      await migrateSecretsIfNeeded(new FakeSecretStore(), envFilePath);

      expect(await fs.readFile(bakFilePath, "utf8")).toBe(legacyContent);
      expect((await fs.stat(bakFilePath)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the cleaned .env and the backup when only restoring the mode fails",
    async () => {
      await fs.chmod(envFilePath, 0o400);
      const realChmod = fs.chmod.bind(fs);
      vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
        if (mode === 0o400) {
          throw new Error("chmod failed");
        }
        return realChmod(target, mode);
      });

      const result = await migrateSecretsIfNeeded(new FakeSecretStore(), envFilePath);

      expect(result.migrated).toBe(true);
      expect(await fs.readFile(envFilePath, "utf8")).toBe("OTHER_VAR=keep\n");
      expect(await fs.readFile(`${envFilePath}.bak`, "utf8")).toBe(legacyContent);
    },
  );
});
