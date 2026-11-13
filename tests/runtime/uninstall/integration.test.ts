import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { de } from "../../../src/i18n/de.js";
import { en } from "../../../src/i18n/en.js";
import type {
  BotServiceStatus,
  ServiceOperationResult,
} from "../../../src/runtime/service/types.js";
import {
  KEYCHAIN_SERVICE,
  PRESERVED_APP_HOME_ENTRIES,
  STORED_APP_HOME_ENTRIES,
  STORED_KEYCHAIN_ACCOUNTS,
  STORED_TEMP_SIBLING_PATTERNS,
  listAppHomeTargets,
} from "../../../src/runtime/stored-data.js";
import {
  resolveUninstallHomes,
  validateOverrideHome,
} from "../../../src/runtime/uninstall/homes.js";
import { removeKeychainAccounts } from "../../../src/runtime/uninstall/keychain.js";
import type { KeychainRemovalStore } from "../../../src/runtime/uninstall/keychain.js";
import { createUninstallTranslator } from "../../../src/runtime/uninstall/messages.js";
import type { OpencodeLookup } from "../../../src/runtime/uninstall/opencode-server.js";
import type { BotProcess } from "../../../src/runtime/uninstall/processes.js";
import { removeAppHomeData, removePath } from "../../../src/runtime/uninstall/remove-path.js";
import {
  runUninstall,
  type UninstallDeps,
  type UninstallOptions,
} from "../../../src/runtime/uninstall/run.js";
import type { SystemdDeps } from "../../../src/runtime/uninstall/systemd.js";
import { assertInsideTempRoot, exists as lstatExists, isUnder } from "./temp-root-guard.js";

// No real child process may start from this file: every child_process entry point is a mock that
// records the request, and afterEach fails the test when any was made.
const childProcess = vi.hoisted(() => {
  const unexpected: string[] = [];
  const refuse = (name: string) =>
    vi.fn((...args: unknown[]) => {
      unexpected.push(`${name} ${String(args[0])}`);
      throw new Error(`real ${name} is not allowed in this test file`);
    });
  return {
    unexpected,
    exec: refuse("exec"),
    execFile: refuse("execFile"),
    spawn: refuse("spawn"),
    execSync: refuse("execSync"),
    execFileSync: refuse("execFileSync"),
    spawnSync: refuse("spawnSync"),
    fork: refuse("fork"),
  };
});

vi.mock("node:child_process", () => ({
  exec: childProcess.exec,
  execFile: childProcess.execFile,
  spawn: childProcess.spawn,
  execSync: childProcess.execSync,
  execFileSync: childProcess.execFileSync,
  spawnSync: childProcess.spawnSync,
  fork: childProcess.fork,
}));

const isWindows = process.platform === "win32";
const SENTINEL = "SECRET-SENTINEL";
const FAKE_DAEMON_PID = 424242;
const YES: UninstallOptions = { yes: true, stopOpencode: false };
const CLI_COMMAND = "npm uninstall -g @grinev/opencode-telegram-bot";
const tEn = createUninstallTranslator(undefined);
const tDe = createUninstallTranslator("de");

// The real user home from the password database (a stubbed HOME cannot hide it).
const REAL_HOME = os.userInfo().homedir;
const REAL_APP_HOME_NAMES = [
  path.join(REAL_HOME, "Library", "Application Support", "opencode-telegram-bot"),
  path.join(REAL_HOME, ".config", "opencode-telegram-bot"),
  path.join(REAL_HOME, "AppData", "Roaming", "opencode-telegram-bot"),
];

const TEMP_SIBLINGS = [
  ".env.123.0123abcd-0123-4567-89ab-0123456789ab.tmp",
  "secrets.enc.456.89abcdef-0123-4567-89ab-0123456789ab.tmp",
];
const SECRET_FILES = ["secrets.enc", "keystore_password"];

// The run catches step errors, so a guard throw alone could be swallowed: every violation is also
// recorded and afterEach fails the test when the list is not empty.
const guardViolations: string[] = [];

function guard(target: string, root: string, followTarget = true): void {
  try {
    assertInsideTempRoot(target, root, { followTarget });
  } catch (error) {
    guardViolations.push(target);
    throw error;
  }
}

/** The per-target "left in place" step line (the summary line is a different template). */
function isTargetLeftLine(line: string): boolean {
  return line.startsWith("Left the link target ");
}

const exists = async (target: string): Promise<boolean> => lstatExists(target);

const INVENTORY_NAMES = [...STORED_APP_HOME_ENTRIES.map((entry) => entry.name), ...TEMP_SIBLINGS];

async function populateHome(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  for (const entry of STORED_APP_HOME_ENTRIES) {
    const target = path.join(home, entry.name);
    if (entry.kind === "dir") {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "content.json"), "{}");
    } else {
      await fs.writeFile(target, `TELEGRAM_BOT_TOKEN=${SENTINEL}\n`);
    }
  }
  for (const sibling of TEMP_SIBLINGS) {
    await fs.writeFile(path.join(home, sibling), "partial");
  }
  await fs.mkdir(path.join(home, "logs"), { recursive: true });
  await fs.writeFile(path.join(home, "logs", "opencode-telegram-bot-2026-11-12.log"), "log");
  await fs.writeFile(path.join(home, "notes.txt"), "the user's own notes");
  // A stub daemon state file with a fake pid. In most tests it is decorative (getDaemonStatus is
  // a fake that does not read it); the "state file" test derives the status from it. No dep
  // ever signals the pid.
  await fs.writeFile(
    path.join(home, "run", "bot-service.json"),
    JSON.stringify({ pid: FAKE_DAEMON_PID, startedAt: "2026-11-12T00:00:00.000Z" }),
  );
}

describe("runtime/uninstall integration", () => {
  let tempRoot: string;
  let tempHome: string;
  let outside: string;
  let touched: string[];
  let lines: string[];
  let prompts: string[];
  let answers: (string | null)[];
  let secrets: Map<string, string>;
  let signals: string[];
  let daemonStatus: BotServiceStatus;
  let stopDaemonCalls: number;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-integration-"));
    tempHome = path.join(tempRoot, "user-home");
    outside = path.join(tempRoot, "outside");
    await fs.mkdir(tempHome, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    // The default home resolves from these, so it lands inside the temp directory.
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(tempHome, ".config"));
    vi.stubEnv("APPDATA", path.join(tempHome, "AppData", "Roaming"));
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", "");
    touched = [];
    lines = [];
    prompts = [];
    answers = [];
    signals = [];
    stopDaemonCalls = 0;
    secrets = new Map(STORED_KEYCHAIN_ACCOUNTS.map((account) => [account, SENTINEL]));
    daemonStatus = {
      status: "running",
      service: {
        pid: FAKE_DAEMON_PID,
        startedAt: "2026-11-12T00:00:00.000Z",
        logFilePath: path.join(tempRoot, "daemon.log"),
        mode: "daemon",
      },
      cleanupReason: null,
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempRoot, { recursive: true, force: true });
    const violations = guardViolations.splice(0);
    expect(violations, "a fake was asked to touch a path outside the temp root").toEqual([]);
    const realCommands = childProcess.unexpected.splice(0);
    expect(realCommands, "a real child process was requested").toEqual([]);
  });

  /** A COMPLETE deps object: every key is set here, nothing falls back to a real default. */
  function createDeps(
    env: NodeJS.ProcessEnv,
    options: {
      onAsk?: (question: string) => Promise<void>;
      /** Replaces the real override validator (the guard still sees the path first). */
      validate?: UninstallDeps["validateOverride"];
      /** Derives the daemon status from the state file in this (temp) home. */
      statusFromStateFileIn?: string;
    } = {},
  ): UninstallDeps {
    const store: KeychainRemovalStore = {
      isAvailable: async () => true,
      removeSecret: async (account) => (secrets.delete(account) ? "removed" : "absent"),
    };
    const systemd: SystemdDeps = {
      platform: "linux",
      unitExists: async () => false,
      hasSudo: async () => false,
      isInteractive: false,
      run: vi.fn(async () => 0),
    };
    const note = (target: string): void => {
      touched.push(target);
    };
    // The daemon status is a fake; with statusFromStateFileIn it is built from the state file
    // (fake pid) in the temp home, until the fake stop has run.
    const readStatus = async (): Promise<BotServiceStatus> => {
      if (options.statusFromStateFileIn === undefined || daemonStatus.status !== "running") {
        return daemonStatus;
      }
      const stateFile = path.join(options.statusFromStateFileIn, "run", "bot-service.json");
      guard(stateFile, tempRoot);
      const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
        pid: number;
        startedAt: string;
      };
      return {
        status: "running",
        service: { ...state, logFilePath: path.join(tempRoot, "daemon.log"), mode: "daemon" },
        cleanupReason: null,
      };
    };
    return {
      env,
      // Only selects the Linux-only steps (the systemd unit check, whose runner is a fake). Home
      // resolution uses the real process.platform and the stubbed environment, not this value.
      platform: "linux",
      isContainer: () => false,
      getUid: () => 1000,
      isInteractive: true,
      ask: async (question: string) => {
        prompts.push(question);
        await options.onAsk?.(question);
        return answers.length > 0 ? (answers.shift() ?? null) : null;
      },
      write: (line: string) => {
        lines.push(line);
      },
      // The real homes lookup, guarded: both homes must lie inside the temp directory.
      getHomes: () => {
        const homes = resolveUninstallHomes(env);
        note(homes.defaultHome);
        guard(homes.defaultHome, tempRoot);
        if (homes.overrideHome !== null) {
          note(homes.overrideHome);
          guard(homes.overrideHome, tempRoot);
        }
        return homes;
      },
      getDaemonStatus: readStatus,
      stopDaemon: async (): Promise<ServiceOperationResult> => {
        stopDaemonCalls += 1;
        const service = (await readStatus()).service;
        daemonStatus = { status: "stopped", service: null, cleanupReason: null };
        return service
          ? { success: true, service, cleanupReason: null }
          : { success: true, service: null, cleanupReason: null, alreadyStopped: true };
      },
      getOwnPidChain: async () => [9100, 9099],
      findSystemdMainPid: async () => null,
      findBotProcesses: async (): Promise<BotProcess[]> => [],
      reverifyProcess: async () => {
        signals.push("reverify");
        return false;
      },
      signalProcess: (pid: number, signal: NodeJS.Signals) => {
        signals.push(`${signal} ${pid}`);
      },
      waitForExit: async () => true,
      systemd,
      findOpencode: async (): Promise<OpencodeLookup> => {
        signals.push("findOpencode");
        return { kind: "not-listening" };
      },
      stopOpencode: async () => {
        signals.push("stopOpencode");
        return true;
      },
      validateOverride: async (target: string) => {
        note(target);
        guard(target, tempRoot);
        return options.validate ? options.validate(target) : validateOverrideHome(target, tempHome);
      },
      removePath: async (target: string) => {
        note(target);
        guard(target, tempRoot, false);
        return removePath(target);
      },
      removeAppHome: async (home: string) => {
        note(home);
        guard(home, tempRoot);
        return removeAppHomeData(home);
      },
      removeKeychain: () => removeKeychainAccounts(store),
      resolveLogsDir: async () => path.join(tempRoot, "canonical-logs"),
    };
  }

  function expectNothingRealTouched(): void {
    // Not vacuous: the run asked about at least one path.
    expect(touched.length).toBeGreaterThan(0);
    // stopOpencode is false in every run here: the OpenCode server is never looked up or stopped.
    expect(signals).not.toContain("findOpencode");
    expect(signals).not.toContain("stopOpencode");
    for (const target of touched) {
      expect(isUnder(path.resolve(target), tempRoot), target).toBe(true);
      expect(isUnder(path.resolve(target), REAL_HOME), target).toBe(false);
    }
    for (const line of lines) {
      for (const realApp of REAL_APP_HOME_NAMES) {
        expect(line).not.toContain(realApp);
      }
    }
    for (const text of [...lines, ...prompts]) {
      expect(text).not.toContain(SENTINEL);
    }
    expect(signals.filter((entry) => /^SIG/.test(entry))).toEqual([]);
  }

  it("removes a full home, keeps logs and notes, leaves an outside link target, then is idempotent", async () => {
    const resolvedHomes = resolveUninstallHomes({});
    const home = resolvedHomes.defaultHome;
    expect(isUnder(home, tempRoot)).toBe(true);
    expect(resolvedHomes.overrideHome).toBeNull();
    await populateHome(home);
    const outsideTarget = path.join(outside, "secrets-target.enc");
    await fs.writeFile(outsideTarget, "encrypted");
    if (!isWindows) {
      await fs.rm(path.join(home, "secrets.enc"));
      await fs.symlink(outsideTarget, path.join(home, "secrets.enc"));
    }

    const listed = await listAppHomeTargets(home);
    expect(listed.map((target) => path.basename(target)).sort()).toEqual(
      [...STORED_APP_HOME_ENTRIES.map((entry) => entry.name), ...TEMP_SIBLINGS].sort(),
    );
    for (const sibling of TEMP_SIBLINGS) {
      expect(STORED_TEMP_SIBLING_PATTERNS.some((pattern) => pattern.test(sibling))).toBe(true);
    }

    const code = await runUninstall(YES, createDeps({}));

    expect(code).toBe(0);
    expect(prompts).toEqual([]);
    expect(stopDaemonCalls).toBe(1);
    expect(lines).toContain(tEn("uninstall.step_daemon_stopped", { pid: FAKE_DAEMON_PID }));
    for (const target of listed) {
      expect(await exists(target), target).toBe(false);
      expect(
        lines.some((line) => line.includes(target)),
        target,
      ).toBe(true);
    }
    for (const name of PRESERVED_APP_HOME_ENTRIES) {
      expect(await exists(path.join(home, name)), name).toBe(true);
    }
    expect(await exists(path.join(home, "notes.txt"))).toBe(true);
    expect(await exists(path.join(home, "logs", "opencode-telegram-bot-2026-11-12.log"))).toBe(
      true,
    );
    expect(secrets.size).toBe(0);
    expect(lines).toContain(tEn("uninstall.plan_keychain", { service: KEYCHAIN_SERVICE }));
    expect(lines.at(-1)).toBe(tEn("uninstall.cli_hint", { command: CLI_COMMAND }));
    if (isWindows) {
      expect(lines).toContain(tEn("uninstall.summary_ok"));
      expect(lines.filter(isTargetLeftLine)).toEqual([]);
    } else {
      expect(await exists(outsideTarget)).toBe(true);
      expect(await exists(path.join(home, "secrets.enc"))).toBe(false);
      const realTarget = await fs.realpath(outsideTarget);
      expect(lines.filter(isTargetLeftLine)).toEqual([
        tEn("uninstall.step_target_left", { path: realTarget }),
      ]);
      expect(lines).toContain(tEn("uninstall.summary_left", { items: realTarget }));
    }
    expectNothingRealTouched();

    // Second run: everything is already gone.
    lines.length = 0;
    prompts.length = 0;
    stopDaemonCalls = 0;
    const secondCode = await runUninstall(YES, createDeps({}));

    expect(secondCode).toBe(0);
    expect(stopDaemonCalls).toBe(0);
    expect(lines.filter(isTargetLeftLine)).toEqual([]);
    expect(lines).toContain(tEn("uninstall.step_daemon_absent"));
    expect(lines).toContain(tEn("uninstall.summary_ok"));
    // removeAppHomeData acts only on entries that exist (listAppHomeTargets lstats each one), so
    // an inventory entry that is already gone produces no per-target line at all: no removal, no
    // "Already absent" line (that one is printed only for a missing home, see the next test).
    for (const name of INVENTORY_NAMES) {
      expect(
        lines.some((line) => line.includes(path.join(home, name))),
        name,
      ).toBe(false);
    }
    expect(lines.some((line) => line.startsWith("Removed "))).toBe(false);
    expect(lines).not.toContain(tEn("uninstall.step_absent", { path: home }));
    expect(lines).toContain(tEn("uninstall.home_kept_logs", { path: home }));
    expect(await exists(path.join(home, "notes.txt"))).toBe(true);
    expectNothingRealTouched();
  });

  it.skipIf(isWindows)(
    "reports 'left in place' only for an existing target outside the home",
    async () => {
      const home = resolveUninstallHomes({}).defaultHome;
      await populateHome(home);
      // Inside the home (removed in the same run) and dangling outside targets: not reported.
      await fs.rm(path.join(home, ".env"));
      await fs.symlink(path.join(home, "settings.json"), path.join(home, ".env"));
      await fs.rm(path.join(home, "secrets.enc"));
      await fs.symlink(path.join(outside, "missing.enc"), path.join(home, "secrets.enc"));

      const code = await runUninstall(YES, createDeps({}));

      expect(code).toBe(0);
      expect(await exists(path.join(home, ".env"))).toBe(false);
      expect(await exists(path.join(home, "secrets.enc"))).toBe(false);
      expect(lines.filter(isTargetLeftLine)).toEqual([]);
      expect(lines).toContain(tEn("uninstall.summary_ok"));
      expectNothingRealTouched();
    },
  );

  it("reports a missing default home as already absent and exits 0", async () => {
    const home = resolveUninstallHomes({}).defaultHome;
    expect(await exists(home)).toBe(false);

    const code = await runUninstall(YES, createDeps({}));

    expect(code).toBe(0);
    expect(lines).toContain(tEn("uninstall.step_absent", { path: home }));
    expect(await exists(home)).toBe(false);
    expectNothingRealTouched();
  });

  it("derives the daemon from the state file in the home and stops that pid via the fake", async () => {
    const home = resolveUninstallHomes({}).defaultHome;
    await populateHome(home);
    const statePid = FAKE_DAEMON_PID + 1;
    await fs.writeFile(
      path.join(home, "run", "bot-service.json"),
      JSON.stringify({ pid: statePid, startedAt: "2026-11-12T00:00:00.000Z" }),
    );

    const code = await runUninstall(YES, createDeps({}, { statusFromStateFileIn: home }));

    expect(code).toBe(0);
    expect(lines).toContain(tEn("uninstall.plan_daemon", { pid: statePid }));
    expect(lines).toContain(tEn("uninstall.step_daemon_stopped", { pid: statePid }));
    expect(stopDaemonCalls).toBe(1);
    expect(await exists(path.join(home, "run"))).toBe(false);
    expectNothingRealTouched();
  });

  describe("override home", () => {
    let overrideHome: string;

    beforeEach(async () => {
      overrideHome = path.join(tempRoot, "override-home");
    });

    // Names that look like bot files but are not markers (.env, settings.json,
    // run/bot-service.json), plus the two secret files.
    async function writeDecoys(home: string): Promise<void> {
      await fs.mkdir(home, { recursive: true });
      for (const name of [...SECRET_FILES, ".env.bak", "settings.json.bak", "notes.txt"]) {
        await fs.writeFile(path.join(home, name), "decoy");
      }
    }

    async function expectDecoysUntouched(home: string): Promise<void> {
      for (const name of [...SECRET_FILES, ".env.bak", "settings.json.bak", "notes.txt"]) {
        expect(await exists(path.join(home, name)), name).toBe(true);
      }
    }

    it("removes the whole inventory only after the scripted yes", async () => {
      await populateHome(overrideHome);
      const presentAtPrompt: boolean[] = [];
      answers.push("y");
      const deps = createDeps(
        { OPENCODE_TELEGRAM_HOME: overrideHome },
        {
          onAsk: async () => {
            for (const name of INVENTORY_NAMES) {
              presentAtPrompt.push(await exists(path.join(overrideHome, name)));
            }
          },
        },
      );

      const code = await runUninstall(YES, deps);

      expect(code).toBe(0);
      expect(prompts).toEqual([tEn("uninstall.confirm_override", { path: overrideHome })]);
      expect(presentAtPrompt).toEqual(INVENTORY_NAMES.map(() => true));
      for (const name of INVENTORY_NAMES) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(false);
      }
      expect(await exists(path.join(overrideHome, "logs"))).toBe(true);
      expect(await exists(path.join(overrideHome, "notes.txt"))).toBe(true);
      expect(secrets.size).toBe(0);
      expectNothingRealTouched();
    });

    it("keeps the other files on a scripted no, removes the secret files by name and the keychain", async () => {
      await populateHome(overrideHome);
      answers.push("n");

      const code = await runUninstall(YES, createDeps({ OPENCODE_TELEGRAM_HOME: overrideHome }));

      expect(code).toBe(0);
      for (const name of INVENTORY_NAMES.filter((entry) => !SECRET_FILES.includes(entry))) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(true);
      }
      for (const name of SECRET_FILES) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(false);
      }
      expect(await exists(path.join(overrideHome, "notes.txt"))).toBe(true);
      expect(lines).toContain(tEn("uninstall.step_override_skipped", { path: overrideHome }));
      expect(lines).toContain(tEn("uninstall.step_override_secrets", { path: overrideHome }));
      // The keychain step runs regardless of the answer.
      expect(secrets.size).toBe(0);
      expect(lines).toContain(tEn("uninstall.plan_keychain", { service: KEYCHAIN_SERVICE }));
      expectNothingRealTouched();
    });

    it("leaves an override without marker files untouched, asks nothing, and says why", async () => {
      await writeDecoys(overrideHome);

      const code = await runUninstall(YES, createDeps({ OPENCODE_TELEGRAM_HOME: overrideHome }));

      expect(code).toBe(0);
      expect(prompts).toEqual([]);
      await expectDecoysUntouched(overrideHome);
      expect(lines).toContain(
        tEn("uninstall.step_override_invalid", {
          path: overrideHome,
          reason: tEn("uninstall.override_reason_no_bot_files"),
        }),
      );
      expect(secrets.size).toBe(0);
      expectNothingRealTouched();
    });

    for (const [reason, key] of [
      ["root", "uninstall.override_reason_root"],
      ["user-home", "uninstall.override_reason_user_home"],
    ] as const) {
      // The reason is injected: the real filesystem root and the real user home are never used.
      it(`skips an override reported as ${reason} and touches nothing in it`, async () => {
        await populateHome(overrideHome);
        const validate = vi.fn(async () => ({ ok: false as const, reason }));

        const code = await runUninstall(
          YES,
          createDeps({ OPENCODE_TELEGRAM_HOME: overrideHome }, { validate }),
        );

        expect(code).toBe(0);
        expect(validate).toHaveBeenCalled();
        expect(prompts).toEqual([]);
        for (const name of INVENTORY_NAMES) {
          expect(await exists(path.join(overrideHome, name)), name).toBe(true);
        }
        expect(lines).toContain(
          tEn("uninstall.step_override_invalid", { path: overrideHome, reason: tEn(key) }),
        );
        expectNothingRealTouched();
      });
    }

    it("skips a missing override and never creates it", async () => {
      const code = await runUninstall(YES, createDeps({ OPENCODE_TELEGRAM_HOME: overrideHome }));

      expect(code).toBe(0);
      expect(prompts).toEqual([]);
      expect(await exists(overrideHome)).toBe(false);
      expect(lines).toContain(
        tEn("uninstall.step_override_invalid", {
          path: overrideHome,
          reason: tEn("uninstall.override_reason_missing"),
        }),
      );
      expectNothingRealTouched();
    });
  });

  describe("translator", () => {
    it("prints German text for a German locale and never the sentinel", async () => {
      const home = resolveUninstallHomes({}).defaultHome;
      await populateHome(home);

      const code = await runUninstall(YES, createDeps({ BOT_LOCALE: "de" }));

      expect(code).toBe(0);
      expect(lines[0]).toBe(de["uninstall.plan_header"]);
      expect(lines[0]).not.toBe(en["uninstall.plan_header"]);
      expect(lines).toContain(tDe("uninstall.summary_ok"));
      expect(tDe("uninstall.summary_ok")).not.toBe(tEn("uninstall.summary_ok"));
      expect(lines.at(-1)).toBe(tDe("uninstall.cli_hint", { command: CLI_COMMAND }));
      expect(lines).not.toContain(tEn("uninstall.summary_ok"));
      expect(lines).not.toContain(en["uninstall.plan_header"]);
      expectNothingRealTouched();
    });
  });
});
