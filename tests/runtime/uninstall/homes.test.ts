import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInstalledAppHome } from "../../../src/runtime/paths.js";
import {
  resolveUninstallHomes,
  validateOverrideHome,
} from "../../../src/runtime/uninstall/homes.js";

describe("runtime/uninstall/homes", () => {
  let tempRoot: string;
  let fakeHome: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-homes-"));
    fakeHome = path.join(tempRoot, "home");
    await fs.mkdir(fakeHome, { recursive: true });
    vi.stubEnv("HOME", fakeHome);
    vi.stubEnv("USERPROFILE", fakeHome);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(fakeHome, ".config"));
    vi.stubEnv("APPDATA", path.join(fakeHome, "AppData", "Roaming"));
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", "");
    delete process.env.OPENCODE_TELEGRAM_HOME;
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  describe("resolveUninstallHomes", () => {
    it("uses the installed app home as the default home and has no override", () => {
      const homes = resolveUninstallHomes({});

      expect(homes.defaultHome).toBe(getInstalledAppHome());
      expect(path.isAbsolute(homes.defaultHome)).toBe(true);
      expect(homes.overrideHome).toBeNull();
    });

    it("returns null when the override equals the default home", () => {
      const defaultHome = getInstalledAppHome();

      const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: defaultHome });

      expect(homes.overrideHome).toBeNull();
    });

    it("returns null for a blank override", () => {
      const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: "   " });

      expect(homes.overrideHome).toBeNull();
    });

    it("returns the resolved override when it differs from the default home", () => {
      const override = path.join(tempRoot, "custom", "..", "custom-home");

      const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: override });

      expect(homes.overrideHome).toBe(path.resolve(override));
      expect(homes.defaultHome).toBe(getInstalledAppHome());
    });

    it("reads process.env when no environment is passed", () => {
      const override = path.join(tempRoot, "from-process-env");
      vi.stubEnv("OPENCODE_TELEGRAM_HOME", override);

      expect(resolveUninstallHomes().overrideHome).toBe(path.resolve(override));
    });
  });

  describe("validateOverrideHome", () => {
    it("reports a missing path and never creates it", async () => {
      const missing = path.join(tempRoot, "does-not-exist");

      const result = await validateOverrideHome(missing, fakeHome);

      expect(result).toEqual({ ok: false, reason: "missing" });
      await expect(fs.access(missing)).rejects.toThrow();
    });

    it("rejects a file", async () => {
      const file = path.join(tempRoot, "file.txt");
      await fs.writeFile(file, "x");

      expect(await validateOverrideHome(file, fakeHome)).toEqual({
        ok: false,
        reason: "not-a-directory",
      });
    });

    it("rejects the filesystem root", async () => {
      const root = path.parse(tempRoot).root;

      expect(await validateOverrideHome(root, fakeHome)).toEqual({ ok: false, reason: "root" });
    });

    it("rejects the user home directory, also through a non-normalized spelling", async () => {
      expect(await validateOverrideHome(fakeHome, fakeHome)).toEqual({
        ok: false,
        reason: "user-home",
      });
      expect(await validateOverrideHome(path.join(fakeHome, "x", ".."), fakeHome)).toEqual({
        ok: false,
        reason: "user-home",
      });
    });

    it("uses os.homedir() when no home directory is passed", async () => {
      expect(await validateOverrideHome(fakeHome)).toEqual({ ok: false, reason: "user-home" });
    });

    it("rejects an empty directory", async () => {
      const dir = path.join(tempRoot, "empty");
      await fs.mkdir(dir);

      expect(await validateOverrideHome(dir, fakeHome)).toEqual({
        ok: false,
        reason: "no-bot-files",
      });
    });

    it.each([[".env"], ["settings.json"], [path.join("run", "bot-service.json")]])(
      "accepts a directory containing %s",
      async (marker) => {
        const dir = path.join(tempRoot, "bot-home");
        await fs.mkdir(path.dirname(path.join(dir, marker)), { recursive: true });
        await fs.writeFile(path.join(dir, marker), "x");

        expect(await validateOverrideHome(dir, fakeHome)).toEqual({ ok: true });
      },
    );

    it("rejects a run directory without bot-service.json", async () => {
      const dir = path.join(tempRoot, "run-only");
      await fs.mkdir(path.join(dir, "run"), { recursive: true });

      expect(await validateOverrideHome(dir, fakeHome)).toEqual({
        ok: false,
        reason: "no-bot-files",
      });
    });
  });
});
