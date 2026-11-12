import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistEnvValue,
  replaceEnvFile,
  writeFileAtomically,
} from "../../src/runtime/env-file.js";
import { simulateWindowsReadOnlyRenameFailure } from "../helpers/windows-rename-guard.js";

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

  it("preserves blank and comment lines in place", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "# header\n\nA=1\n\nLOG_LOCATION=bad\n# tail\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe(
      "# header\n\nA=1\n\n# tail\nLOG_LOCATION=app\n",
    );
  });

  it("removes every duplicate active assignment and appends one", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "LOG_LOCATION=a\nA=1\nLOG_LOCATION=b\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\n");
  });

  it("treats an export line as the active assignment", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "export LOG_LOCATION=bad\nA=1\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\n");
  });

  it("matches the key literally, not as a pattern", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "AXB=1\nA.B=2\n", "utf-8");

    await persistEnvValue(envFilePath, "A.B", "x");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("AXB=1\nA.B=x\n");
  });

  it("preserves CRLF line endings", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\r\nLOG_LOCATION=bad\r\nB=2\r\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\r\nB=2\r\nLOG_LOCATION=app\r\n");
  });

  it("handles a file without a trailing newline", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\nB=2", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nB=2\nLOG_LOCATION=app\n");
  });

  it("removes the temp file and rethrows when the write fails", async () => {
    const targetPath = path.join(tempDir, "target");
    await fs.mkdir(targetPath);

    await expect(writeFileAtomically(targetPath, "A=1\n")).rejects.toThrow();

    const entries = await fs.readdir(tempDir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not leave a blank line before the appended key", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\n\n\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\n");
  });

  it("strips trailing blank lines using the file's CRLF style", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\r\n\r\n\r\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\r\nLOG_LOCATION=app\r\n");
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

  it.skipIf(process.platform === "win32")("creates a new file as owner read/write", async () => {
    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    const stats = await fs.stat(envFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")(
    "writes the temp file owner-only so the content is never group or other readable",
    async () => {
      const writeFileSpy = vi.spyOn(fs, "writeFile");

      try {
        await persistEnvValue(envFilePath, "TELEGRAM_BOT_TOKEN", "secret");

        const tempWrites = writeFileSpy.mock.calls.filter(([target]) =>
          String(target).endsWith(".tmp"),
        );
        expect(tempWrites).toHaveLength(1);
        expect(tempWrites[0]?.[2]).toMatchObject({ mode: 0o600 });
      } finally {
        writeFileSpy.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not reuse the mode of a leftover temp file",
    async () => {
      await fs.mkdir(path.dirname(envFilePath), { recursive: true });
      const leftoverPath = `${envFilePath}.${process.pid}.tmp`;
      await fs.writeFile(leftoverPath, "stale\n", "utf-8");
      await fs.chmod(leftoverPath, 0o644);

      await persistEnvValue(envFilePath, "TELEGRAM_BOT_TOKEN", "secret");

      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("TELEGRAM_BOT_TOKEN=secret\n");
      const entries = await fs.readdir(path.dirname(envFilePath));
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("keeps the mode of an existing file", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\n", "utf-8");
    await fs.chmod(envFilePath, 0o644);

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o644);
    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\n");
  });

  it.skipIf(process.platform === "win32")(
    "updates a read-only file and leaves it read-only",
    async () => {
      await fs.mkdir(path.dirname(envFilePath), { recursive: true });
      await fs.writeFile(envFilePath, "A=1\n", "utf-8");
      await fs.chmod(envFilePath, 0o400);

      await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o400);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "restores the mode of an existing file when the write fails",
    async () => {
      await fs.mkdir(path.dirname(envFilePath), { recursive: true });
      await fs.writeFile(envFilePath, "A=1\n", "utf-8");
      await fs.chmod(envFilePath, 0o400);
      const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

      try {
        await expect(persistEnvValue(envFilePath, "LOG_LOCATION", "app")).rejects.toThrow(
          "rename failed",
        );
      } finally {
        renameSpy.mockRestore();
      }

      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o400);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\n");
    },
  );
});

describe("runtime/env-file replaceEnvFile", () => {
  let tempDir: string;
  let envFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "env-file-replace-"));
    envFilePath = path.join(tempDir, ".env");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function modeOf(filePath: string): Promise<number> {
    return (await fs.stat(filePath)).mode & 0o777;
  }

  async function tempSiblings(): Promise<string[]> {
    return (await fs.readdir(tempDir)).filter((name) => name.endsWith(".tmp"));
  }

  it.skipIf(process.platform === "win32")("creates a new file as 0600", async () => {
    await replaceEnvFile(envFilePath, "A=1\n");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\n");
    expect(await modeOf(envFilePath)).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("keeps an existing 0644 mode", async () => {
    await fs.writeFile(envFilePath, "old\n", "utf-8");
    await fs.chmod(envFilePath, 0o644);

    await replaceEnvFile(envFilePath, "A=1\n");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\n");
    expect(await modeOf(envFilePath)).toBe(0o644);
  });

  it.skipIf(process.platform === "win32")(
    "replaces a read-only file when the destination must be writable to rename",
    async () => {
      await fs.writeFile(envFilePath, "old\n", "utf-8");
      await fs.chmod(envFilePath, 0o400);
      simulateWindowsReadOnlyRenameFailure();

      await replaceEnvFile(envFilePath, "A=1\n");

      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\n");
      expect(await modeOf(envFilePath)).toBe(0o400);
      expect(await tempSiblings()).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "restores the previous mode, removes the temp file and rethrows when the write fails",
    async () => {
      await fs.writeFile(envFilePath, "old\n", "utf-8");
      await fs.chmod(envFilePath, 0o400);
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

      await expect(replaceEnvFile(envFilePath, "A=1\n")).rejects.toThrow("rename failed");

      expect(await modeOf(envFilePath)).toBe(0o400);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("old\n");
      expect(await tempSiblings()).toEqual([]);
    },
  );
});
