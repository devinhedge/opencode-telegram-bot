import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isContainerRuntime } from "../../src/runtime/container.js";
import { resolveCanonicalLogsDir } from "../../src/runtime/log-location.js";

// Real-process check: the built entrypoint initializes the logger before it loads the
// config, so with no TELEGRAM_BOT_TOKEN it fails startup after the main log file exists.
// Every home-like variable points into a temporary directory, so nothing is written to
// the real user's canonical log directory.

const PROJECT_ROOT = resolve(__dirname, "../..");
const LOG_FILE_NAME = /^opencode-telegram-bot-.+\.log$/;
const isWindows = process.platform === "win32";
const RUNTIME_MODES = ["installed", "sources"] as const;

let root = "";
let buildRoot = "";
let entrypoint = "";

beforeAll(() => {
  // The build goes to a temporary directory so the test never writes into the repository (the
  // repo dist/ may also be stale). The temporary root mimics the package layout the compiled
  // code expects: dist/ for the code, package.json and .env.example one level above it (read
  // relative to the compiled files), and node_modules for dependency resolution. On Windows
  // the node_modules link is a junction, which needs no elevated privileges.
  buildRoot = mkdtempSync(join(tmpdir(), "log-location-e2e-build-"));
  const outDir = join(buildRoot, "dist");
  const tsc = join(PROJECT_ROOT, "node_modules", "typescript", "bin", "tsc");
  const build = spawnSync(
    process.execPath,
    [tsc, "-p", join(PROJECT_ROOT, "tsconfig.json"), "--outDir", outDir],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`tsc build failed:\n${build.stdout}\n${build.stderr}`);
  }

  copyFileSync(join(PROJECT_ROOT, "package.json"), join(buildRoot, "package.json"));
  copyFileSync(join(PROJECT_ROOT, ".env.example"), join(buildRoot, ".env.example"));
  symlinkSync(
    join(PROJECT_ROOT, "node_modules"),
    join(buildRoot, "node_modules"),
    isWindows ? "junction" : "dir",
  );
  entrypoint = join(outDir, "index.js");
}, 180_000);

afterAll(() => {
  if (buildRoot) {
    rmSync(buildRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "log-location-e2e-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildEnv(
  appHome: string,
  mode: string,
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
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
    OPENCODE_TELEGRAM_RUNTIME_MODE: mode,
    ...overrides,
  };
}

// The entrypoint re-resolves the runtime mode from argv and overrides the environment
// variable, so the mode is passed as --mode as well; the variable is pinned for clarity.
function runBot(
  env: NodeJS.ProcessEnv,
  mode: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entrypoint, "--mode", mode], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    // "close" fires after "exit" and after the output streams ended.
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, output });
    });
  });
}

function logFilesIn(dirPath: string): string[] {
  return existsSync(dirPath) ? readdirSync(dirPath).filter((name) => LOG_FILE_NAME.test(name)) : [];
}

// The spawned process cannot be told it is not in a container: /.dockerenv is read from the real
// filesystem. Inside a container the default location is the app home, so the canonical-directory
// case cannot run there.
const hostIsContainer = isContainerRuntime({ env: {} });

describe.each(RUNTIME_MODES)("built entrypoint log location in %s mode", (mode) => {
  it.skipIf(hostIsContainer)(
    "writes the main log to the canonical directory when LOG_LOCATION is unset",
    async () => {
      const appHome = join(root, "app-home");
      mkdirSync(appHome);
      const env = buildEnv(appHome, mode, {});
      const canonicalDir = resolveCanonicalLogsDir(process.platform, env, env.HOME as string);
      expect(canonicalDir.startsWith(root)).toBe(true);

      const result = await runBot(env, mode);

      // The logger is initialized before the config loads (src/index.ts), and the failed
      // startup exits through process.exit(1) after a bounded flush, so the log file exists
      // once the child has exited.
      expect(result.code).toBe(1);
      expect(result.output).toContain("Failed to start bot");
      const files = logFilesIn(canonicalDir);
      expect(files).toHaveLength(1);
      if (!isWindows) {
        expect(statSync(canonicalDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(canonicalDir, files[0]!)).mode & 0o777).toBe(0o600);
      }
      expect(logFilesIn(join(appHome, "logs"))).toEqual([]);
    },
    30_000,
  );

  it("writes the main log to <appHome>/logs and nothing to the canonical directory when LOG_LOCATION=app", async () => {
    const appHome = join(root, "app-home");
    mkdirSync(appHome);
    const env = buildEnv(appHome, mode, { LOG_LOCATION: "app" });
    const canonicalDir = resolveCanonicalLogsDir(process.platform, env, env.HOME as string);

    const result = await runBot(env, mode);

    expect(result.code).toBe(1);
    expect(logFilesIn(join(appHome, "logs"))).toHaveLength(1);
    expect(existsSync(canonicalDir)).toBe(false);
    // The parent folder and the per-OS base folder must not have been created either.
    expect(existsSync(dirname(canonicalDir))).toBe(false);
    for (const base of ["xdg-state", "local-app-data", join("home", "Library")]) {
      expect(existsSync(join(root, base))).toBe(false);
    }
  }, 30_000);
});
