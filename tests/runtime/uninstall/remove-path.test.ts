import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAppHomeData, removePath } from "../../../src/runtime/uninstall/remove-path.js";

const isWindows = process.platform === "win32";

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("runtime/uninstall/remove-path", () => {
  let tempRoot: string;
  let appHome: string;
  let outside: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-remove-"));
    appHome = path.join(tempRoot, "home");
    outside = path.join(tempRoot, "outside");
    await fs.mkdir(appHome, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  describe("removePath", () => {
    it.skipIf(isWindows)("removes a read-only file", async () => {
      const file = path.join(appHome, "secrets.enc");
      await fs.writeFile(file, "x", { mode: 0o400 });

      const result = await removePath(file);

      expect(result).toEqual({ path: file, status: "removed" });
      expect(await exists(file)).toBe(false);
    });

    it("removes a directory tree", async () => {
      const dir = path.join(appHome, "run");
      await fs.mkdir(path.join(dir, "nested"), { recursive: true });
      await fs.writeFile(path.join(dir, "nested", "a.json"), "{}");

      const result = await removePath(dir);

      expect(result.status).toBe("removed");
      expect(await exists(dir)).toBe(false);
    });

    it("reports absent for a missing path", async () => {
      const missing = path.join(appHome, "missing");

      const result = await removePath(missing);

      expect(result).toEqual({ path: missing, status: "absent" });
    });

    it.skipIf(isWindows)("removes a dangling symlink and reports the missing target", async () => {
      const missingTarget = path.join(outside, "gone.env");
      const link = path.join(appHome, ".env");
      await fs.symlink(missingTarget, link);

      const result = await removePath(link);

      expect(result.status).toBe("removed");
      expect(result.linkTarget).toBe(missingTarget);
      expect(await exists(link)).toBe(false);
    });

    it.skipIf(isWindows)("removes only the link of a symlink to an outside file", async () => {
      const targetFile = path.join(outside, "real.env");
      await fs.writeFile(targetFile, "TOKEN=x");
      const link = path.join(appHome, ".env");
      await fs.symlink(targetFile, link);

      const result = await removePath(link);

      expect(result.status).toBe("removed");
      expect(result.linkTarget).toBe(await fs.realpath(targetFile));
      expect(await exists(link)).toBe(false);
      expect(await fs.readFile(targetFile, "utf-8")).toBe("TOKEN=x");
    });

    it.skipIf(isWindows)("never follows a symlink to an outside directory", async () => {
      const outsideDir = path.join(outside, "dir");
      await fs.mkdir(outsideDir);
      await fs.writeFile(path.join(outsideDir, "keep.txt"), "keep");
      const link = path.join(appHome, "run");
      await fs.symlink(outsideDir, link);

      const result = await removePath(link);

      expect(result.status).toBe("removed");
      expect(await exists(link)).toBe(false);
      expect(await fs.readFile(path.join(outsideDir, "keep.txt"), "utf-8")).toBe("keep");
    });

    it.skipIf(isWindows)("does not follow a symlink inside a removed directory", async () => {
      const targetFile = path.join(outside, "inner.txt");
      await fs.writeFile(targetFile, "keep");
      const dir = path.join(appHome, "local-commands");
      await fs.mkdir(dir);
      await fs.symlink(targetFile, path.join(dir, "link"));

      const result = await removePath(dir);

      expect(result.status).toBe("removed");
      expect(await fs.readFile(targetFile, "utf-8")).toBe("keep");
    });

    it("retries after chmod when the removal fails once with EPERM", async () => {
      const file = path.join(appHome, ".env");
      await fs.writeFile(file, "x");
      const realRm = fs.rm.bind(fs);
      const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(errnoError("EPERM"));
      rmSpy.mockImplementation(realRm);
      const chmodSpy = vi.spyOn(fs, "chmod");

      const result = await removePath(file);

      expect(result.status).toBe("removed");
      expect(rmSpy).toHaveBeenCalledTimes(2);
      expect(chmodSpy).toHaveBeenCalledTimes(1);
      expect(chmodSpy).toHaveBeenCalledWith(file, 0o600);
      expect(await exists(file)).toBe(false);
    });

    it("makes a directory owner-writable with 0700 before the retry", async () => {
      const dir = path.join(appHome, "run");
      await fs.mkdir(dir);
      const realRm = fs.rm.bind(fs);
      const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(errnoError("EPERM"));
      rmSpy.mockImplementation(realRm);
      const chmodSpy = vi.spyOn(fs, "chmod");

      const result = await removePath(dir);

      expect(result.status).toBe("removed");
      expect(chmodSpy).toHaveBeenCalledWith(dir, 0o700);
    });

    it("retries once on EACCES as well", async () => {
      const file = path.join(appHome, ".env");
      await fs.writeFile(file, "x");
      const realRm = fs.rm.bind(fs);
      const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(errnoError("EACCES"));
      rmSpy.mockImplementation(realRm);
      const chmodSpy = vi.spyOn(fs, "chmod");

      const result = await removePath(file);

      expect(result.status).toBe("removed");
      expect(rmSpy).toHaveBeenCalledTimes(2);
      expect(chmodSpy).toHaveBeenCalledTimes(1);
    });

    // A real unlink of a symlink does not hit EPERM on a writable directory, so the failure is
    // simulated: a symlink must neither be chmodded (chmod follows links) nor retried.
    it.skipIf(isWindows)("neither chmods nor retries a symlink that hits EPERM", async () => {
      const targetFile = path.join(outside, "real.env");
      await fs.writeFile(targetFile, "x", { mode: 0o600 });
      const link = path.join(appHome, ".env");
      await fs.symlink(targetFile, link);
      const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(errnoError("EPERM"));
      const chmodSpy = vi.spyOn(fs, "chmod");

      const result = await removePath(link);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("EPERM");
      expect(rmSpy).toHaveBeenCalledTimes(1);
      expect(chmodSpy).not.toHaveBeenCalled();
      expect((await fs.stat(targetFile)).mode & 0o777).toBe(0o600);
    });

    it.skipIf(isWindows)(
      "rejects a target with a trailing separator without touching it",
      async () => {
        const targetDir = path.join(outside, "dir");
        await fs.mkdir(targetDir);
        await fs.writeFile(path.join(targetDir, "keep.txt"), "keep");
        const link = path.join(appHome, "run");
        await fs.symlink(targetDir, link);

        const result = await removePath(`${link}${path.sep}`);

        expect(result.status).toBe("failed");
        expect(result.error).toBeTruthy();
        expect(await exists(link)).toBe(true);
        expect(await fs.readFile(path.join(targetDir, "keep.txt"), "utf-8")).toBe("keep");
      },
    );

    it("reports a persistent failure with the error text and does not throw", async () => {
      const file = path.join(appHome, ".env");
      await fs.writeFile(file, "x");
      const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(errnoError("EPERM"));

      const result = await removePath(file);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("EPERM");
      expect(rmSpy).toHaveBeenCalledTimes(2);
      rmSpy.mockRestore();
      expect(await exists(file)).toBe(true);
    });

    it("does not retry an error other than EPERM or EACCES", async () => {
      const file = path.join(appHome, ".env");
      await fs.writeFile(file, "x");
      const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(errnoError("EBUSY"));

      const result = await removePath(file);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("EBUSY");
      expect(rmSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("removeAppHomeData", () => {
    async function seedHome(): Promise<void> {
      await fs.writeFile(path.join(appHome, ".env"), "TOKEN=x");
      await fs.writeFile(path.join(appHome, "settings.json"), "{}");
      await fs.mkdir(path.join(appHome, "run"));
      await fs.writeFile(path.join(appHome, "run", "bot-service.json"), "{}");
    }

    it("removes only inventory targets and keeps logs and unknown files", async () => {
      await seedHome();
      await fs.mkdir(path.join(appHome, "logs"));
      await fs.writeFile(path.join(appHome, "logs", "a.log"), "log");
      await fs.writeFile(path.join(appHome, "notes.txt"), "mine");

      const { results, homeRemoved } = await removeAppHomeData(appHome);

      expect(results.map((r) => r.status)).toEqual(results.map(() => "removed"));
      expect(results.map((r) => path.basename(r.path)).sort()).toEqual([
        ".env",
        "run",
        "settings.json",
      ]);
      expect(homeRemoved).toBe(false);
      expect(await exists(path.join(appHome, "logs", "a.log"))).toBe(true);
      expect(await exists(path.join(appHome, "notes.txt"))).toBe(true);
      expect(await exists(path.join(appHome, ".env"))).toBe(false);
    });

    it("keeps the home while only logs remain", async () => {
      await seedHome();
      await fs.mkdir(path.join(appHome, "logs"));

      const { homeRemoved } = await removeAppHomeData(appHome);

      expect(homeRemoved).toBe(false);
      expect(await exists(appHome)).toBe(true);
    });

    it("keeps the home while only an unknown file remains", async () => {
      await seedHome();
      await fs.writeFile(path.join(appHome, "notes.txt"), "mine");

      const { homeRemoved } = await removeAppHomeData(appHome);

      expect(homeRemoved).toBe(false);
      expect(await exists(appHome)).toBe(true);
    });

    it("removes the home when it ends empty", async () => {
      await seedHome();

      const { homeRemoved } = await removeAppHomeData(appHome);

      expect(homeRemoved).toBe(true);
      expect(await exists(appHome)).toBe(false);
    });

    it("removes interrupted-write temporary siblings", async () => {
      const tmp = ".env.123.0b8c4b3e-1d5e-4c46-9a53-5b1d0d0d9f11.tmp";
      await fs.writeFile(path.join(appHome, tmp), "x");

      const { results, homeRemoved } = await removeAppHomeData(appHome);

      expect(results.map((r) => path.basename(r.path))).toEqual([tmp]);
      expect(homeRemoved).toBe(true);
    });

    it("is idempotent: a second call reports nothing and the same homeRemoved", async () => {
      await seedHome();
      await fs.mkdir(path.join(appHome, "logs"));

      const first = await removeAppHomeData(appHome);
      const second = await removeAppHomeData(appHome);

      expect(first.results.length).toBeGreaterThan(0);
      expect(second.results).toEqual([]);
      expect(second.homeRemoved).toBe(first.homeRemoved);
    });

    it("reports a homeError when rmdir of the empty home fails", async () => {
      vi.spyOn(fs, "rmdir").mockRejectedValue(errnoError("EACCES"));

      const { homeRemoved, homeError } = await removeAppHomeData(appHome);

      expect(homeRemoved).toBe(false);
      expect(homeError).toContain("EACCES");
    });

    it("treats ENOTEMPTY from rmdir as not empty, without a homeError", async () => {
      vi.spyOn(fs, "rmdir").mockRejectedValue(errnoError("ENOTEMPTY"));

      const { homeRemoved, homeError } = await removeAppHomeData(appHome);

      expect(homeRemoved).toBe(false);
      expect(homeError).toBeUndefined();
    });

    it("never throws when the targets cannot be listed", async () => {
      vi.spyOn(fs, "readdir").mockRejectedValue(errnoError("EACCES"));

      const result = await removeAppHomeData(appHome);

      expect(result.results).toEqual([]);
      expect(result.homeRemoved).toBe(false);
      expect(result.homeError).toContain("EACCES");
    });

    it.skipIf(isWindows)("leaves a symlinked logs entry untouched and keeps the home", async () => {
      const outsideLogs = path.join(outside, "logs");
      await fs.mkdir(outsideLogs);
      await fs.writeFile(path.join(outsideLogs, "a.log"), "log");
      await fs.symlink(outsideLogs, path.join(appHome, "logs"));

      const { results, homeRemoved } = await removeAppHomeData(appHome);

      expect(results).toEqual([]);
      expect(homeRemoved).toBe(false);
      expect((await fs.lstat(path.join(appHome, "logs"))).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(outsideLogs, "a.log"), "utf-8")).toBe("log");
    });

    it.skipIf(isWindows)(
      "unlinks a symlinked temp sibling and keeps its outside target",
      async () => {
        const tmp = ".env.123.0b8c4b3e-1d5e-4c46-9a53-5b1d0d0d9f11.tmp";
        const targetFile = path.join(outside, "victim.txt");
        await fs.writeFile(targetFile, "keep");
        await fs.symlink(targetFile, path.join(appHome, tmp));

        const { results, homeRemoved } = await removeAppHomeData(appHome);

        expect(results).toHaveLength(1);
        expect(results[0]?.status).toBe("removed");
        expect(await fs.readFile(targetFile, "utf-8")).toBe("keep");
        expect(homeRemoved).toBe(true);
      },
    );

    it.skipIf(isWindows)("unlinks symlinked run and local-commands directories only", async () => {
      for (const name of ["run", "local-commands"]) {
        const outsideDir = path.join(outside, name);
        await fs.mkdir(outsideDir);
        await fs.writeFile(path.join(outsideDir, "keep.txt"), "keep");
        await fs.symlink(outsideDir, path.join(appHome, name));
      }

      const { results, homeRemoved } = await removeAppHomeData(appHome);

      expect(results.map((r) => r.status)).toEqual(["removed", "removed"]);
      expect(homeRemoved).toBe(true);
      for (const name of ["run", "local-commands"]) {
        expect(await fs.readFile(path.join(outside, name, "keep.txt"), "utf-8")).toBe("keep");
      }
    });

    it.skipIf(isWindows)(
      "unlinks a symlink loop; the link that dangles after it reports it",
      async () => {
        const a = path.join(appHome, ".env");
        const b = path.join(appHome, "settings.json");
        await fs.symlink(b, a);
        await fs.symlink(a, b);

        // The intact loop cannot be resolved, so no linkTarget. Once the first link is gone the
        // second one dangles and reports the first link's path (order-dependent by design).
        const first = await removePath(a);
        const { results, homeRemoved } = await removeAppHomeData(appHome);

        expect(first.status).toBe("removed");
        expect(first.linkTarget).toBeUndefined();
        expect(await exists(a)).toBe(false);
        expect(results).toHaveLength(1);
        expect(results[0]?.status).toBe("removed");
        expect(results[0]?.linkTarget).toBe(a);
        expect(homeRemoved).toBe(true);
      },
    );

    it.skipIf(isWindows)("reports a home below a file as no error", async () => {
      const file = path.join(tempRoot, "file");
      await fs.writeFile(file, "x");

      const { results, homeRemoved, homeError } = await removeAppHomeData(path.join(file, "home"));

      expect(results).toEqual([]);
      expect(homeRemoved).toBe(false);
      expect(homeError).toBeUndefined();
    });

    it("reports homeRemoved false for a missing home", async () => {
      const missing = path.join(tempRoot, "nope");

      const { results, homeRemoved } = await removeAppHomeData(missing);

      expect(results).toEqual([]);
      expect(homeRemoved).toBe(false);
    });

    it.skipIf(isWindows)("unlinks a symlinked .env and leaves the outside target", async () => {
      const targetFile = path.join(outside, "real.env");
      await fs.writeFile(targetFile, "TOKEN=x");
      await fs.symlink(targetFile, path.join(appHome, ".env"));

      const { results, homeRemoved } = await removeAppHomeData(appHome);

      expect(results).toHaveLength(1);
      expect(results[0]?.linkTarget).toBe(await fs.realpath(targetFile));
      expect(await fs.readFile(targetFile, "utf-8")).toBe("TOKEN=x");
      expect(homeRemoved).toBe(true);
    });

    it.skipIf(isWindows)("does not remove a home that is itself a symlink", async () => {
      const linkedHome = path.join(tempRoot, "linked-home");
      await fs.symlink(appHome, linkedHome);

      const { homeRemoved } = await removeAppHomeData(linkedHome);

      expect(homeRemoved).toBe(false);
      expect(await exists(appHome)).toBe(true);
    });
  });
});
