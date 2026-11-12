import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveCanonicalLogsDir } from "../../src/runtime/log-location.js";

// Real-process check: the built entrypoint initializes the logger before it loads the
// config, so with no TELEGRAM_BOT_TOKEN it fails startup after the main log file exists.
// Every home-like variable points into a temporary directory, so nothing is written to
// the real user's canonical log directory.

const PROJECT_ROOT = resolve(__dirname, "../..");
const ENTRYPOINT = join(PROJECT_ROOT, "dist", "index.js");
const LOG_FILE_NAME = /^opencode-telegram-bot-.+\.log$/;
const isWindows = process.platform === "win32";

let root = "";

beforeAll(() => {
  // dist/ is gitignored; build it when the run did not already.
  if (existsSync(ENTRYPOINT)) return;
  const npm = isWindows ? "npm.cmd" : "npm";
  const build = spawnSync(npm, ["run", "build"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    shell: isWindows,
  });
  if (build.status !== 0) {
    throw new Error(`npm run build failed:\n${build.stdout}\n${build.stderr}`);
  }
}, 180_000);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "log-location-e2e-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildEnv(appHome: string, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    LOCALAPPDATA: join(root, "local-app-data"),
    APPDATA: join(root, "app-data"),
    OPENCODE_TELEGRAM_HOME: appHome,
    ...overrides,
  };
}

function runBot(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [ENTRYPOINT], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  return new Promise((resolveRun) =>
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, output });
    }),
  );
}

function logFilesIn(dirPath: string): string[] {
  return existsSync(dirPath) ? readdirSync(dirPath).filter((name) => LOG_FILE_NAME.test(name)) : [];
}

describe("built entrypoint log location", () => {
  it("writes the main log to the canonical directory when LOG_LOCATION is unset", async () => {
    const appHome = join(root, "app-home");
    mkdirSync(appHome);
    const env = buildEnv(appHome, {});
    const canonicalDir = resolveCanonicalLogsDir(process.platform, env, env.HOME as string);
    expect(canonicalDir.startsWith(root)).toBe(true);

    const result = await runBot(env);

    expect(result.code).toBe(1);
    expect(result.output).toContain("Failed to start bot");
    const files = logFilesIn(canonicalDir);
    expect(files).toHaveLength(1);
    if (!isWindows) {
      expect(statSync(canonicalDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(canonicalDir, files[0]!)).mode & 0o777).toBe(0o600);
    }
    expect(logFilesIn(join(appHome, "logs"))).toEqual([]);
  }, 30_000);

  it("writes the main log to <appHome>/logs and nothing to the canonical directory when LOG_LOCATION=app", async () => {
    const appHome = join(root, "app-home");
    mkdirSync(appHome);
    const env = buildEnv(appHome, { LOG_LOCATION: "app" });
    const canonicalDir = resolveCanonicalLogsDir(process.platform, env, env.HOME as string);

    const result = await runBot(env);

    expect(result.code).toBe(1);
    expect(logFilesIn(join(appHome, "logs"))).toHaveLength(1);
    expect(existsSync(canonicalDir)).toBe(false);
  }, 30_000);
});
