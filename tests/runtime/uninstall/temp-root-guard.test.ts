import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertInsideTempRoot } from "./temp-root-guard.js";

describe("assertInsideTempRoot", () => {
  it("throws for the real home, its app data, the filesystem root, and the temp dir itself", () => {
    const realHome = os.userInfo().homedir;

    for (const target of [
      realHome,
      path.join(realHome, "Library", "Application Support", "opencode-telegram-bot"),
      path.join(realHome, ".config", "opencode-telegram-bot"),
      path.parse(process.cwd()).root,
      os.tmpdir(),
      path.join(os.tmpdir(), ".."),
    ]) {
      expect(() => assertInsideTempRoot(target), target).toThrow(/outside the temp root/);
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a temp path whose ancestor is a symlink out of the root",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-root-"));
      const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-elsewhere-"));
      const toElsewhere = path.join(root, "to-elsewhere");
      const toRealHome = path.join(root, "to-real-home");
      try {
        await fs.symlink(elsewhere, toElsewhere);
        // Only a link is created; nothing is ever written through it.
        await fs.symlink(os.userInfo().homedir, toRealHome);

        expect(() => assertInsideTempRoot(path.join(toElsewhere, "home", ".env"), root)).toThrow(
          /outside the temp root/,
        );
        expect(() => assertInsideTempRoot(path.join(toRealHome, "x"))).toThrow(
          /outside the temp root/,
        );
        expect(() => assertInsideTempRoot(path.join(root, "plain", ".env"), root)).not.toThrow();
      } finally {
        await fs.unlink(toRealHome).catch(() => undefined);
        await fs.unlink(toElsewhere).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(elsewhere, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when an ancestor is a dangling symlink, but accepts a dangling link itself",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-dangling-"));
      const dangling = path.join(root, "dangling");
      try {
        await fs.symlink(path.join(root, "missing-target"), dangling);

        expect(() => assertInsideTempRoot(path.join(dangling, "home", ".env"), root)).toThrow(
          /outside the temp root/,
        );
        // The link itself lives in root; removing it acts on the link, not its target.
        expect(() => assertInsideTempRoot(dangling, root)).not.toThrow();
      } finally {
        await fs.unlink(dangling).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts a path inside a temp directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-"));
    try {
      expect(() => assertInsideTempRoot(path.join(dir, ".env"))).not.toThrow();
      expect(() => assertInsideTempRoot(path.join(dir, "home"), dir)).not.toThrow();
      expect(() => assertInsideTempRoot(dir, dir)).toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
