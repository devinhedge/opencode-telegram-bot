import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistEnvValue,
  replaceEnvFile,
  resolveSymlinkTarget,
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
      "# comment\nA=1\nLOG_LOCATION=app\n# LOG_LOCATION=commented\nB=2\n",
    );
  });

  it("preserves blank and comment lines in place", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "# header\n\nA=1\n\nLOG_LOCATION=bad\n# tail\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe(
      "# header\n\nA=1\n\nLOG_LOCATION=app\n# tail\n",
    );
  });

  it("keeps the position of the first assignment and drops later duplicates", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "LOG_LOCATION=a\nA=1\nLOG_LOCATION=b\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("LOG_LOCATION=app\nA=1\n");
  });

  it("keeps the assignment next to its commented template entry", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "# VERSION=v1\nVERSION=v1\n# NEXT=1\nB=2\n", "utf-8");

    await persistEnvValue(envFilePath, "VERSION", "v2");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe(
      "# VERSION=v1\nVERSION=v2\n# NEXT=1\nB=2\n",
    );
  });

  it("treats an export line as the active assignment and replaces it in place", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "export LOG_LOCATION=bad\nA=1\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("export LOG_LOCATION=app\nA=1\n");
  });

  it("keeps the indentation of the replaced assignment", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "  export LOG_LOCATION=bad\n\tB=2\n", "utf-8");

    await persistEnvValue(envFilePath, "LOG_LOCATION", "app");
    await persistEnvValue(envFilePath, "B", "3");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("  export LOG_LOCATION=app\n\tB=3\n");
  });

  it("performs no write when the value is unchanged", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\nLOG_LOCATION=app\n", "utf-8");
    await fs.chmod(envFilePath, 0o400);
    const before = await fs.stat(envFilePath);
    const renameSpy = vi.spyOn(fs, "rename");
    const chmodSpy = vi.spyOn(fs, "chmod");

    try {
      await persistEnvValue(envFilePath, "LOG_LOCATION", "app");

      expect(renameSpy).not.toHaveBeenCalled();
      expect(chmodSpy).not.toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
      chmodSpy.mockRestore();
    }

    const after = await fs.stat(envFilePath);
    expect(after.ino).toBe(before.ino);
    // Compare with the mode before the call: Windows reports 0o444 for a read-only file.
    expect(after.mode).toBe(before.mode);
    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nLOG_LOCATION=app\n");
  });

  it("appends an absent key with a trailing newline", async () => {
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, "A=1\nB=2", "utf-8");

    await persistEnvValue(envFilePath, "C", "3");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\nB=2\nC=3\n");
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

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\r\nLOG_LOCATION=app\r\nB=2\r\n");
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
    "is not influenced by a stale temp file of an earlier crash",
    async () => {
      await fs.mkdir(path.dirname(envFilePath), { recursive: true });
      const leftoverPath = `${envFilePath}.${process.pid}.tmp`;
      await fs.writeFile(leftoverPath, "stale\n", "utf-8");
      await fs.chmod(leftoverPath, 0o644);

      await persistEnvValue(envFilePath, "TELEGRAM_BOT_TOKEN", "secret");

      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(envFilePath, "utf-8")).toBe("TELEGRAM_BOT_TOKEN=secret\n");
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

  // The real Windows case: renaming over a read-only file fails there without the reopen step.
  // No rename guard here; this runs only on Windows CI or a manual Windows run.
  it.runIf(process.platform === "win32")("replaces a read-only file on Windows", async () => {
    await fs.writeFile(envFilePath, "old\n", "utf-8");
    await fs.chmod(envFilePath, 0o400);

    await replaceEnvFile(envFilePath, "A=1\n");

    expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\n");
    expect((await fs.stat(envFilePath)).mode & 0o200).toBe(0);
    expect(await tempSiblings()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "creates the target of a dangling symlink and keeps the link",
    async () => {
      const targetPath = path.join(tempDir, "real", "target.env");
      await fs.mkdir(path.dirname(targetPath));
      await fs.symlink(targetPath, envFilePath);

      await replaceEnvFile(envFilePath, "A=1\n");

      expect((await fs.lstat(envFilePath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(targetPath, "utf-8")).toBe("A=1\n");
      expect(await modeOf(targetPath)).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows a relative chain of links ending in a missing target",
    async () => {
      await fs.mkdir(path.join(tempDir, "sub"));
      await fs.symlink("sub/second", envFilePath);
      await fs.symlink("final.env", path.join(tempDir, "sub", "second"));

      await replaceEnvFile(envFilePath, "A=1\n");

      expect((await fs.lstat(envFilePath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(tempDir, "sub", "final.env"), "utf-8")).toBe("A=1\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "updates the target of a symlinked file in place and keeps the link and the target mode",
    async () => {
      const targetDir = path.join(tempDir, "real");
      const targetPath = path.join(targetDir, "target.env");
      await fs.mkdir(targetDir);
      await fs.writeFile(targetPath, "old\n", "utf-8");
      await fs.chmod(targetPath, 0o640);
      await fs.symlink(targetPath, envFilePath);

      await replaceEnvFile(envFilePath, "A=1\n");

      expect((await fs.lstat(envFilePath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(targetPath, "utf-8")).toBe("A=1\n");
      expect(await modeOf(targetPath)).toBe(0o640);
      expect((await fs.readdir(targetDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a read-only symlink target read-only",
    async () => {
      const targetPath = path.join(tempDir, "target.env");
      await fs.writeFile(targetPath, "old\n", "utf-8");
      await fs.chmod(targetPath, 0o400);
      await fs.symlink(targetPath, envFilePath);

      await replaceEnvFile(envFilePath, "A=1\n");

      expect((await fs.lstat(envFilePath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(targetPath, "utf-8")).toBe("A=1\n");
      expect(await modeOf(targetPath)).toBe(0o400);
    },
  );

  it("lets two concurrent replacements of the same path both succeed", async () => {
    await Promise.all([
      replaceEnvFile(envFilePath, "FIRST=1\n"),
      replaceEnvFile(envFilePath, "SECOND=2\n"),
    ]);

    expect(["FIRST=1\n", "SECOND=2\n"]).toContain(await fs.readFile(envFilePath, "utf-8"));
    expect(await tempSiblings()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "does not fail after a successful replace when restoring the mode fails",
    async () => {
      await fs.writeFile(envFilePath, "old\n", "utf-8");
      await fs.chmod(envFilePath, 0o400);
      const realChmod = fs.chmod.bind(fs);
      vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
        if (mode === 0o400) {
          throw new Error("chmod failed");
        }
        return realChmod(target, mode);
      });

      await expect(replaceEnvFile(envFilePath, "A=1\n")).resolves.toBeUndefined();

      expect(await fs.readFile(envFilePath, "utf-8")).toBe("A=1\n");
      expect(await modeOf(envFilePath)).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rethrows the original error when both the write and the mode restore fail",
    async () => {
      await fs.writeFile(envFilePath, "old\n", "utf-8");
      await fs.chmod(envFilePath, 0o400);
      const realChmod = fs.chmod.bind(fs);
      vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
        if (mode === 0o400) {
          throw new Error("chmod failed");
        }
        return realChmod(target, mode);
      });
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

      await expect(replaceEnvFile(envFilePath, "A=1\n")).rejects.toThrow("rename failed");
    },
  );
});

describe("runtime/env-file resolveSymlinkTarget", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "env-file-resolve-")));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns a missing path unchanged", async () => {
    const missing = path.join(tempDir, "missing");

    expect(await resolveSymlinkTarget(missing)).toBe(missing);
  });

  it("returns an existing regular file", async () => {
    const file = path.join(tempDir, "file");
    await fs.writeFile(file, "x", "utf-8");

    expect(await resolveSymlinkTarget(file)).toBe(file);
  });

  it.skipIf(process.platform === "win32")("resolves a link to an existing file", async () => {
    const file = path.join(tempDir, "file");
    const link = path.join(tempDir, "link");
    await fs.writeFile(file, "x", "utf-8");
    await fs.symlink(file, link);

    expect(await resolveSymlinkTarget(link)).toBe(file);
  });

  it.skipIf(process.platform === "win32")("resolves a dangling link to its target", async () => {
    const link = path.join(tempDir, "link");
    await fs.symlink("gone", link);

    expect(await resolveSymlinkTarget(link)).toBe(path.join(tempDir, "gone"));
  });

  it.skipIf(process.platform === "win32")(
    "resolves a relative target against the physical directory of a symlinked parent",
    async () => {
      const physicalDir = path.join(tempDir, "real", "a");
      await fs.mkdir(physicalDir, { recursive: true });
      await fs.symlink(physicalDir, path.join(tempDir, "linkdir"));
      await fs.symlink("../target.env", path.join(physicalDir, "env"));

      // Physically real/a/../target.env; a lexical resolution would give <tempDir>/target.env.
      expect(await resolveSymlinkTarget(path.join(tempDir, "linkdir", "env"))).toBe(
        path.join(tempDir, "real", "target.env"),
      );
    },
  );

  it.skipIf(process.platform === "win32")("rejects a link loop", async () => {
    const first = path.join(tempDir, "first");
    const second = path.join(tempDir, "second");
    await fs.symlink(second, first);
    await fs.symlink(first, second);

    await expect(resolveSymlinkTarget(first)).rejects.toThrow();
  });
});
