import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertInsideTempRoot, isUnder } from "./temp-root-guard.js";

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

  it("accepts a child whose name merely starts with two dots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-dots-"));
    try {
      expect(isUnder(path.join(root, "..x"), root)).toBe(true);
      expect(isUnder(path.join(root, ".."), root)).toBe(false);
      expect(() => assertInsideTempRoot(path.join(root, "..x"), root)).not.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
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
        // Unlinking the entry itself acts on the link, which lives in root.
        expect(() => assertInsideTempRoot(dangling, root, { followTarget: false })).not.toThrow();
        // Used as a directory, the dangling target cannot be resolved: fail closed.
        expect(() => assertInsideTempRoot(dangling, root)).toThrow(/outside the temp root/);
      } finally {
        await fs.unlink(dangling).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows a directory target but not an entry that is only unlinked",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-follow-"));
      const toRealHome = path.join(root, "home-link");
      const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-guard-outside-"));
      const toElsewhere = path.join(root, "secrets.enc");
      try {
        // Only links are created; nothing is ever written through them.
        await fs.symlink(os.userInfo().homedir, toRealHome);
        await fs.symlink(path.join(elsewhere, "secrets.enc"), toElsewhere);

        // A link to the real home used as a home is refused.
        expect(() => assertInsideTempRoot(toRealHome)).toThrow(/outside the temp root/);
        expect(() => assertInsideTempRoot(toRealHome, root)).toThrow(/outside the temp root/);
        // Unlinking a link whose target is outside is allowed: only the link goes.
        expect(() =>
          assertInsideTempRoot(toElsewhere, root, { followTarget: false }),
        ).not.toThrow();
        // But an entry whose parent resolves outside is refused even without following it.
        expect(() =>
          assertInsideTempRoot(path.join(toRealHome, ".env"), root, { followTarget: false }),
        ).toThrow(/outside the temp root/);
      } finally {
        await fs.unlink(toRealHome).catch(() => undefined);
        await fs.unlink(toElsewhere).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(elsewhere, { recursive: true, force: true });
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
