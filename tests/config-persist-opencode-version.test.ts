import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHome } from "./helpers/test-environment.js";
import { setRuntimeMode } from "../src/runtime/mode.js";
import { simulateWindowsReadOnlyRenameFailure } from "./helpers/windows-rename-guard.js";

// config.ts runs dotenv.config at import and loads the temp .env into the real process.env, which
// vi.unstubAllEnvs does not undo; these keys come from the .env files written by this suite.
const LEAKED_ENV_KEYS = ["A", "B", "OPENCODE_SERVER_VERSION"] as const;

describe("persistOpencodeVersion", () => {
  let tempHome: string;
  let envFilePath: string;
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(LEAKED_ENV_KEYS.map((key) => [key, process.env[key]]));
    tempHome = await createTestHome("opencode-telegram-persist-version-");
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", tempHome);
    setRuntimeMode("installed");
    envFilePath = path.join(tempHome, ".env");
    await mkdir(tempHome, { recursive: true });
    vi.resetModules();
    vi.doMock("../src/opencode/process.js", () => ({
      readLocalOpencodeVersion: vi.fn(async () => null),
      getOpencodeApiVersion: (v: string) => (parseInt(v, 10) >= 2 ? "v2" : "v1"),
    }));
    vi.doMock("../src/secrets/secret-store-factory.js", () => ({
      createSecretStore: vi.fn(),
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.OPENCODE_TELEGRAM_RUNTIME_MODE;
    for (const key of LEAKED_ENV_KEYS) {
      const previous = envSnapshot[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  async function persist(version: "v1" | "v2"): Promise<void> {
    const { persistOpencodeVersion } = await import("../src/config.js");
    await persistOpencodeVersion(version);
  }

  it.skipIf(process.platform === "win32")(
    "updates a read-only .env, keeps it read-only and preserves CRLF",
    async () => {
      // The real failure (rename over a read-only file) is only provable on Windows.
      await writeFile(envFilePath, "A=1\r\nOPENCODE_SERVER_VERSION=v1\r\nB=2\r\n", "utf-8");
      await chmod(envFilePath, 0o400);
      simulateWindowsReadOnlyRenameFailure();

      await persist("v2");

      expect(await readFile(envFilePath, "utf-8")).toBe(
        "A=1\r\nOPENCODE_SERVER_VERSION=v2\r\nB=2\r\n",
      );
      expect((await stat(envFilePath)).mode & 0o777).toBe(0o400);
      expect((await readdir(tempHome)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not widen the mode of a read-only .env",
    async () => {
      await writeFile(envFilePath, "A=1\n", "utf-8");
      await chmod(envFilePath, 0o400);

      await persist("v2");

      expect((await stat(envFilePath)).mode & 0o777).toBe(0o400);
    },
  );

  it("updates an export-prefixed assignment instead of duplicating it", async () => {
    await writeFile(envFilePath, "export OPENCODE_SERVER_VERSION=v1\nA=1\n", "utf-8");

    await persist("v2");

    const content = await readFile(envFilePath, "utf-8");
    expect(content.match(/OPENCODE_SERVER_VERSION/g)).toHaveLength(1);
    expect(content).toContain("OPENCODE_SERVER_VERSION=v2");
  });

  it("keeps the assignment next to its commented template entry", async () => {
    await writeFile(
      envFilePath,
      "# OPENCODE_SERVER_VERSION=v1\nOPENCODE_SERVER_VERSION=v1\nA=1\n",
      "utf-8",
    );

    await persist("v2");

    expect(await readFile(envFilePath, "utf-8")).toBe(
      "# OPENCODE_SERVER_VERSION=v1\nOPENCODE_SERVER_VERSION=v2\nA=1\n",
    );
  });

  it.skipIf(process.platform === "win32")(
    "does not rewrite or change the mode of a .env that already holds the version",
    async () => {
      await writeFile(envFilePath, "OPENCODE_SERVER_VERSION=v2\nA=1\n", "utf-8");
      await chmod(envFilePath, 0o400);
      const before = await stat(envFilePath);

      await persist("v2");

      const after = await stat(envFilePath);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o400);
      expect(await readFile(envFilePath, "utf-8")).toBe("OPENCODE_SERVER_VERSION=v2\nA=1\n");
    },
  );

  it.skipIf(process.platform === "win32")("creates a missing .env as 0600", async () => {
    await persist("v1");

    expect(await readFile(envFilePath, "utf-8")).toBe("OPENCODE_SERVER_VERSION=v1\n");
    expect((await stat(envFilePath)).mode & 0o777).toBe(0o600);
  });
});
