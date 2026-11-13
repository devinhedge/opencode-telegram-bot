import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
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
import { buildProjectToTempDir, type E2eBuild } from "../helpers/e2e-build.js";

// Real-process check of the built CLI (dist/cli.js). The uninstaller really deletes data, calls
// the OS keychain, runs sudo and systemctl, scans processes and stops daemons, so every run is
// fenced:
//   - the child gets an explicit allow-list environment (no inherited variables, no
//     DBUS_SESSION_BUS_ADDRESS) with every home-like variable inside a temporary root;
//   - the child has no stdin, so no terminal exists and no prompt can be answered;
//   - the child is killed after 20 s and after every test;
//   - tests that run on every OS never pass --yes and assert that the temporary home is intact;
//   - the destructive --yes run is limited to Linux hosts that are not containers, have no real
//     systemd unit and have no real installed home (on macOS and Windows the keychain is reached
//     through the OS, so redirecting HOME does not protect it).

const CHILD_TIMEOUT_MS = 20_000;
const isWindows = process.platform === "win32";
const SYSTEMD_UNIT_FILE = "/etc/systemd/system/opencode-telegram-bot.service";
const APP_DIR_NAME = "opencode-telegram-bot";

let build: E2eBuild | undefined;
let cliPath = "";
const tempRoots: string[] = [];
const liveChildren = new Set<ChildProcess>();

// The real default app home of the machine running the test, computed from the account's home
// directory and never from the stubbed child environment.
function realDefaultAppHomes(): string[] {
  const home = userInfo().homedir;
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", APP_DIR_NAME)];
  }
  if (isWindows) {
    return [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), APP_DIR_NAME)];
  }
  const homes = [join(home, ".config", APP_DIR_NAME)];
  if (process.env.XDG_CONFIG_HOME) {
    homes.push(join(process.env.XDG_CONFIG_HOME, APP_DIR_NAME));
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
const realHomes = realDefaultAppHomes();
const realHomeMtimes = new Map(realHomes.map((home) => [home, mtimeOrNull(home)]));
const hostHasSystemdUnit = existsSync(SYSTEMD_UNIT_FILE);
const hostHasInstalledHome = realHomes.some(hasInventoryEntry);
const destructiveUnsafe =
  process.platform !== "linux" || hostIsContainer || hostHasSystemdUnit || hostHasInstalledHome;

beforeAll(() => {
  build = buildProjectToTempDir("uninstall-e2e-build-");
  cliPath = join(build.outDir, "cli.js");
}, 180_000);

afterEach(() => {
  for (const child of liveChildren) {
    child.kill("SIGKILL");
  }
  liveChildren.clear();
});

afterAll(() => {
  build?.cleanup();
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  // The real app home must be exactly as it was before the tests.
  for (const [home, before] of realHomeMtimes) {
    expect(mtimeOrNull(home)).toBe(before);
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "uninstall-e2e-"));
  tempRoots.push(root);
  return root;
}

// Explicit allow-list, nothing else is inherited. SystemRoot and Path are needed by Node on
// Windows and are only passed there.
function buildChildEnv(root: string, appHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inherited = isWindows
    ? ["PATH", "Path", "SystemRoot", "TERM", "LANG"]
    : ["PATH", "TERM", "LANG"];
  for (const name of inherited) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
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

// stdin is "ignore": no terminal, so the uninstaller can never ask a question.
async function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timeout = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      child.kill("SIGKILL");
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
// was added, removed or rewritten with a different size.
function snapshot(dir: string): string[] {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stats = statSync(full);
      entries.push(`${relative(dir, full)}:${stats.isDirectory() ? "dir" : stats.size}`);
      if (stats.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries.sort();
}

function seedAppHome(appHome: string): void {
  mkdirSync(join(appHome, "run"), { recursive: true });
  mkdirSync(join(appHome, "local-commands"), { recursive: true });
  mkdirSync(join(appHome, "logs"), { recursive: true });
  writeFileSync(join(appHome, ".env"), "OPENCODE_API_URL=http://localhost:4096\n");
  writeFileSync(join(appHome, "settings.json"), "{}\n");
  writeFileSync(join(appHome, "secrets.enc"), "not-a-real-secret");
  writeFileSync(join(appHome, "keystore_password"), "not-a-real-password");
  writeFileSync(join(appHome, "run", "scratch.tmp"), "x");
  writeFileSync(join(appHome, "local-commands", "note.txt"), "x");
  writeFileSync(join(appHome, "logs", "opencode-telegram-bot-2026-01-01.log"), "log line\n");
}

describe("built uninstall CLI", () => {
  it("prints the usage for uninstall --help and exits 0 without touching the home", async () => {
    const root = makeRoot();
    const appHome = join(root, "app-home");
    seedAppHome(appHome);
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
      seedAppHome(appHome);
      const before = snapshot(root);

      const result = await runCli(args, buildChildEnv(root, appHome), root);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
      expect(snapshot(root)).toEqual(before);
    },
    60_000,
  );

  it("prints the plan, removes nothing and exits 1 when no terminal is available and --yes is absent", async () => {
    const root = makeRoot();
    const appHome = join(root, "app-home");
    seedAppHome(appHome);
    // Only the app home is compared: the plan scan runs npm, which writes its own log below the
    // temporary HOME.
    const before = snapshot(appHome);

    const result = await runCli(["uninstall"], buildChildEnv(root, appHome), root);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("The uninstaller will do the following:");
    expect(result.stdout).toContain(
      `Remove the data in the OPENCODE_TELEGRAM_HOME directory ${appHome}`,
    );
    expect(result.stdout).toContain("Delete the stored secrets from the keychain");
    expect(result.stdout).toContain("No terminal is available.");
    expect(result.stdout).not.toContain("Removed ");
    expect(snapshot(appHome)).toEqual(before);
    expect(existsSync(join(appHome, ".env"))).toBe(true);
    expect(existsSync(join(appHome, "secrets.enc"))).toBe(true);
  }, 60_000);

  it.skipIf(destructiveUnsafe)(
    "removes the inventory, keeps logs, prints the CLI hint and exits 0 on --yes, and again on a rerun",
    async () => {
      const root = makeRoot();
      // The default home on Linux is $XDG_CONFIG_HOME/opencode-telegram-bot; the override points
      // at the same directory, so it is the single home in the plan.
      const appHome = join(root, "xdg-config", APP_DIR_NAME);
      seedAppHome(appHome);
      const logFile = join(appHome, "logs", "opencode-telegram-bot-2026-01-01.log");
      const env = buildChildEnv(root, appHome);

      const first = await runCli(["uninstall", "--yes"], env, root);

      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`Removed ${join(appHome, ".env")}`);
      expect(first.stdout).toContain("To remove the CLI itself, run: npm uninstall -g");
      for (const name of [
        ".env",
        "settings.json",
        "secrets.enc",
        "keystore_password",
        "run",
        "local-commands",
      ]) {
        expect(existsSync(join(appHome, name))).toBe(false);
      }
      expect(existsSync(logFile)).toBe(true);

      const second = await runCli(["uninstall", "--yes"], env, root);

      expect(second.code).toBe(0);
      expect(second.stdout).toContain("To remove the CLI itself, run: npm uninstall -g");
      expect(existsSync(logFile)).toBe(true);
    },
    60_000,
  );
});
