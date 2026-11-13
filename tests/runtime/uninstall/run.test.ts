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
import { removeAppHomeData } from "../../../src/runtime/uninstall/remove-path.js";
import {
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

    const deps: UninstallDeps = {
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
      homes: { defaultHome, overrideHome: null },
      getDaemonStatus: vi.fn(async () => daemonStatus),
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
      removeAppHome: vi.fn((home: string) => removeAppHomeData(home)),
      removeKeychain: vi.fn(() => removeKeychainAccounts(store)),
      resolveLogsDir: vi.fn(async () => path.join(tempRoot, "canonical-logs")),
      ...overrides,
    };

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
      expect(harness.lines).toContain(tEn("uninstall.home_kept", { path: defaultHome }));
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
      expect(harness.lines).toContain(tEn("uninstall.home_kept", { path: defaultHome }));
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
  });

  describe("bot processes", () => {
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

    it("refuses to signal when the reverification fails, and exits 1", async () => {
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => [botProcess(5001)]),
        reverifyProcess: vi.fn(async () => false),
        waitForExit: vi.fn(async () => false),
      });
      harness.answers.push("y");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.deps.signalProcess).not.toHaveBeenCalled();
      expect(harness.lines).toContain(tEn("uninstall.step_process_refused", { pid: 5001 }));
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

      expect(code).toBe(1);
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
      expect(harness.lines).toContain(tEn("uninstall.step_process_skipped", { pid: 5001 }));
      expect(harness.lines).toContain(tEn("uninstall.step_process_skipped", { pid: 5002 }));
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

    it("reports a scan failure, still runs the other steps, and exits 1", async () => {
      await populateHome(defaultHome);
      const harness = createHarness({
        findBotProcesses: vi.fn(async () => {
          throw new Error("ps exploded");
        }),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(tEn("uninstall.step_scan_failed", { reason: "ps exploded" }));
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
      expect(harness.lines).toContain(
        tEn("uninstall.step_daemon_error", { reason: "EACCES: state file" }),
      );
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
      expect(harness.lines).toContain(
        tEn("uninstall.step_systemd_failed", { reason: "EACCES: unit" }),
      );
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
    });

    it("refuses when the fresh lookup finds nothing", async () => {
      const findOpencode = vi
        .fn<() => Promise<OpencodeServer | null>>()
        .mockResolvedValueOnce(server)
        .mockResolvedValueOnce(null);
      const harness = createHarness({ findOpencode });
      harness.answers.push("y");

      const code = await runUninstall({ yes: true, stopOpencode: true }, harness.deps);

      expect(code).toBe(1);
      expect(harness.deps.stopOpencode).not.toHaveBeenCalled();
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
      expect(harness.lines).toContain(tEn("uninstall.step_opencode_skipped"));
    });
  });

  describe("override home", () => {
    let overrideHome: string;

    beforeEach(async () => {
      overrideHome = path.join(tempRoot, "override-home");
    });

    it("removes a valid override after its own yes, even with --yes", async () => {
      await populateHome(overrideHome);
      const harness = createHarness({ homes: { defaultHome, overrideHome } });
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

    it("leaves a declined override and still removes the keychain", async () => {
      await populateHome(overrideHome);
      const harness = createHarness({ homes: { defaultHome, overrideHome } });
      harness.answers.push("n");

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      await expectHomeUntouched(overrideHome);
      expect(harness.lines).toContain(
        tEn("uninstall.step_override_skipped", { path: overrideHome }),
      );
      expect(harness.lines).toContain(tEn("uninstall.summary_left", { items: overrideHome }));
      expect(harness.secrets.size).toBe(0);
    });

    it("skips an override without a terminal and still removes the keychain", async () => {
      await populateHome(overrideHome);
      const harness = createHarness({ isInteractive: false, homes: { defaultHome, overrideHome } });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(0);
      expect(harness.deps.ask).not.toHaveBeenCalled();
      await expectHomeUntouched(overrideHome);
      expect(harness.secrets.size).toBe(0);
    });

    it("skips a missing override with the reason and never creates it", async () => {
      const harness = createHarness({ homes: { defaultHome, overrideHome } });

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
      const harness = createHarness({ homes: { defaultHome, overrideHome } });

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
        homes: { defaultHome, overrideHome },
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
          results: [{ path: failedPath, status: "failed" as const, error: "EBUSY: busy" }],
          homeRemoved: false,
        })),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(
        tEn("uninstall.step_failed", { path: failedPath, reason: "EBUSY: busy" }),
      );
      expect(harness.secrets.size).toBe(0);
      expect(harness.lines).toContain(tEn("uninstall.summary_failed", { count: 1 }));
      expect(harness.lines.at(-1)).toBe(tEn("uninstall.cli_hint", { command: CLI_COMMAND }));
    });

    it("reports a home error as a failed step", async () => {
      const harness = createHarness({
        removeAppHome: vi.fn(async () => ({
          results: [],
          homeRemoved: false,
          homeError: "EACCES",
        })),
      });

      const code = await runUninstall(YES, harness.deps);

      expect(code).toBe(1);
      expect(harness.lines).toContain(
        tEn("uninstall.step_home_error", { path: defaultHome, reason: "EACCES" }),
      );
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
  });
});
