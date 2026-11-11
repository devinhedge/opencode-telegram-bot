import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOG_FILE_PREFIX,
  SERVICE_LOG_FILE_PATTERN,
  buildMainLogFileName,
  buildServiceLogFileName,
  ensureLogsDir,
  getMainLogFilePattern,
  pruneLogFiles,
  secureLogFile,
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
});
