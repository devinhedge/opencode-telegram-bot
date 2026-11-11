import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOG_FILE_PREFIX,
  SERVICE_LOG_FILE_PATTERN,
  buildMainLogFileName,
  buildServiceLogFileName,
  compareLogNames,
  ensureLogsDir,
  ensureLogsDirSync,
  getLogRetention,
  getMainLogFilePattern,
  pruneLogFiles,
  secureLogFile,
  secureLogFileSync,
} from "../../src/utils/log-files.js";

const isWindows = process.platform === "win32";
const NOW = new Date("2026-03-04T05:06:07.000Z");

describe("utils/log-files naming", () => {
  it("uses the documented prefix", () => {
    expect(LOG_FILE_PREFIX).toBe("opencode-telegram-bot");
  });

  it("builds installed and sources main names", () => {
    expect(buildMainLogFileName("installed", NOW, 42)).toBe("opencode-telegram-bot-2026-03-04.log");
    expect(buildMainLogFileName("sources", NOW, 42)).toBe(
      "opencode-telegram-bot-2026-03-04_05-06-07_42.log",
    );
  });

  it("builds service names", () => {
    expect(buildServiceLogFileName(NOW)).toBe(
      "opencode-telegram-bot-service-2026-03-04_05-06-07.log",
    );
  });

  it("main patterns match only their own mode's names", () => {
    const installed = getMainLogFilePattern("installed");
    const sources = getMainLogFilePattern("sources");
    const installedName = buildMainLogFileName("installed", NOW, 1);
    const sourcesName = buildMainLogFileName("sources", NOW, 1);

    expect(installed.test(installedName)).toBe(true);
    expect(installed.test(sourcesName)).toBe(false);
    expect(sources.test(sourcesName)).toBe(true);
    expect(sources.test(installedName)).toBe(false);
  });

  it("keeps main and service patterns disjoint", () => {
    const serviceName = buildServiceLogFileName(NOW);

    expect(getMainLogFilePattern("installed").test(serviceName)).toBe(false);
    expect(getMainLogFilePattern("sources").test(serviceName)).toBe(false);
    expect(SERVICE_LOG_FILE_PATTERN.test(serviceName)).toBe(true);
    expect(SERVICE_LOG_FILE_PATTERN.test(buildMainLogFileName("installed", NOW, 1))).toBe(false);
    expect(SERVICE_LOG_FILE_PATTERN.test(buildMainLogFileName("sources", NOW, 1))).toBe(false);
  });
});

describe("utils/log-files filesystem helpers", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "log-files-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function touch(name: string): Promise<void> {
    await fs.writeFile(path.join(root, name), "x");
  }

  it("prunes only the oldest matching files and leaves others alone", async () => {
    const service = [
      "opencode-telegram-bot-service-2026-01-01_00-00-00.log",
      "opencode-telegram-bot-service-2026-01-02_00-00-00.log",
      "opencode-telegram-bot-service-2026-01-03_00-00-00.log",
    ];
    const main = [
      "opencode-telegram-bot-2026-01-01.log",
      "opencode-telegram-bot-2026-01-02.log",
      "opencode-telegram-bot-2026-01-03.log",
    ];
    for (const name of [...service, ...main, "notes.txt"]) {
      await touch(name);
    }
    const onError = vi.fn();

    await pruneLogFiles(root, SERVICE_LOG_FILE_PATTERN, 2, onError);

    const remaining = (await fs.readdir(root)).sort();
    expect(remaining).toEqual([...main, "notes.txt", service[1], service[2]].sort());
    expect(onError).not.toHaveBeenCalled();
  });

  it("does nothing when retention exceeds file count or directory is empty", async () => {
    const onError = vi.fn();
    await pruneLogFiles(root, SERVICE_LOG_FILE_PATTERN, 5, onError);
    await touch("opencode-telegram-bot-service-2026-01-01_00-00-00.log");
    await pruneLogFiles(root, SERVICE_LOG_FILE_PATTERN, 5, onError);

    expect(await fs.readdir(root)).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a missing directory through onError without throwing", async () => {
    const onError = vi.fn();

    await expect(
      pruneLogFiles(path.join(root, "missing"), SERVICE_LOG_FILE_PATTERN, 2, onError),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.skipIf(isWindows)("creates a nested directory at 0o700", async () => {
    const target = path.join(root, "a", "b");

    await ensureLogsDir(target);

    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWindows)("tightens an existing 0o755 directory to 0o700", async () => {
    const target = path.join(root, "existing");
    await fs.mkdir(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);

    await ensureLogsDir(target);

    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWindows)("tightens a 0o644 file to 0o600", async () => {
    const file = path.join(root, "f.log");
    await fs.writeFile(file, "x");
    await fs.chmod(file, 0o644);

    await secureLogFile(file);

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("sorts same-second sources files by numeric pid", async () => {
    const pid9 = "opencode-telegram-bot-2026-01-01_00-00-00_9.log";
    const pid10 = "opencode-telegram-bot-2026-01-01_00-00-00_10.log";
    await touch(pid9);
    await touch(pid10);

    await pruneLogFiles(root, getMainLogFilePattern("sources"), 1, vi.fn());

    expect(await fs.readdir(root)).toEqual([pid10]);
  });

  it("prunes sources-mode files, removing the oldest first", async () => {
    const names = [
      "opencode-telegram-bot-2026-01-01_00-00-00_5.log",
      "opencode-telegram-bot-2026-01-02_00-00-00_5.log",
      "opencode-telegram-bot-2026-01-03_00-00-00_5.log",
      "opencode-telegram-bot-2026-01-04_00-00-00_5.log",
    ];
    for (const name of names) {
      await touch(name);
    }

    await pruneLogFiles(root, getMainLogFilePattern("sources"), 2, vi.fn());

    expect((await fs.readdir(root)).sort()).toEqual([names[2], names[3]]);
  });

  it("prunes interleaved same-date main and service files independently", async () => {
    const main = [
      "opencode-telegram-bot-2026-01-01.log",
      "opencode-telegram-bot-2026-01-02.log",
      "opencode-telegram-bot-2026-01-03.log",
    ];
    const service = [
      "opencode-telegram-bot-service-2026-01-01_00-00-00.log",
      "opencode-telegram-bot-service-2026-01-02_00-00-00.log",
      "opencode-telegram-bot-service-2026-01-03_00-00-00.log",
    ];
    for (const name of [...main, ...service]) {
      await touch(name);
    }

    await pruneLogFiles(root, getMainLogFilePattern("installed"), 1, vi.fn());
    expect((await fs.readdir(root)).sort()).toEqual([main[2], ...service].sort());

    await pruneLogFiles(root, SERVICE_LOG_FILE_PATTERN, 1, vi.fn());
    expect((await fs.readdir(root)).sort()).toEqual([main[2], service[2]].sort());
  });

  it.skipIf(isWindows)("rejects secureLogFile on a missing file with ENOENT", async () => {
    await expect(secureLogFile(path.join(root, "missing.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("orders mixed pid-suffix and plain names identically for every permutation", () => {
    const names = ["p_9.log", "p_10.log", "p_1x.log"];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((index) => names[index] as string));

    const results = permutations.map((permutation) => [...permutation].sort(compareLogNames));

    for (const result of results) {
      expect(result).toEqual(["p_1x.log", "p_9.log", "p_10.log"]);
    }
  });

  it("rejects when the target path is a regular file", async () => {
    const file = path.join(root, "not-a-dir");
    await fs.writeFile(file, "x");

    await expect(ensureLogsDir(file)).rejects.toThrow();
  });

  it.skipIf(isWindows)("propagates a chmod failure on an existing directory", async () => {
    const target = path.join(root, "locked");
    await fs.mkdir(target);
    const failure = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const spy = vi.spyOn(fs, "chmod").mockRejectedValueOnce(failure);

    try {
      await expect(ensureLogsDir(target)).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(isWindows)("ensureLogsDirSync creates a nested directory at 0o700", async () => {
    const target = path.join(root, "s", "t");

    ensureLogsDirSync(target);

    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWindows)("ensureLogsDirSync tightens an existing 0o755 directory", async () => {
    const target = path.join(root, "existing-sync");
    await fs.mkdir(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);

    ensureLogsDirSync(target);

    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
  });

  it("ensureLogsDirSync throws when the target path is a regular file", async () => {
    const file = path.join(root, "not-a-dir-sync");
    await fs.writeFile(file, "x");

    expect(() => ensureLogsDirSync(file)).toThrow();
  });

  it.skipIf(isWindows)("secureLogFileSync tightens a 0o644 file to 0o600", async () => {
    const file = path.join(root, "sync.log");
    await fs.writeFile(file, "x");
    await fs.chmod(file, 0o644);

    secureLogFileSync(file);

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)("secureLogFileSync throws ENOENT on a missing file", () => {
    expect(() => secureLogFileSync(path.join(root, "missing-sync.log"))).toThrow(/ENOENT/);
  });
});

describe("utils/log-files getLogRetention", () => {
  it("defaults to 10 when LOG_RETENTION is unset", () => {
    expect(getLogRetention({})).toBe(10);
  });

  it("uses a valid positive integer", () => {
    expect(getLogRetention({ LOG_RETENTION: "3" })).toBe(3);
  });

  it("falls back to the default for zero", () => {
    expect(getLogRetention({ LOG_RETENTION: "0" })).toBe(10);
  });

  it("falls back to the default for a negative value", () => {
    expect(getLogRetention({ LOG_RETENTION: "-2" })).toBe(10);
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(getLogRetention({ LOG_RETENTION: "abc" })).toBe(10);
  });
});
