import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { de } from "../../../src/i18n/de.js";
import { en, type I18nDictionary } from "../../../src/i18n/en.js";
import type {
  BotServiceStatus,
  ServiceOperationResult,
} from "../../../src/runtime/service/types.js";
import { KEYCHAIN_SERVICE, STORED_KEYCHAIN_ACCOUNTS } from "../../../src/runtime/stored-data.js";
import { removeKeychainAccounts } from "../../../src/runtime/uninstall/keychain.js";
import type { KeychainRemovalStore } from "../../../src/runtime/uninstall/keychain.js";
import { createUninstallTranslator } from "../../../src/runtime/uninstall/messages.js";
import type { OpencodeServer } from "../../../src/runtime/uninstall/opencode-server.js";
import type { BotProcess } from "../../../src/runtime/uninstall/processes.js";
import { readBotServiceStatus } from "../../../src/runtime/service/manager.js";
import { validateOverrideHome } from "../../../src/runtime/uninstall/homes.js";
import { removeAppHomeData, removePath } from "../../../src/runtime/uninstall/remove-path.js";
import { assertInsideTempRoot } from "./temp-root-guard.js";
import {
  reasonCode,
  runUninstall,
  type UninstallDeps,
  type UninstallOptions,
} from "../../../src/runtime/uninstall/run.js";
import {
  SYSTEMD_COMMANDS,
  SYSTEMD_UNIT_PATH,
  formatSystemdCommand,
  type SystemdDeps,
} from "../../../src/runtime/uninstall/systemd.js";

const isWindows = process.platform === "win32";
const SENTINEL = "SECRET-SENTINEL";
const DAEMON_PID = 4242;
const OWN_PID = 9100;
const OWN_PPID = 9099;
const TEMP_SIBLING = ".env.123.0123abcd-0123-4567-89ab-0123456789ab.tmp";
const CLI_COMMAND = "npm uninstall -g @grinev/opencode-telegram-bot";
const YES: UninstallOptions = { yes: true, stopOpencode: false };
const NO_YES: UninstallOptions = { yes: false, stopOpencode: false };
const tEn = createUninstallTranslator(undefined);

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Creates every inventory entry, a temp sibling, logs/, and an unknown file in a home. */
async function populateHome(home: string, envContent = "TELEGRAM_BOT_TOKEN=abc\n"): Promise<void> {
  await fs.mkdir(path.join(home, "run"), { recursive: true });
  await fs.mkdir(path.join(home, "local-commands"), { recursive: true });
  await fs.mkdir(path.join(home, "logs"), { recursive: true });
  await fs.writeFile(path.join(home, ".env"), envContent);
  await fs.writeFile(path.join(home, ".env.bak"), envContent);
  await fs.writeFile(path.join(home, "settings.json"), "{}");
  await fs.writeFile(path.join(home, "settings.json.bak"), "{}");
  await fs.writeFile(path.join(home, "settings.json.tmp"), "{}");
  await fs.writeFile(path.join(home, "secrets.enc"), "encrypted");
  await fs.writeFile(path.join(home, "keystore_password"), "pw");
  await fs.writeFile(path.join(home, "run", "bot-service.json"), "{}");
  await fs.writeFile(path.join(home, "local-commands", "hello.json"), "{}");
  await fs.writeFile(path.join(home, TEMP_SIBLING), "partial");
  await fs.writeFile(path.join(home, "logs", "opencode-telegram-bot-2026-11-12.log"), "log");
}

const INVENTORY = [
  ".env",
  ".env.bak",
  "settings.json",
  "settings.json.bak",
  "settings.json.tmp",
  "secrets.enc",
  "keystore_password",
  "run",
  "local-commands",
  TEMP_SIBLING,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every written chunk must be the rendering of one uninstall template of the dictionary. */
function expectAllTranslated(lines: readonly string[], dictionary: I18nDictionary): void {
  const patterns = Object.entries(dictionary)
    .filter(([key]) => key.startsWith("uninstall."))
    .map(([, template]) => {
      const parts = (template as string).split(/\{[a-zA-Z0-9_]+\}/);
      return new RegExp(`^${parts.map(escapeRegExp).join("[\\s\\S]*?")}$`);
    });

  for (const line of lines) {
    expect(
      patterns.some((pattern) => pattern.test(line)),
      `not produced by a template: ${line}`,
    ).toBe(true);
  }
}

function runningStatus(pid: number): BotServiceStatus {
  return {
    status: "running",
    service: { pid, startedAt: "2026-11-12T00:00:00.000Z", logFilePath: "/x.log", mode: "daemon" },
    cleanupReason: null,
  };
}

const STOPPED_STATUS: BotServiceStatus = { status: "stopped", service: null, cleanupReason: null };

function botProcess(pid: number, commandLine = `node /opt/bot/dist/cli.js start`): BotProcess {
  return { pid, user: "dev", startedAt: "Thu Nov 12 10:00:00 2026", commandLine, verified: true };
}

/**
 * Wraps every dependency that reaches the filesystem so that a path outside the test's temp root
 * fails the test before anything is touched. The wrappers are mocks, so call assertions still work.
 */
// The run catches step errors, so a guard throw alone could be swallowed: every violation is also
// recorded here and afterEach fails the test when the list is not empty.
const guardViolations: string[] = [];

function guard(target: string, root: string): void {
  try {
    assertInsideTempRoot(target, root);
  } catch (error) {
    guardViolations.push(target);
    throw error;
  }
}

function guardFilesystemDeps(deps: UninstallDeps, root: string): UninstallDeps {
  const { getHomes, validateOverride, removePath: remove, removeAppHome, getDaemonStatus } = deps;
  return {
    ...deps,
    getHomes: vi.fn(() => {
      const homes = getHomes();
      guard(homes.defaultHome, root);
      if (homes.overrideHome !== null) {
        guard(homes.overrideHome, root);
      }
      return homes;
    }),
    getDaemonStatus: vi.fn(() => getDaemonStatus()),
    validateOverride: vi.fn(async (target: string) => {
      guard(target, root);
      return validateOverride(target);
    }),
    removePath: vi.fn(async (target: string) => {
      guard(target, root);
      return remove(target);
    }),
    removeAppHome: vi.fn(async (home: string) => {
      guard(home, root);
      return removeAppHome(home);
    }),
  };
}

interface Harness {
  deps: UninstallDeps;
  lines: string[];
  prompts: string[];
  answers: (string | null)[];
  secrets: Map<string, string>;
  events: string[];
}

describe("runtime/uninstall/run", () => {
  let tempRoot: string;
  let defaultHome: string;
  let outside: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-run-"));
    defaultHome = path.join(tempRoot, "default-home");
    outside = path.join(tempRoot, "outside");
    await fs.mkdir(defaultHome, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
    const violations = guardViolations.splice(0);
    expect(violations, "a fake was asked to touch a path outside the temp root").toEqual([]);
  });

  function createHarness(overrides: Partial<UninstallDeps> = {}): Harness {
    const lines: string[] = [];
    const prompts: string[] = [];
    const answers: (string | null)[] = [];
    const events: string[] = [];
    const secrets = new Map<string, string>(
      STORED_KEYCHAIN_ACCOUNTS.map((account) => [account, SENTINEL]),
    );
    const store: KeychainRemovalStore = {
      isAvailable: async () => true,
      removeSecret: async (account) => (secrets.delete(account) ? "removed" : "absent"),
    };
    const systemd: SystemdDeps = {
      platform: "linux",
      unitExists: async () => false,
      hasSudo: async () => true,
      isInteractive: true,
      run: vi.fn(async () => 0),
    };
    let daemonStatus: BotServiceStatus = runningStatus(DAEMON_PID);

    const base: UninstallDeps = {
      env: {},
      platform: "linux",
      isContainer: vi.fn(() => false),
      getUid: vi.fn(() => 1000),
      isInteractive: true,
      ask: vi.fn(async (question: string) => {
        prompts.push(question);
        return answers.length > 0 ? (answers.shift() ?? null) : null;
      }),
      write: vi.fn((line: string) => {
        lines.push(line);
      }),
      getHomes: () => ({ defaultHome, overrideHome: null }),
      getDaemonStatus: vi.fn(async () => daemonStatus),
      getOwnPidChain: vi.fn(async () => [OWN_PID, OWN_PPID]),
      findSystemdMainPid: vi.fn(async () => null),
      stopDaemon: vi.fn(async (): Promise<ServiceOperationResult> => {
        const service = daemonStatus.service;
        daemonStatus = STOPPED_STATUS;
        return service
          ? { success: true, service, cleanupReason: null }
          : { success: true, service: null, cleanupReason: null, alreadyStopped: true };
      }),
      findBotProcesses: vi.fn(async () => []),
      reverifyProcess: vi.fn(async (found: BotProcess) => {
        events.push(`reverify ${found.pid}`);
        return true;
      }),
      signalProcess: vi.fn((pid: number, signal: NodeJS.Signals) => {
        events.push(`${signal} ${pid}`);
      }),
      waitForExit: vi.fn(async (pid: number) => {
        events.push(`wait ${pid}`);
        return true;
      }),
      systemd,
      findOpencode: vi.fn(async () => null),
      stopOpencode: vi.fn(async () => true),
      validateOverride: (target: string) => validateOverrideHome(target),
      removePath: (target: string) => removePath(target),
      removeAppHome: (home: string) => removeAppHomeData(home),
      removeKeychain: vi.fn(() => removeKeychainAccounts(store)),
      resolveLogsDir: vi.fn(async () => path.join(tempRoot, "canonical-logs")),
      ...overrides,
    };
    const deps = guardFilesystemDeps(base, tempRoot);

    return { deps, lines, prompts, answers, secrets, events };
  }

  async function expectHomeUntouched(home: string): Promise<void> {
    for (const name of INVENTORY) {
      expect(await exists(path.join(home, name)), name).toBe(true);
    }
  }

  describe("refusals", () => {
    for (const options of [YES, NO_YES]) {
      it(`refuses inside a container and removes nothing (yes=${options.yes})`, async () => {
        await populateHome(defaultHome);
        const harness = createHarness({ isContainer: vi.fn(() => true) });

        const code = await runUninstall(options, harness.deps);

        expect(code).toBe(1);
        expect(harness.lines).toEqual([tEn("uninstall.refused_container")]);
        await expectHomeUntouched(defaultHome);
        expect(harness.deps.getDaemonStatus).not.toHaveBeenCalled();
        expect(harness.deps.findBotProcesses).not.toHaveBeenCalled();
        expect(harness.deps.removeAppHome).not.toHaveBeenCalled();
        expect(harness.deps.removeKeychain).not.toHaveBeenCalled();
        expect(harness.deps.ask).not.toHaveBeenCalled();
        expect(harness.secrets.size).toBe(STORED_KEYCHAIN_ACCOUNTS.length);
      });

      it(`refuses to run as root and removes nothing (yes=${options.yes})`, async () => {
        await populateHome(defaultHome);
        const harness = createHarness({ getUid: vi.fn(() => 0) });

        const code = await runUninstall(options, harness.deps);

        expect(code).toBe(1);
        expect(harness.lines).toEqual([tEn("uninstall.refused_root")]);
        await expectHomeUntouched(defaultHome);
        expect(harness.deps.getDaemonStatus).not.toHaveBeenCalled();
        expect(harness.deps.stopDaemon).not.toHaveBeenCalled();
        expect(harness.deps.removeAppHome).not.toHaveBeenCalled();
        expect(harness.deps.removeKeychain).not.toHaveBeenCalled();
      });
    }

    it("checks the container before root", async () => {
      const harness = createHarness({ isContainer: vi.fn(() => true), getUid: vi.fn(() => 0) });

      await runUninstall(YES, harness.deps);

      expect(harness.lines).toEqual([tEn("uninstall.refused_container")]);
      expect(harness.deps.getUid).not.toHaveBeenCalled();
    });
  });

  describe("full run", () => {
    it("with --yes stops the daemon, removes the inventory, keeps logs, and prints the hint", async () => {
      await populateHome(defaultHome);
      const harness = createHarness();

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.ask).not.toHaveBeenCalled();
      expect(harness.deps.stopDaemon).toHaveBeenCalledTimes(1);
      for (const name of INVENTORY) {
        expect(await exists(path.join(defaultHome, name)), name).toBe(false);
        expect(harness.lines).toContain(
          tEn("uninstall.step_removed", { path: path.join(defaultHome, name) }),
        );
      }
      expect(
        await exists(path.join(defaultHome, "logs", "opencode-telegram-bot-2026-11-12.log")),
      ).toBe(true);
      expect(harness.lines).toContain(tEn("uninstall.home_kept_logs", { path: defaultHome }));
      expect(harness.secrets.size).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.step_daemon_stopped", { pid: DAEMON_PID }));
      expect(harness.lines).toContain(
        tEn("uninstall.plan_logs_stay", { path: path.join(tempRoot, "canonical-logs") }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.plan_keychain", { service: KEYCHAIN_SERVICE }),
      );
      expect(harness.lines).toContain(tEn("uninstall.summary_ok"));
      expect(harness.lines.at(-1)).toBe(tEn("uninstall.cli_hint", { command: CLI_COMMAND }));
      expectAllTranslated(harness.lines, en);
    });

    it("prints the plan before anything is removed", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({
        removeAppHome: vi.fn(async (home: string) => {
          harness.events.push("removeAppHome");
          return removeAppHomeData(home);
        }),
      });
      harness.deps.write = vi.fn((line: string) => {
        harness.lines.push(line);
        if (line === tEn("uninstall.plan_header")) {
          harness.events.push("plan");
        }
      });

      await runUninstall(YES, harness.deps);

      expect(harness.events.indexOf("plan")).toBeLessThan(harness.events.indexOf("removeAppHome"));
      expect(harness.lines).toContain(tEn("uninstall.plan_daemon", { pid: DAEMON_PID }));
      expect(harness.lines).toContain(tEn("uninstall.plan_home", { path: defaultHome }));
    });

    it("removes the home itself when nothing is left in it", async () => {
      await fs.writeFile(path.join(defaultHome, ".env"), "X=1\n");
      const harness = createHarness();

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(await exists(defaultHome)).toBe(false);
      expect(harness.lines).toContain(tEn("uninstall.home_removed", { path: defaultHome }));
    });

    it("keeps <appHome>/logs when LOG_LOCATION=app and shows it as the log location", async () => {
      await populateHome(defaultHome);
      const appLogs = path.join(defaultHome, "logs");
      const harness = createHarness({
        env: { LOG_LOCATION: "app" },
        resolveLogsDir: vi.fn(async () => appLogs),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(await exists(path.join(appLogs, "opencode-telegram-bot-2026-11-12.log"))).toBe(true);
      expect(harness.lines).toContain(tEn("uninstall.plan_logs_stay", { path: appLogs }));
      expect(harness.lines).toContain(tEn("uninstall.home_kept_logs", { path: defaultHome }));
    });

    it("keeps a home with other files without claiming logs stay", async () => {
      await fs.writeFile(path.join(defaultHome, ".env"), "X=1\n");
      await fs.writeFile(path.join(defaultHome, "notes.txt"), "mine");
      const harness = createHarness();

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(await exists(path.join(defaultHome, "notes.txt"))).toBe(true);
      expect(harness.lines).toContain(tEn("uninstall.home_kept", { path: defaultHome }));
    });

    it("prints an absent line for a missing default home and never creates it", async () => {
      await fs.rm(defaultHome, { recursive: true });
      const harness = createHarness();

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(await exists(defaultHome)).toBe(false);
      expect(harness.lines).toContain(tEn("uninstall.step_absent", { path: defaultHome }));
    });

    it("prints one fixed translated line for log-location warnings, never their text", async () => {
      const harness = createHarness({
        resolveLogsDir: vi.fn(async (warn: (message: string) => void) => {
          warn(`LOG_LOCATION is invalid: ${SENTINEL}\n`);
          warn(`cannot read .env: ${SENTINEL}\n`);
          return path.join(tempRoot, "canonical-logs");
        }),
      });

      await runUninstall(YES, harness.deps);

      expect(
        harness.lines.filter((line) => line === tEn("uninstall.step_logs_warning")),
      ).toHaveLength(1);
      expect(harness.lines.join("\n")).not.toContain(SENTINEL);
    });

    it("refuses first in a container even when the app home lookup throws", async () => {
      const harness = createHarness({
        isContainer: vi.fn(() => true),
        getHomes: () => {
          throw new Error("os.homedir failed");
        },
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toEqual([tEn("uninstall.refused_container")]);
    });

    it("stops with a message when the app home lookup throws outside a container", async () => {
      const harness = createHarness({
        getHomes: () => {
          throw new Error("os.homedir failed");
        },
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toEqual([tEn("uninstall.step_homes_error", { reason: "ERROR" })]);
      expect(harness.deps.getDaemonStatus).not.toHaveBeenCalled();
      expect(harness.deps.removeKeychain).not.toHaveBeenCalled();
    });

    it("never consults the real home when given a complete deps object", async () => {
      await populateHome(defaultHome);
      const homedir = vi.spyOn(os, "homedir");
      const harness = createHarness();

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(homedir).not.toHaveBeenCalled();
      for (const call of vi.mocked(harness.deps.removeAppHome).mock.calls) {
        expect(() => assertInsideTempRoot(call[0], tempRoot)).not.toThrow();
      }
    });

    it("rejects a partial deps object at compile time", () => {
      const harness = createHarness();
      const partial: Partial<UninstallDeps> = { ...harness.deps };
      delete partial.removeKeychain;
      const start = (): Promise<number> =>
        // @ts-expect-error a missing key must never fall back to real system access
        runUninstall(YES, partial);

      expect(typeof start).toBe("function");
    });

    it("removes nothing and exits 1 when a cast deps object lacks the removal functions", async () => {
      await populateHome(defaultHome);
      const harness = createHarness();
      const partial: Partial<UninstallDeps> = { ...harness.deps };
      delete partial.removeAppHome;
      delete partial.removeKeychain;

      const code = await runUninstall(YES, partial as UninstallDeps);

      expect(code).toBe(1);
      await expectHomeUntouched(defaultHome);
      expect(harness.secrets.size).toBe(STORED_KEYCHAIN_ACCOUNTS.length);
    });

    it("fails the test instead of touching a home outside the temp root", async () => {
      // Inert fakes: the real destructive functions are never reachable with these paths, even
      // if the guard regressed.
      const inertRemoveAppHome = vi.fn(async () => ({ results: [], homeRemoved: false }));
      const inertRemovePath = vi.fn(async (target: string) => ({
        path: target,
        status: "absent" as const,
      }));
      const harness = createHarness({
        getHomes: () => ({ defaultHome: os.userInfo().homedir, overrideHome: null }),
        removeAppHome: inertRemoveAppHome,
        removePath: inertRemovePath,
      });

      expect(() => harness.deps.getHomes()).toThrow(/outside the temp root/);
      await expect(harness.deps.removeAppHome(os.userInfo().homedir)).rejects.toThrow(
        /outside the temp root/,
      );
      await expect(harness.deps.removePath("/")).rejects.toThrow(/outside the temp root/);
      expect(inertRemoveAppHome).not.toHaveBeenCalled();
      expect(inertRemovePath).not.toHaveBeenCalled();
      expect(guardViolations).toHaveLength(3);
      // Deliberate violations: cleared so afterEach does not fail this test.
      guardViolations.length = 0;
    });

    it("resolves the logs directory before anything is removed", async () => {
      await populateHome(defaultHome);
      const order: string[] = [];
      const harness = createHarness({
        resolveLogsDir: vi.fn(async () => {
          order.push("logs");
          return path.join(tempRoot, "canonical-logs");
        }),
        removeAppHome: vi.fn(async (home: string) => {
          order.push("remove");
          return removeAppHomeData(home);
        }),
      });

      await runUninstall(YES, harness.deps);

      expect(order).toEqual(["logs", "remove"]);
    });

    it("is idempotent: a second run reports everything absent and exits 0", async () => {
      await populateHome(defaultHome);
      const harness = createHarness();
      await runUninstall(YES, harness.deps);
      harness.lines.length = 0;

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.step_daemon_absent"));
      expect(harness.lines.some((line) => line.startsWith("Removed "))).toBe(false);
      for (const account of STORED_KEYCHAIN_ACCOUNTS) {
        expect(harness.lines).toContain(
          tEn("uninstall.step_keychain", {
            account,
            status: tEn("uninstall.keychain_status_absent"),
          }),
        );
      }
      expect(harness.lines).toContain(tEn("uninstall.summary_ok"));
    });
  });

  describe("main confirmation", () => {
    const declines: [string, string | null][] = [
      ["n", "n"],
      ["empty", ""],
      ["other text", "yep"],
      ["end of input", null],
    ];

    for (const [label, answer] of declines) {
      it(`treats ${label} as a decline: nothing removed, exit 1`, async () => {
        await populateHome(defaultHome);
        const harness = createHarness();
        harness.answers.push(answer);

        const code = await runUninstall(NO_YES, harness.deps);

        expect(code).toBe(1);
        expect(harness.prompts).toEqual([tEn("uninstall.confirm_plan")]);
        expect(harness.lines.at(-1)).toBe(tEn("uninstall.aborted"));
        await expectHomeUntouched(defaultHome);
        expect(harness.deps.stopDaemon).not.toHaveBeenCalled();
        expect(harness.deps.removeAppHome).not.toHaveBeenCalled();
        expect(harness.deps.removeKeychain).not.toHaveBeenCalled();
        expect(harness.secrets.size).toBe(STORED_KEYCHAIN_ACCOUNTS.length);
      });
    }

    for (const answer of ["y", "Y", "yes", " YES "]) {
      it(`accepts ${JSON.stringify(answer)} as yes`, async () => {
        await populateHome(defaultHome);
        const harness = createHarness();
        harness.answers.push(answer);

        const code = await runUninstall(NO_YES, harness.deps);

        expect(code).toBe(0);
        expect(await exists(path.join(defaultHome, ".env"))).toBe(false);
      });
    }

    it("without a terminal and without --yes prints the plan only and exits 1", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({ isInteractive: false });

      const code = await runUninstall(NO_YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(tEn("uninstall.plan_header"));
      expect(harness.lines.at(-1)).toBe(tEn("uninstall.no_terminal_plan_only"));
      expect(harness.deps.ask).not.toHaveBeenCalled();
      await expectHomeUntouched(defaultHome);
      expect(harness.deps.stopDaemon).not.toHaveBeenCalled();
      expect(harness.deps.removeKeychain).not.toHaveBeenCalled();
    });

    for (const [label, answer, interactive] of [
      ["a decline", "n", true],
      ["end of input", null, true],
      ["no terminal", null, false],
    ] as const) {
      it(`leaves a stale daemon state file in place after ${label}`, async () => {
        await populateHome(defaultHome);
        const stateFile = path.join(defaultHome, "run", "bot-service.json");
        // No real pid is probed: the liveness check sees a process that is gone.
        const kill = vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        });
        const stale = JSON.stringify({
          pid: 424242,
          startedAt: new Date().toISOString(),
          logFilePath: "/x.log",
          mode: "daemon",
        });
        await fs.writeFile(stateFile, stale);
        const harness = createHarness({
          isInteractive: interactive,
          getDaemonStatus: () => readBotServiceStatus(stateFile),
        });
        harness.answers.push(answer);

        const code = await runUninstall(NO_YES, harness.deps);

        expect(code).toBe(1);
        expect(kill).toHaveBeenCalledWith(424242, 0);
        await expect(fs.readFile(stateFile, "utf-8")).resolves.toBe(stale);
      });
    }

    it("leaves an invalid daemon state file in place after a decline", async () => {
      await populateHome(defaultHome);
      const stateFile = path.join(defaultHome, "run", "bot-service.json");
      await fs.writeFile(stateFile, "{not json");
      const harness = createHarness({ getDaemonStatus: () => readBotServiceStatus(stateFile) });
      harness.answers.push("n");

      await runUninstall(NO_YES, harness.deps);

      await expect(fs.readFile(stateFile, "utf-8")).resolves.toBe("{not json");
    });
  });

  describe("bot processes", () => {
    it("also excludes the systemd main pid from the process scan", async () => {
      const harness = createHarness({ findSystemdMainPid: vi.fn(async () => 3333) });

      await runUninstall(YES, harness.deps);

      expect(harness.deps.findBotProcesses).toHaveBeenCalledWith([DAEMON_PID, 3333]);
    });

    it("passes the daemon pid as an exclusion to the process scan", async () => {
      const harness = createHarness();

      await runUninstall(YES, harness.deps);

      expect(harness.deps.findBotProcesses).toHaveBeenCalledWith([DAEMON_PID]);
    });

    it("passes no exclusion when no daemon is running", async () => {
      const harness = createHarness({ getDaemonStatus: vi.fn(async () => STOPPED_STATUS) });

      await runUninstall(YES, harness.deps);

      expect(harness.deps.findBotProcesses).toHaveBeenCalledWith([]);
    });

    it("asks for each process separately even with --yes and stops only the confirmed one", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001), botProcess(5002)]),
      });
      harness.answers.push("y", "n");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.prompts).toEqual([
        tEn("uninstall.confirm_stop_process", {
          pid: 5001,
          user: "dev",
          started: "Thu Nov 12 10:00:00 2026",
          command: "node /opt/bot/dist/cli.js start",
        }),
        tEn("uninstall.confirm_stop_process", {
          pid: 5002,
          user: "dev",
          started: "Thu Nov 12 10:00:00 2026",
          command: "node /opt/bot/dist/cli.js start",
        }),
      ]);
      expect(harness.events).toEqual(["reverify 5001", "SIGTERM 5001", "wait 5001"]);
      expect(harness.lines).toContain(tEn("uninstall.plan_terminal_bots"));
      expect(harness.lines).toContain(tEn("uninstall.step_process_stopped", { pid: 5001 }));
      expect(harness.lines).toContain(tEn("uninstall.step_process_skipped", { pid: 5002 }));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_left", { items: tEn("uninstall.left_process", { pid: 5002 }) }),
      );
      expectAllTranslated(harness.lines, en);
    });

    it("reverifies before SIGTERM and again before SIGKILL", async () => {
      let waits = 0;
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
      });
      harness.deps.waitForExit = vi.fn(async (pid: number) => {
        harness.events.push(`wait ${pid}`);
        waits += 1;
        return waits > 1;
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.events).toEqual([
        "reverify 5001",
        "SIGTERM 5001",
        "wait 5001",
        "reverify 5001",
        "SIGKILL 5001",
        "wait 5001",
      ]);
    });

    it("never signals a pid that no longer matches; it is left, not a failure", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        reverifyProcess: vi.fn(async () => false),
        waitForExit: vi.fn(async () => false),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.signalProcess).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_process_refused", { pid: 5001 }));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_left", { items: tEn("uninstall.left_process", { pid: 5001 }) }),
      );
    });

    it("reports a process that exited before any signal as already exited, not stopped", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        reverifyProcess: vi.fn(async () => false),
        waitForExit: vi.fn(async () => true),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.signalProcess).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_process_already_exited", { pid: 5001 }));
      expect(harness.lines).not.toContain(tEn("uninstall.step_process_stopped", { pid: 5001 }));
      expect(harness.lines).toContain(tEn("uninstall.summary_ok"));
    });

    it("reports a process that is already gone (ESRCH on SIGTERM) as already exited", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        signalProcess: vi.fn(() => {
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        }),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.step_process_already_exited", { pid: 5001 }));
    });

    it("reports ESRCH on SIGKILL after a SIGTERM as stopped", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        waitForExit: vi.fn(async () => false),
        signalProcess: vi.fn((_pid: number, signal: NodeJS.Signals) => {
          if (signal === "SIGKILL") {
            throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
          }
        }),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.step_process_stopped", { pid: 5001 }));
    });

    it("reports a signal error other than ESRCH as a failure", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        signalProcess: vi.fn(() => {
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        }),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(tEn("uninstall.step_process_failed", { pid: 5001 }));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_failed_left", {
          count: 1,
          items: tEn("uninstall.left_process", { pid: 5001 }),
        }),
      );
    });

    it("refuses SIGKILL when the process changed after SIGTERM", async () => {
      let verifications = 0;
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        reverifyProcess: vi.fn(async () => {
          verifications += 1;
          return verifications === 1;
        }),
        waitForExit: vi.fn(async () => false),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.signalProcess).toHaveBeenCalledTimes(1);
      expect(harness.deps.signalProcess).toHaveBeenCalledWith(5001, "SIGTERM");
      expect(harness.lines).toContain(tEn("uninstall.step_process_refused", { pid: 5001 }));
    });

    it("reports a process that does not exit after SIGKILL as failed", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        waitForExit: vi.fn(async () => false),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(tEn("uninstall.step_process_failed", { pid: 5001 }));
    });

    it("skips every process without a terminal and lists them as left", async () => {
      const harness = createHarness({
        isInteractive: false,
        findBotProcesses: vi.fn(async () => [botProcess(5001), botProcess(5002)]),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.ask).not.toHaveBeenCalled();
      expect(harness.deps.signalProcess).not.toHaveBeenCalled();
      expect(harness.lines).toContain(
        tEn("uninstall.step_process_skipped_no_terminal", { pid: 5001 }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_process_skipped_no_terminal", { pid: 5002 }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.summary_left", {
          items: [
            tEn("uninstall.left_process", { pid: 5001 }),
            tEn("uninstall.left_process", { pid: 5002 }),
          ].join(", "),
        }),
      );
    });

    it("redacts the command line and shows an unknown start time and an unverified match", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [
          {
            pid: 5001,
            user: "dev",
            startedAt: null,
            commandLine: `node dist/cli.js start --token ${SENTINEL}`,
            verified: false,
          },
        ]),
      });
      harness.answers.push("n");

      await runUninstall(YES, harness.deps);

      expect(harness.lines).toContain(tEn("uninstall.process_unverified", { pid: 5001 }));
      expect(harness.prompts).toEqual([
        tEn("uninstall.confirm_stop_process", {
          pid: 5001,
          user: "dev",
          started: tEn("uninstall.started_unknown"),
          command: "node dist/cli.js start *** ***",
        }),
      ]);
    });

    it("skips the scan step on a scan failure, lists it as left, and exits 0", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => {
          throw new Error("ps exploded");
        }),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.step_scan_failed", { reason: "ERROR" }));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_left", { items: tEn("uninstall.left_scan") }),
      );
      expect(await exists(path.join(defaultHome, ".env"))).toBe(false);
      expect(harness.secrets.size).toBe(0);
    });

    it("skips the scan on Windows with a message", async () => {
      const harness = createHarness({ platform: "win32" });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.findBotProcesses).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_scan_unsupported"));
    });
  });

  describe("daemon", () => {
    it("reports a failed daemon stop and exits 1 while the other steps run", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({
        stopDaemon: vi.fn(async () => ({
          success: false,
          service: runningStatus(DAEMON_PID).service,
          cleanupReason: null,
          error: "still alive",
        })),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(tEn("uninstall.step_daemon_failed", { pid: DAEMON_PID }));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_failed_left", { count: 1, items: tEn("uninstall.left_daemon") }),
      );
      expect(await exists(path.join(defaultHome, ".env"))).toBe(false);
      expect(harness.secrets.size).toBe(0);
    });

    it("reports a daemon status error, still runs the other steps, and exits 1", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({
        getDaemonStatus: vi.fn(async () => {
          throw new Error("EACCES: state file");
        }),
        stopDaemon: vi.fn(async () => {
          throw new Error("EACCES: state file");
        }),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.deps.findBotProcesses).toHaveBeenCalledWith([]);
      expect(harness.lines).toContain(tEn("uninstall.step_daemon_error", { reason: "ERROR" }));
      expect(await exists(path.join(defaultHome, ".env"))).toBe(false);
    });
  });

  describe("systemd", () => {
    it("prints the exact commands when the step is skipped without a terminal", async () => {
      const harness = createHarness({
        isInteractive: false,
        systemd: {
          platform: "linux",
          unitExists: async () => true,
          hasSudo: async () => true,
          isInteractive: false,
          run: vi.fn(async () => 0),
        },
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.plan_systemd", { path: SYSTEMD_UNIT_PATH }));
      expect(harness.lines).toContain(
        tEn("uninstall.step_systemd", {
          outcome: tEn("uninstall.systemd_outcome_skipped_no_terminal"),
        }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_systemd_commands", {
          commands: SYSTEMD_COMMANDS.map(formatSystemdCommand).join("\n"),
        }),
      );
      expect(harness.lines).toContain(tEn("uninstall.summary_left", { items: SYSTEMD_UNIT_PATH }));
    });

    it("runs the removal and reports it", async () => {
      const run = vi.fn(async () => 0);
      const harness = createHarness({
        systemd: {
          platform: "linux",
          unitExists: async () => true,
          hasSudo: async () => true,
          isInteractive: true,
          run,
        },
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(run).toHaveBeenCalledTimes(SYSTEMD_COMMANDS.length);
      expect(harness.lines).toContain(
        tEn("uninstall.step_systemd", { outcome: tEn("uninstall.systemd_outcome_removed") }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_systemd_ran", {
          path: SYSTEMD_UNIT_PATH,
          commands: SYSTEMD_COMMANDS.map(formatSystemdCommand).join("\n"),
        }),
      );
    });

    it("turns a throwing unit check into a failed step and keeps going", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({
        systemd: {
          platform: "linux",
          unitExists: async () => {
            throw new Error("EACCES: unit");
          },
          hasSudo: async () => true,
          isInteractive: true,
          run: vi.fn(async () => 0),
        },
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(tEn("uninstall.step_systemd_failed", { reason: "ERROR" }));
      expect(await exists(path.join(defaultHome, ".env"))).toBe(false);
    });
  });

  describe("--stop-opencode", () => {
    const server: OpencodeServer = {
      pid: 7001,
      port: 4096,
      commandLine: "opencode serve --port 4096",
    };

    it("never looks up the server without the flag", async () => {
      const harness = createHarness({ findOpencode: vi.fn(async () => server) });

      await runUninstall(YES, harness.deps);

      expect(harness.deps.findOpencode).not.toHaveBeenCalled();
      expect(harness.deps.stopOpencode).not.toHaveBeenCalled();
    });

    it("asks separately even with --yes, re-finds the server, and stops it on yes", async () => {
      const harness = createHarness({ findOpencode: vi.fn(async () => server) });
      harness.answers.push("y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(0);
      expect(harness.prompts).toEqual([
        tEn("uninstall.confirm_stop_opencode", {
          pid: 7001,
          port: 4096,
          command: "opencode serve --port 4096",
        }),
      ]);
      expect(harness.deps.findOpencode).toHaveBeenCalledTimes(2);
      expect(harness.deps.stopOpencode).toHaveBeenCalledWith(7001);
      expect(harness.lines).toContain(tEn("uninstall.plan_opencode_server"));
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_stopped", { pid: 7001 }));
    });

    it("does not stop the server on no and lists it as left", async () => {
      const harness = createHarness({ findOpencode: vi.fn(async () => server) });
      harness.answers.push("n");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.stopOpencode).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_skipped"));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_left", { items: tEn("uninstall.left_opencode", { pid: 7001 }) }),
      );
    });

    it("refuses when the fresh lookup finds a different pid", async () => {
      const findOpencode = vi
        .fn<() => Promise<OpencodeServer | null>>()
        .mockResolvedValueOnce(server)
        .mockResolvedValueOnce({ ...server, pid: 7002 });
      const harness = createHarness({ findOpencode });
      harness.answers.push("y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(1);
      expect(harness.deps.stopOpencode).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_refused", { pid: 7001 }));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_failed_left", {
          count: 1,
          items: tEn("uninstall.left_opencode", { pid: 7001 }),
        }),
      );
    });

    it("reports a listener that is gone at the fresh lookup: not a failure, not left", async () => {
      const findOpencode = vi
        .fn<() => Promise<OpencodeServer | null>>()
        .mockResolvedValueOnce(server)
        .mockResolvedValueOnce(null);
      const harness = createHarness({ findOpencode });
      harness.answers.push("y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.stopOpencode).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_gone", { pid: 7001 }));
      expect(harness.lines).not.toContain(tEn("uninstall.step_opencode_refused", { pid: 7001 }));
      expect(harness.lines).toContain(tEn("uninstall.summary_ok"));
    });

    it("shows the unavailable command line and, on Windows, the tree warning", async () => {
      const harness = createHarness({
        platform: "win32",
        findOpencode: vi.fn(async () => ({ ...server, commandLine: null })),
      });
      harness.answers.push("n");

      await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(harness.lines).toContain(tEn("uninstall.confirm_stop_opencode_tree"));
      expect(harness.prompts).toEqual([
        tEn("uninstall.confirm_stop_opencode", {
          pid: 7001,
          port: 4096,
          command: tEn("uninstall.command_unavailable"),
        }),
      ]);
    });

    it("reports a failed stop and exits 1", async () => {
      const harness = createHarness({
        findOpencode: vi.fn(async () => server),
        stopOpencode: vi.fn(async () => false),
      });
      harness.answers.push("y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_failed", { pid: 7001 }));
    });

    it("reports no server found", async () => {
      const harness = createHarness();

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_none"));
      expect(harness.deps.ask).not.toHaveBeenCalled();
    });

    it("skips the server without a terminal", async () => {
      const harness = createHarness({
        isInteractive: false,
        findOpencode: vi.fn(async () => server),
      });

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.ask).not.toHaveBeenCalled();
      expect(harness.deps.stopOpencode).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_skipped_no_terminal"));
    });

    it("refuses when the same pid now has a different command line", async () => {
      const findOpencode = vi
        .fn<() => Promise<OpencodeServer | null>>()
        .mockResolvedValueOnce(server)
        .mockResolvedValueOnce({ ...server, commandLine: "node other.js" });
      const harness = createHarness({ findOpencode });
      harness.answers.push("y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(1);
      expect(harness.deps.stopOpencode).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_refused", { pid: 7001 }));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_failed_left", {
          count: 1,
          items: tEn("uninstall.left_opencode", { pid: 7001 }),
        }),
      );
    });

    it("excludes the own process chain and the daemon pid from both lookups", async () => {
      const harness = createHarness({
        getOwnPidChain: vi.fn(async () => [OWN_PID, OWN_PPID, 1]),
        findOpencode: vi.fn(async () => server),
      });
      harness.answers.push("y");

      await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(vi.mocked(harness.deps.findOpencode).mock.calls).toEqual([
        [[OWN_PID, OWN_PPID, 1, DAEMON_PID]],
        [[OWN_PID, OWN_PPID, 1, DAEMON_PID]],
      ]);
    });
  });

  describe("override home", () => {
    let overrideHome: string;

    beforeEach(async () => {
      overrideHome = path.join(tempRoot, "override-home");
    });

    it("removes a valid override after its own yes, even with --yes", async () => {
      await populateHome(overrideHome);
      const harness = createHarness({ getHomes: () => ({ defaultHome, overrideHome }) });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.prompts).toEqual([tEn("uninstall.confirm_override", { path: overrideHome })]);
      expect(harness.lines).toContain(tEn("uninstall.plan_override", { path: overrideHome }));
      for (const name of INVENTORY) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(false);
      }
      expect(await exists(path.join(overrideHome, "logs"))).toBe(true);
      expect(harness.secrets.size).toBe(0);
    });

    const SECRET_FILES = ["secrets.enc", "keystore_password"];
    const KEPT_ON_DECLINE = INVENTORY.filter((name) => !SECRET_FILES.includes(name));

    it("on a declined override removes only secrets.enc and keystore_password, and the keychain", async () => {
      await populateHome(overrideHome);
      const harness = createHarness({ getHomes: () => ({ defaultHome, overrideHome }) });
      harness.answers.push("n");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      for (const name of KEPT_ON_DECLINE) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(true);
      }
      for (const name of SECRET_FILES) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(false);
        expect(harness.lines).toContain(
          tEn("uninstall.step_removed", { path: path.join(overrideHome, name) }),
        );
      }
      expect(harness.lines).toContain(
        tEn("uninstall.plan_override_secrets", { path: overrideHome }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_skipped", { path: overrideHome }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_secrets", { path: overrideHome }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.summary_left", {
          items: tEn("uninstall.left_override_kept", { path: overrideHome }),
        }),
      );
      expect(harness.deps.removeAppHome).not.toHaveBeenCalledWith(overrideHome);
      expect(harness.secrets.size).toBe(0);
      expectAllTranslated(harness.lines, en);
    });

    it("without a terminal removes only the two secret files of a valid override", async () => {
      await populateHome(overrideHome);
      const harness = createHarness({
        isInteractive: false,
        getHomes: () => ({ defaultHome, overrideHome }),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.ask).not.toHaveBeenCalled();
      for (const name of KEPT_ON_DECLINE) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(true);
      }
      for (const name of SECRET_FILES) {
        expect(await exists(path.join(overrideHome, name)), name).toBe(false);
      }
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_skipped_no_terminal", { path: overrideHome }),
      );
      expect(harness.secrets.size).toBe(0);
    });

    it.skipIf(isWindows)(
      "on a declined override unlinks a symlinked secrets.enc and leaves its outside target",
      async () => {
        await populateHome(overrideHome);
        const target = path.join(outside, "secrets.enc");
        await fs.writeFile(target, "encrypted");
        await fs.rm(path.join(overrideHome, "secrets.enc"));
        await fs.symlink(target, path.join(overrideHome, "secrets.enc"));
        const realTarget = await fs.realpath(target);
        const harness = createHarness({ getHomes: () => ({ defaultHome, overrideHome }) });
        harness.answers.push("n");

        await runUninstall(YES, harness.deps);

        expect(await exists(path.join(overrideHome, "secrets.enc"))).toBe(false);
        expect(await exists(target)).toBe(true);
        expect(harness.lines).toContain(tEn("uninstall.step_target_left", { path: realTarget }));
      },
    );

    it("touches nothing in an invalid override, not even its secret files", async () => {
      await fs.mkdir(overrideHome);
      await fs.writeFile(path.join(overrideHome, "secrets.enc"), "encrypted");
      await fs.writeFile(path.join(overrideHome, "keystore_password"), "pw");
      const harness = createHarness({ getHomes: () => ({ defaultHome, overrideHome }) });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(await exists(path.join(overrideHome, "secrets.enc"))).toBe(true);
      expect(await exists(path.join(overrideHome, "keystore_password"))).toBe(true);
      expect(harness.deps.removePath).not.toHaveBeenCalled();
      expect(harness.lines).not.toContain(
        tEn("uninstall.plan_override_secrets", { path: overrideHome }),
      );
      expect(harness.secrets.size).toBe(0);
    });

    for (const [reason, key] of [
      ["unreadable", "uninstall.override_reason_unreadable"],
      ["root", "uninstall.override_reason_root"],
      ["user-home", "uninstall.override_reason_user_home"],
      ["not-a-directory", "uninstall.override_reason_not_a_directory"],
    ] as const) {
      it(`skips an override that is ${reason} with the reason and touches nothing`, async () => {
        await populateHome(overrideHome);
        const harness = createHarness({
          getHomes: () => ({ defaultHome, overrideHome }),
          validateOverride: vi.fn(async () => ({ ok: false as const, reason })),
        });

        const code = await runUninstall(YES, harness.deps);

        expect(code).toBe(0);
        expect(harness.deps.ask).not.toHaveBeenCalled();
        await expectHomeUntouched(overrideHome);
        expect(harness.lines).toContain(
          tEn("uninstall.step_override_invalid", { path: overrideHome, reason: tEn(key) }),
        );
        expect(harness.lines).toContain(tEn("uninstall.summary_left", { items: overrideHome }));
        expect(harness.secrets.size).toBe(0);
      });
    }

    it("skips a real file given as the override with not-a-directory", async () => {
      await fs.writeFile(overrideHome, "a file");
      const harness = createHarness({ getHomes: () => ({ defaultHome, overrideHome }) });

      await runUninstall(YES, harness.deps);

      expect(await fs.readFile(overrideHome, "utf-8")).toBe("a file");
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_invalid", {
          path: overrideHome,
          reason: tEn("uninstall.override_reason_not_a_directory"),
        }),
      );
    });

    it("validates the override again before removing its secret files after a decline", async () => {
      await populateHome(overrideHome);
      const validateOverride = vi
        .fn<UninstallDeps["validateOverride"]>()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValue({ ok: false, reason: "no-bot-files" });
      const harness = createHarness({
        getHomes: () => ({ defaultHome, overrideHome }),
        validateOverride,
      });
      harness.answers.push("n");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(validateOverride).toHaveBeenCalledTimes(3);
      await expectHomeUntouched(overrideHome);
      expect(harness.deps.removePath).not.toHaveBeenCalled();
      expect(harness.lines).not.toContain(
        tEn("uninstall.step_override_secrets", { path: overrideHome }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_invalid", {
          path: overrideHome,
          reason: tEn("uninstall.override_reason_no_bot_files"),
        }),
      );
    });

    it("validates the override again right after the confirmation", async () => {
      await populateHome(overrideHome);
      const validateOverride = vi
        .fn<UninstallDeps["validateOverride"]>()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValue({ ok: false, reason: "no-bot-files" });
      const harness = createHarness({
        getHomes: () => ({ defaultHome, overrideHome }),
        validateOverride,
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.prompts).toEqual([tEn("uninstall.confirm_override", { path: overrideHome })]);
      await expectHomeUntouched(overrideHome);
      expect(harness.deps.removeAppHome).not.toHaveBeenCalledWith(overrideHome);
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_invalid", {
          path: overrideHome,
          reason: tEn("uninstall.override_reason_no_bot_files"),
        }),
      );
    });

    it("skips a missing override with the reason and never creates it", async () => {
      const harness = createHarness({ getHomes: () => ({ defaultHome, overrideHome }) });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(await exists(overrideHome)).toBe(false);
      expect(harness.deps.removeAppHome).not.toHaveBeenCalledWith(overrideHome);
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_invalid", {
          path: overrideHome,
          reason: tEn("uninstall.override_reason_missing"),
        }),
      );
      expect(harness.secrets.size).toBe(0);
    });

    it("skips an override with no bot files with the reason", async () => {
      await fs.mkdir(overrideHome);
      await fs.writeFile(path.join(overrideHome, "notes.txt"), "mine");
      const harness = createHarness({ getHomes: () => ({ defaultHome, overrideHome }) });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.ask).not.toHaveBeenCalled();
      expect(await exists(path.join(overrideHome, "notes.txt"))).toBe(true);
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_invalid", {
          path: overrideHome,
          reason: tEn("uninstall.override_reason_no_bot_files"),
        }),
      );
      expect(harness.lines).toContain(tEn("uninstall.summary_left", { items: overrideHome }));
      expect(harness.secrets.size).toBe(0);
    });

    it("still removes the keychain when the override removal fails", async () => {
      await populateHome(overrideHome);
      const harness = createHarness({
        getHomes: () => ({ defaultHome, overrideHome }),
        removeAppHome: vi.fn(async (home: string) =>
          home === overrideHome
            ? {
                results: [
                  { path: path.join(home, ".env"), status: "failed" as const, error: "EBUSY" },
                ],
                homeRemoved: false,
              }
            : removeAppHomeData(home),
        ),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.secrets.size).toBe(0);
    });
  });

  describe("removal results", () => {
    it("exits 1 on a failed removal while the other steps still run", async () => {
      await populateHome(defaultHome);
      const failedPath = path.join(defaultHome, "settings.json");
      const harness = createHarness({
        removeAppHome: vi.fn(async () => ({
          results: [
            {
              path: failedPath,
              status: "failed" as const,
              error: `EBUSY: busy ${SENTINEL}`,
              code: "EBUSY",
            },
          ],
          homeRemoved: false,
        })),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(
        tEn("uninstall.step_failed", { path: failedPath, reason: "EBUSY" }),
      );
      expect(harness.lines.join("\n")).not.toContain(SENTINEL);
      expect(harness.secrets.size).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.summary_failed", { count: 1 }));
      expect(harness.lines.at(-1)).toBe(tEn("uninstall.cli_hint", { command: CLI_COMMAND }));
    });

    it("reports a home error as a failed step", async () => {
      const harness = createHarness({
        removeAppHome: vi.fn(async () => ({
          results: [],
          homeRemoved: false,
          homeError: `EACCES: permission denied ${SENTINEL}`,
          homeErrorCode: "EACCES",
        })),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(
        tEn("uninstall.step_home_error", { path: defaultHome, reason: "EACCES" }),
      );
      expect(harness.lines.join("\n")).not.toContain(SENTINEL);
    });

    it("prints ERROR for a removal failure without a code or with a malformed one", async () => {
      const harness = createHarness({
        removeAppHome: vi.fn(async (home: string) => ({
          results: [
            { path: path.join(home, ".env"), status: "failed" as const, error: "no code" },
            {
              path: path.join(home, "settings.json"),
              status: "failed" as const,
              error: "bad code",
              code: `E ${SENTINEL}`,
            },
          ],
          homeRemoved: false,
        })),
      });

      await runUninstall(YES, harness.deps);

      expect(harness.lines).toContain(
        tEn("uninstall.step_failed", { path: path.join(defaultHome, ".env"), reason: "ERROR" }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_failed", {
          path: path.join(defaultHome, "settings.json"),
          reason: "ERROR",
        }),
      );
      expect(harness.lines.join("\n")).not.toContain(SENTINEL);
    });

    it.skipIf(isWindows)(
      "reports the outside target of a symlinked .env and leaves it",
      async () => {
        const target = path.join(outside, "real.env");
        await fs.writeFile(target, "TELEGRAM_BOT_TOKEN=abc\n");
        await fs.symlink(target, path.join(defaultHome, ".env"));
        const realTarget = await fs.realpath(target);
        const harness = createHarness();

        const code = await runUninstall(YES, harness.deps);

        expect(code).toBe(0);
        expect(await exists(path.join(defaultHome, ".env"))).toBe(false);
        expect(await exists(target)).toBe(true);
        expect(harness.lines).toContain(
          tEn("uninstall.step_link_removed", {
            path: path.join(defaultHome, ".env"),
            target: realTarget,
          }),
        );
        expect(harness.lines).toContain(tEn("uninstall.step_target_left", { path: realTarget }));
        expect(harness.lines).toContain(tEn("uninstall.summary_left", { items: realTarget }));
      },
    );

    it.skipIf(isWindows)("does not report a link target inside the home as left", async () => {
      await fs.writeFile(path.join(defaultHome, "settings.json"), "{}");
      await fs.symlink(path.join(defaultHome, "settings.json"), path.join(defaultHome, ".env"));
      const harness = createHarness();

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines.some((line) => line.startsWith("Left the link target"))).toBe(false);
      expect(harness.lines).toContain(tEn("uninstall.summary_ok"));
    });

    it("reports an unavailable keychain without failing", async () => {
      const harness = createHarness({
        removeKeychain: vi.fn(async () => ({ available: false, results: [] })),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.step_keychain_unavailable"));
      expect(harness.lines).toContain(
        tEn("uninstall.summary_left", { items: tEn("uninstall.left_keychain") }),
      );
    });

    it("exits 1 when a keychain account fails", async () => {
      const [first] = STORED_KEYCHAIN_ACCOUNTS;
      const harness = createHarness({
        removeKeychain: vi.fn(async () => ({
          available: true,
          results: [{ account: first ?? "", status: "failed" as const }],
        })),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(
        tEn("uninstall.step_keychain", {
          account: first ?? "",
          status: tEn("uninstall.keychain_status_failed"),
        }),
      );
    });
  });

  describe("output", () => {
    it("never prints a secret value", async () => {
      await populateHome(defaultHome, `TELEGRAM_BOT_TOKEN=${SENTINEL}\nBOT_LOCALE=en\n`);
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [
          botProcess(5001, `node /opt/bot/dist/cli.js start --token ${SENTINEL}`),
        ]),
        findOpencode: vi.fn(async () => ({
          pid: 7001,
          port: 4096,
          commandLine: `opencode serve --password=${SENTINEL}`,
        })),
      });
      harness.answers.push("y", "y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(0);
      expect(harness.prompts).toHaveLength(2);
      for (const text of [...harness.lines, ...harness.prompts]) {
        expect(text).not.toContain(SENTINEL);
      }
    });

    it("prints every line in German for a German locale", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({ env: { BOT_LOCALE: "de" } });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.lines[0]).toBe(de["uninstall.plan_header"]);
      expect(harness.lines.at(-1)).toBe(
        createUninstallTranslator("de")("uninstall.cli_hint", { command: CLI_COMMAND }),
      );
      expectAllTranslated(harness.lines, de);
      expect(harness.lines).not.toContain(en["uninstall.plan_header"]);
    });

    it("reads the locale from the .env of the app home before removing it", async () => {
      await populateHome(defaultHome, "BOT_LOCALE=de\n");
      const harness = createHarness();

      await runUninstall(YES, harness.deps);

      expect(harness.lines[0]).toBe(de["uninstall.plan_header"]);
      expect(await exists(path.join(defaultHome, ".env"))).toBe(false);
    });

    it("localizes the container refusal", async () => {
      const harness = createHarness({ env: { BOT_LOCALE: "de" }, isContainer: vi.fn(() => true) });

      await runUninstall(YES, harness.deps);

      expect(harness.lines).toEqual([de["uninstall.refused_container"]]);
    });

    it("prints left items, systemd commands, and the combined summary in German", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({
        env: { BOT_LOCALE: "de" },
        isInteractive: false,
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        systemd: {
          platform: "linux",
          unitExists: async () => true,
          hasSudo: async () => true,
          isInteractive: false,
          run: vi.fn(async () => 0),
        },
        removeKeychain: vi.fn(async () => ({
          available: true,
          results: [{ account: "TELEGRAM_BOT_TOKEN", status: "failed" as const }],
        })),
      });
      const tDe = createUninstallTranslator("de");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(
        tDe("uninstall.step_systemd_commands", {
          commands: SYSTEMD_COMMANDS.map(formatSystemdCommand).join("\n"),
        }),
      );
      expect(harness.lines).toContain(
        tDe("uninstall.summary_failed_left", {
          count: 1,
          items: [tDe("uninstall.left_process", { pid: 5001 }), SYSTEMD_UNIT_PATH].join(
            tDe("uninstall.list_separator"),
          ),
        }),
      );
      expectAllTranslated(harness.lines, de);
      for (const line of harness.lines) {
        expect(line).not.toMatch(/\b(?:process|Skipped|left in place|Uninstall finished)\b/);
      }
    });

    it("joins left items with the locale's list separator", async () => {
      const harness = createHarness({
        env: { BOT_LOCALE: "zh" },
        isInteractive: false,
        findBotProcesses: vi.fn(async () => [botProcess(5001), botProcess(5002)]),
      });
      const tZh = createUninstallTranslator("zh");
      const first = tZh("uninstall.left_process", { pid: 5001 });
      const second = tZh("uninstall.left_process", { pid: 5002 });

      await runUninstall(YES, harness.deps);

      expect(harness.lines).toContain(
        tZh("uninstall.summary_left", { items: `${first}、${second}` }),
      );
    });

    it("reports a throwing keychain removal as failed accounts and keeps going", async () => {
      const harness = createHarness({
        removeKeychain: vi.fn(async () => {
          throw new Error(`keyring exploded ${SENTINEL}`);
        }),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      for (const account of STORED_KEYCHAIN_ACCOUNTS) {
        expect(harness.lines).toContain(
          tEn("uninstall.step_keychain", {
            account,
            status: tEn("uninstall.keychain_status_failed"),
          }),
        );
      }
      expect(harness.lines.join("\n")).not.toContain(SENTINEL);
    });

    it("reasonCode keeps only short upper-case codes and is ERROR otherwise", () => {
      expect(reasonCode(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("EACCES");
      expect(reasonCode({ code: "ERR_INVALID_ARG_TYPE" })).toBe("ERR_INVALID_ARG_TYPE");
      for (const input of [
        new Error(SENTINEL),
        { code: "eacces" },
        { code: "E" },
        { code: `E${"X".repeat(31)}` },
        { code: `EACCES ${SENTINEL}` },
        { code: 13 },
        SENTINEL,
        null,
        undefined,
      ]) {
        expect(reasonCode(input)).toBe("ERROR");
      }
    });

    it("prints only error codes for printed reasons, never the error message", async () => {
      await populateHome(defaultHome);
      const coded = (code: string, where: string): Error =>
        Object.assign(new Error(`${where} ${SENTINEL}`), { code });
      const harness = createHarness({
        stopDaemon: vi.fn(async () => {
          throw coded("EACCES", "stopDaemon");
        }),
        findBotProcesses: vi.fn(async () => {
          throw coded("ETIMEDOUT", "findBotProcesses");
        }),
        systemd: {
          platform: "linux",
          unitExists: async () => {
            throw coded("EPERM", "unitExists");
          },
          hasSudo: async () => true,
          isInteractive: true,
          run: vi.fn(async () => 0),
        },
        removeAppHome: vi.fn(async (home: string) => ({
          results: [
            {
              path: path.join(home, ".env"),
              status: "failed" as const,
              error: `rm ${SENTINEL}`,
              code: "EBUSY",
            },
          ],
          homeRemoved: false,
          homeError: `home ${SENTINEL}`,
          homeErrorCode: "ENOTDIR",
        })),
      });
      const homesHarness = createHarness({
        getHomes: () => {
          throw coded("ENOENT", "getHomes");
        },
      });
      const plainHarness = createHarness({
        getHomes: () => {
          throw new Error(`plain ${SENTINEL}`);
        },
      });

      await runUninstall(YES, harness.deps);
      await runUninstall(YES, homesHarness.deps);
      await runUninstall(YES, plainHarness.deps);

      const lines = [...harness.lines, ...homesHarness.lines, ...plainHarness.lines];
      expect(lines.filter((line) => line.includes(SENTINEL))).toEqual([]);
      expect(harness.lines).toContain(tEn("uninstall.step_daemon_error", { reason: "EACCES" }));
      expect(harness.lines).toContain(tEn("uninstall.step_scan_failed", { reason: "ETIMEDOUT" }));
      expect(harness.lines).toContain(tEn("uninstall.step_systemd_failed", { reason: "EPERM" }));
      expect(harness.lines).toContain(
        tEn("uninstall.step_failed", { path: path.join(defaultHome, ".env"), reason: "EBUSY" }),
      );
      expect(harness.lines).toContain(
        tEn("uninstall.step_home_error", { path: defaultHome, reason: "ENOTDIR" }),
      );
      expect(homesHarness.lines).toEqual([tEn("uninstall.step_homes_error", { reason: "ENOENT" })]);
      expect(plainHarness.lines).toEqual([tEn("uninstall.step_homes_error", { reason: "ERROR" })]);
    });

    it("prints ERROR for a failed daemon stop result, never its error text", async () => {
      const harness = createHarness({
        getDaemonStatus: vi.fn(async () => {
          throw new Error("status");
        }),
        stopDaemon: vi.fn(async () => ({
          success: false,
          service: null,
          cleanupReason: null,
          error: `Failed ${SENTINEL}`,
        })),
      });

      await runUninstall(YES, harness.deps);

      expect(harness.lines).toContain(tEn("uninstall.step_daemon_error", { reason: "ERROR" }));
      expect(harness.lines.join("\n")).not.toContain(SENTINEL);
    });

    it("never prints a secret from swallowed errors or from process command lines", async () => {
      await populateHome(defaultHome, `TELEGRAM_BOT_TOKEN=${SENTINEL}\n`);
      const overrideHome = path.join(tempRoot, "override-home");
      await populateHome(overrideHome, `TELEGRAM_BOT_TOKEN=${SENTINEL}\n`);
      const secretError = (): never => {
        throw new Error(`boom ${SENTINEL}`);
      };
      const harness = createHarness({
        getHomes: () => ({ defaultHome, overrideHome }),
        findBotProcesses: vi.fn(async () => [
          botProcess(5001, `node /opt/bot/dist/cli.js start --token ${SENTINEL}`),
        ]),
        reverifyProcess: vi.fn(async () => secretError()),
        findOpencode: vi.fn(async () => ({
          pid: 7001,
          port: 4096,
          commandLine: `opencode serve --password ${SENTINEL}`,
        })),
        stopOpencode: vi.fn(async () => secretError()),
        validateOverride: vi.fn(async () => secretError()),
        removeKeychain: vi.fn(async () => secretError()),
        removeAppHome: vi.fn(async (home: string) => ({
          results: [{ path: path.join(home, ".env"), status: "failed" as const, error: "EBUSY" }],
          homeRemoved: false,
        })),
        stopDaemon: vi.fn(async () => {
          throw new Error("EACCES: state file");
        }),
      });
      harness.answers.push("y", "y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(1);
      for (const text of [...harness.lines, ...harness.prompts]) {
        expect(text).not.toContain(SENTINEL);
      }
    });
  });
});
