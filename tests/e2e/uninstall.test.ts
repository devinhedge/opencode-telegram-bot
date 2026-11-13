import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isContainerRuntime } from "../../src/runtime/container.js";
import {
  STORED_APP_HOME_ENTRIES,
  STORED_TEMP_SIBLING_PATTERNS,
} from "../../src/runtime/stored-data.js";
import { SYSTEMD_UNIT_PATH } from "../../src/runtime/uninstall/systemd.js";
import { buildProjectToTempDir, type E2eBuild } from "../helpers/e2e-build.js";

// Real-process check of the built CLI (dist/cli.js). The uninstaller really deletes data, calls
// the OS keychain, runs sudo and systemctl, scans processes and stops daemons, so every run is
// fenced:
//   - the child gets an explicit allow-list environment (no inherited variables) with every
//     home-like variable inside a temporary root. That protects only the app home: the keychain is
//     NOT protected by it (macOS and Windows reach it through the OS; on Linux @napi-rs/keyring
//     falls back to the kernel keyutils keyring, which is keyed by user and session, not by HOME,
//     even without a session bus);
//   - the child has no stdin, so no terminal exists and no prompt can be answered;
//   - the child is killed after 20 s and after every test;
//   - tests that run on every OS never pass --yes to uninstall and assert that the temporary home
//     is intact;
//   - the destructive --yes run is the only one that can reach the keychain, so it runs only on a
//     disposable machine: CI=true in the real environment of the test process, Linux, not a
//     container, not root, no real systemd unit and no real installed home. It cannot run on a
//     developer machine; CI executes it.
// The afterAll check of the real app home's mtime is detective only; the CI-only guard above is
// the protection.

const CHILD_TIMEOUT_MS = 20_000;
const isWindows = process.platform === "win32";
const APP_DIR_NAME = "opencode-telegram-bot";
const SEED_UUID = "123e4567-e89b-42d3-a456-426614174000";
const LOG_NAME = "opencode-telegram-bot-2026-01-01.log";

let build: E2eBuild | undefined;
let cliPath = "";
const tempRoots: string[] = [];
const liveChildren = new Set<ChildProcess>();

// The real default app homes of the machine running the test, computed from the account's home
// directory and the REAL process environment, never from the stubbed child environment.
function realDefaultAppHomes(): string[] {
  const home = userInfo().homedir;
  const homes: string[] = [];
  if (process.platform === "darwin") {
    homes.push(join(home, "Library", "Application Support", APP_DIR_NAME));
  } else if (isWindows) {
    homes.push(join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), APP_DIR_NAME));
  } else {
    homes.push(join(home, ".config", APP_DIR_NAME));
    if (process.env.XDG_CONFIG_HOME) {
      homes.push(join(process.env.XDG_CONFIG_HOME, APP_DIR_NAME));
    }
  }
  if (process.env.OPENCODE_TELEGRAM_HOME) {
    homes.push(process.env.OPENCODE_TELEGRAM_HOME);
  }
  return homes;
}

function hasInventoryEntry(appHome: string): boolean {
  let children: string[];
  try {
    children = readdirSync(appHome);
  } catch {
    return false;
  }
  const names = new Set(STORED_APP_HOME_ENTRIES.map((entry) => entry.name));
  return children.some(
    (child) => names.has(child) || STORED_TEMP_SIBLING_PATTERNS.some((p) => p.test(child)),
  );
}

function mtimeOrNull(target: string): number | null {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return null;
  }
}

const hostIsContainer = isContainerRuntime({ env: {} });
const hostIsRoot = process.getuid?.() === 0;
// In a container or as root the child prints the refusal and exits 1 before anything else.
const hostRefuses = hostIsContainer || hostIsRoot;
const realHomes = realDefaultAppHomes();
const realHomeMtimes = new Map(realHomes.map((home) => [home, mtimeOrNull(home)]));
// The current directory is the app home in sources mode.
const hostHasInstalledHome = [...realHomes, process.cwd()].some(hasInventoryEntry);
const destructiveUnsafe =
  process.env.CI !== "true" ||
  process.platform !== "linux" ||
  hostRefuses ||
  existsSync(SYSTEMD_UNIT_PATH) ||
  hostHasInstalledHome;

beforeAll(() => {
  build = buildProjectToTempDir("uninstall-e2e-build-");
  cliPath = join(build.outDir, "cli.js");
}, 180_000);

// Kills the child and, on POSIX, its process group (the child leads its own group, so nothing
// outside the child and its descendants is signaled). Descendants are short-lived scans (ps,
// lsof, npm) that end with the child anyway.
function killChild(child: ChildProcess): void {
  try {
    if (!isWindows && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

afterEach(() => {
  for (const child of liveChildren) {
    killChild(child);
  }
  liveChildren.clear();
});

afterAll(() => {
  build?.cleanup();
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Detective only: the real app home must be exactly as it was before the tests.
  for (const [home, before] of realHomeMtimes) {
    expect(mtimeOrNull(home)).toBe(before);
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "uninstall-e2e-"));
  tempRoots.push(root);
  return root;
}

// Explicit allow-list, nothing else is inherited. The PATH key keeps the spelling the host
// process uses (Path on Windows); SystemRoot is needed by Node on Windows and passed only there.
function buildChildEnv(root: string, appHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inherited = new Set(isWindows ? ["SYSTEMROOT", "TERM", "LANG"] : ["TERM", "LANG"]);
  inherited.add("PATH");
  for (const name of Object.keys(process.env)) {
    if (inherited.has(name.toUpperCase()) && process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return {
    ...env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    APPDATA: join(root, "app-data"),
    LOCALAPPDATA: join(root, "local-app-data"),
    OPENCODE_TELEGRAM_HOME: appHome,
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// stdin is "ignore": no terminal, so the uninstaller can never ask a question. On POSIX the
// child leads its own process group so that killChild can end the whole group.
async function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
    });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timeout = setTimeout(() => killChild(child), CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      killChild(child);
      rejectRun(error);
    });
    // "close" fires after "exit" and after the output streams ended.
    child.once("close", (code) => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      resolveRun({ code, stdout, stderr });
    });
  });
}

// Every path below `dir` with the file size (or "dir"), sorted: equal snapshots mean nothing
// was added, removed or rewritten with a different size. Symlinks are listed as links.
function snapshot(dir: string): string[] {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stats = lstatSync(full);
      const kind = stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : stats.size;
      entries.push(`${relative(dir, full)}:${kind}`);
      if (stats.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries.sort();
}

interface SeededHome {
  /** Inventory entries seeded directly in the home (everything except logs/). */
  entryNames: string[];
  /** A file outside the home that the symlinked secrets.enc points to. */
  outsideTarget: string;
  logFile: string;
}

// Seeds every inventory entry, temp siblings, a symlinked secrets.enc (a plain file on Windows,
// where creating links may need privileges) and logs/.
function seedAppHome(root: string, appHome: string): SeededHome {
  const outsideDir = join(root, "outside");
  mkdirSync(outsideDir, { recursive: true });
  const outsideTarget = join(outsideDir, "linked-secrets.enc");
  writeFileSync(outsideTarget, "not-a-real-secret");

  mkdirSync(appHome, { recursive: true });
  const entryNames: string[] = [];
  for (const entry of STORED_APP_HOME_ENTRIES) {
    const target = join(appHome, entry.name);
    if (entry.kind === "dir") {
      mkdirSync(target);
      writeFileSync(join(target, "note.txt"), "x");
    } else if (entry.name === "secrets.enc" && !isWindows) {
      symlinkSync(outsideTarget, target, "file");
    } else {
      writeFileSync(target, "not-a-real-secret\n");
    }
    entryNames.push(entry.name);
  }
  for (const sibling of [`.env.4242.${SEED_UUID}.tmp`, `secrets.enc.4242.${SEED_UUID}.tmp`]) {
    expect(STORED_TEMP_SIBLING_PATTERNS.some((pattern) => pattern.test(sibling))).toBe(true);
    writeFileSync(join(appHome, sibling), "x");
    entryNames.push(sibling);
  }

  mkdirSync(join(appHome, "logs"), { recursive: true });
  const logFile = join(appHome, "logs", LOG_NAME);
  writeFileSync(logFile, "log line\n");
  return { entryNames, outsideTarget, logFile };
}

describe("built uninstall CLI", () => {
  it("prints the usage for uninstall --help and exits 0 without touching the home", async () => {
    const root = makeRoot();
    const appHome = join(root, "app-home");
    seedAppHome(root, appHome);
    const before = snapshot(root);

    const result = await runCli(["uninstall", "--help"], buildChildEnv(root, appHome), root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("opencode-telegram uninstall [--yes] [--stop-opencode]");
    expect(snapshot(root)).toEqual(before);
  }, 60_000);

  it.each([
    [["stop", "--yes"], "Option --yes is supported only for the uninstall command"],
    [
      ["status", "--stop-opencode"],
      "Option --stop-opencode is supported only for the uninstall command",
    ],
  ])(
    "rejects %j with exit 2 without touching the home",
    async (args, message) => {
      const root = makeRoot();
      const appHome = join(root, "app-home");
      seedAppHome(root, appHome);
      const before = snapshot(root);

      const result = await runCli(args, buildChildEnv(root, appHome), root);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
      expect(snapshot(root)).toEqual(before);
    },
    60_000,
  );

  it.skipIf(hostRefuses)(
    "prints the plan, removes nothing and exits 1 when no terminal is available and --yes is absent",
    async () => {
      const root = makeRoot();
      const appHome = join(root, "app-home");
      const seeded = seedAppHome(root, appHome);
      // Only the app home is compared: the plan scan runs npm, which writes its own log below the
      // temporary HOME.
      const before = snapshot(appHome);

      const result = await runCli(["uninstall"], buildChildEnv(root, appHome), root);

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("The uninstaller will do the following:");
      expect(result.stdout).toContain(
        `Remove the data in the OPENCODE_TELEGRAM_HOME directory ${appHome}`,
      );
      expect(result.stdout).toContain("Delete the stored secrets from the keychain");
      expect(result.stdout).toContain("Log files are never removed and stay in ");
      expect(result.stdout).not.toContain("Stop the OpenCode server");
      expect(result.stdout).toContain("No terminal is available.");
      expect(result.stdout).not.toContain("Removed ");
      expect(snapshot(appHome)).toEqual(before);
      for (const name of seeded.entryNames) {
        expect(() => lstatSync(join(appHome, name))).not.toThrow();
      }
      expect(existsSync(seeded.outsideTarget)).toBe(true);
      expect(existsSync(seeded.logFile)).toBe(true);
    },
    60_000,
  );

  // Runs only where the host is a container or root: the child refuses before anything else.
  it.skipIf(!hostRefuses)(
    "refuses to run in a container or as root, removes nothing and exits 1",
    async () => {
      const root = makeRoot();
      const appHome = join(root, "app-home");
      seedAppHome(root, appHome);
      const before = snapshot(appHome);

      const result = await runCli(["uninstall"], buildChildEnv(root, appHome), root);

      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/Refusing to run (inside a container|as root)/);
      expect(snapshot(appHome)).toEqual(before);
    },
    60_000,
  );

  // Needs a disposable machine (CI=true): it can reach the keychain, which HOME does not protect.
  // It cannot run on a developer machine; CI executes it.
  it.skipIf(destructiveUnsafe)(
    "removes the inventory, keeps logs, prints the CLI hint and exits 0 on --yes, and again on a rerun",
    async () => {
      const root = makeRoot();
      // The default home on Linux is $XDG_CONFIG_HOME/opencode-telegram-bot; the override points
      // at the same directory, so it is the single home in the plan.
      const appHome = join(root, "xdg-config", APP_DIR_NAME);
      const seeded = seedAppHome(root, appHome);
      const env = buildChildEnv(root, appHome);

      const first = await runCli(["uninstall", "--yes"], env, root);

      expect(first.code).toBe(0);
      expect(first.stderr).toBe("");
      expect(first.stdout).toContain(`Removed ${join(appHome, ".env")}`);
      expect(first.stdout).toContain("systemd unit: not installed");
      expect(first.stdout).toMatch(/Uninstall finished/);
      expect(first.stdout).toContain("To remove the CLI itself, run: npm uninstall -g");
      // Bot processes found on the host are skipped without a terminal: never signaled.
      expect(first.stdout).not.toContain("Stopped process");
      expect(first.stdout).not.toContain("Could not stop process");
      for (const name of seeded.entryNames) {
        expect(existsSync(join(appHome, name))).toBe(false);
        expect(() => lstatSync(join(appHome, name))).toThrow();
      }
      expect(existsSync(seeded.logFile)).toBe(true);
      expect(existsSync(seeded.outsideTarget)).toBe(true);

      const second = await runCli(["uninstall", "--yes"], env, root);

      expect(second.code).toBe(0);
      expect(second.stderr).toBe("");
      expect(second.stdout).toMatch(/Uninstall finished/);
      expect(second.stdout).toContain("To remove the CLI itself, run: npm uninstall -g");
      expect(existsSync(seeded.logFile)).toBe(true);
    },
    60_000,
  );
});
