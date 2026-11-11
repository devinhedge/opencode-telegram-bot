import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistEnvValue } from "../../src/runtime/env-file.js";

describe("runtime/env-file", () => {
  let tempDir: string;
  let envFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "env-file-test-"));
    envFilePath = path.join(tempDir, "nested", ".env");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates the file when missing", async () => {
    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("LOG_LOCATION=app\n");
  });

  it("replaces an active assignment and keeps every other line", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(
      envFilePath,
      "# comment\nA=1\nLOG_LOCATION=bad\n# LOG_LOCATION=commented\nB=2\n",
      "utf-8",
    );

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe(
      "# comment\nA=1\n# LOG_LOCATION=commented\nB=2\nLOG_LOCATION=app\n",
    );
  });

  it("appends when the key is absent", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "os");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=os\n");
  });

  it("leaves no temp sibling", async () => {
    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    const entries = await fs.readdir(path.dirname(envFilePath));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("restricts the file to the owner", async () => {
    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    const stats = await fs.stat(envFilePath);
    expect(stats.mode & 0o077).toBe(0);
  });
});
