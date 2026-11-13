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
