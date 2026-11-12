import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInstalledAppHome } from "../../../src/runtime/paths.js";
import {
  resolveUninstallHomes,
  validateOverrideHome,
} from "../../../src/runtime/uninstall/homes.js";

const isWindows = process.platform === "win32";
const isCaseInsensitivePlatform = process.platform === "darwin" || isWindows;

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
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", undefined);
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

    it("returns null when the override is the default home with a trailing separator", () => {
      const defaultHome = getInstalledAppHome();

      const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: defaultHome + path.sep });

      expect(homes.overrideHome).toBeNull();
    });

    it.skipIf(!isCaseInsensitivePlatform)(
      "returns null when the override differs from the default home only by case",
      () => {
        const defaultHome = getInstalledAppHome();

        const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: defaultHome.toUpperCase() });

        expect(homes.overrideHome).toBeNull();
      },
    );

    it.skipIf(isWindows)(
      "returns null when the override is a symlink to an existing default home",
      async () => {
        const defaultHome = getInstalledAppHome();
        await fs.mkdir(defaultHome, { recursive: true });
        const link = path.join(tempRoot, "link-to-default");
        await fs.symlink(defaultHome, link);

        const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: link });

        expect(homes.overrideHome).toBeNull();
      },
    );

    it("returns null for a blank or empty override", () => {
      expect(resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: "   " }).overrideHome).toBeNull();
      expect(resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: "" }).overrideHome).toBeNull();
    });

    it("returns the resolved override when it differs from the default home", () => {
      const override = path.join(tempRoot, "custom", "..", "custom-home");

      const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: override });

      expect(homes.overrideHome).toBe(path.resolve(override));
      expect(homes.defaultHome).toBe(getInstalledAppHome());
    });

    it("resolves a relative override against the current directory", async () => {
      const originalCwd = process.cwd();
      process.chdir(tempRoot);
      try {
        const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: "relative-home" });

        expect(homes.overrideHome).toBe(path.join(process.cwd(), "relative-home"));
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("resolves a whitespace-padded override untrimmed, like resolveAppHome", () => {
      const padded = path.join(tempRoot, "padded-home") + " ";

      const homes = resolveUninstallHomes({ OPENCODE_TELEGRAM_HOME: padded });

      expect(homes.overrideHome).toBe(path.resolve(padded));
      expect(homes.overrideHome?.endsWith(" ")).toBe(true);
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

    it("reports a path below a file as missing", async () => {
      const file = path.join(tempRoot, "file.txt");
      await fs.writeFile(file, "x");

      expect(await validateOverrideHome(path.join(file, "child"), fakeHome)).toEqual({
        ok: false,
        reason: "missing",
      });
    });

    it("reports a stat failure other than ENOENT and ENOTDIR as unreadable", async () => {
      const target = path.join(tempRoot, "locked");
      const error = Object.assign(new Error("denied"), { code: "EACCES" });
      vi.spyOn(fs, "stat").mockRejectedValueOnce(error);

      expect(await validateOverrideHome(target, fakeHome)).toEqual({
        ok: false,
        reason: "unreadable",
      });
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

    it("rejects the root and the home directory before any stat of the path", async () => {
      const statSpy = vi.spyOn(fs, "stat");
      const root = path.parse(tempRoot).root;

      await validateOverrideHome(root, fakeHome);
      await validateOverrideHome(fakeHome, fakeHome);

      expect(statSpy).not.toHaveBeenCalled();
    });

    it.skipIf(isWindows)("rejects a symlink that points at the user home directory", async () => {
      const link = path.join(tempRoot, "link-to-home");
      await fs.symlink(fakeHome, link);

      expect(await validateOverrideHome(link, fakeHome)).toEqual({
        ok: false,
        reason: "user-home",
      });
    });

    it.skipIf(isWindows)("rejects a symlink that points at the filesystem root", async () => {
      const link = path.join(tempRoot, "link-to-root");
      await fs.symlink(path.parse(tempRoot).root, link);

      expect(await validateOverrideHome(link, fakeHome)).toEqual({ ok: false, reason: "root" });
    });

    it.skipIf(!isCaseInsensitivePlatform)(
      "rejects the user home directory spelled in a different case",
      async () => {
        expect(await validateOverrideHome(fakeHome.toUpperCase(), fakeHome)).toEqual({
          ok: false,
          reason: "user-home",
        });
      },
    );

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

    it.skipIf(isWindows)(
      "accepts a symlinked override directory that holds a bot file",
      async () => {
        const dir = path.join(tempRoot, "real-bot-home");
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, ".env"), "x");
        const link = path.join(tempRoot, "link-to-bot-home");
        await fs.symlink(dir, link, "dir");

        expect(await validateOverrideHome(link, fakeHome)).toEqual({ ok: true });
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

    it.each([[".env"], ["settings.json"], [path.join("run", "bot-service.json")]])(
      "does not count a directory named %s as a bot file",
      async (marker) => {
        const dir = path.join(tempRoot, "dir-marker");
        await fs.mkdir(path.join(dir, marker), { recursive: true });

        expect(await validateOverrideHome(dir, fakeHome)).toEqual({
          ok: false,
          reason: "no-bot-files",
        });
      },
    );

    it.skipIf(isWindows)("does not count a dangling .env symlink as a bot file", async () => {
      const dir = path.join(tempRoot, "dangling");
      await fs.mkdir(dir);
      await fs.symlink(path.join(tempRoot, "nowhere"), path.join(dir, ".env"));

      expect(await validateOverrideHome(dir, fakeHome)).toEqual({
        ok: false,
        reason: "no-bot-files",
      });
    });
  });
});
