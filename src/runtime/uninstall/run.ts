import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { I18nKey } from "../../i18n/en.js";
import { findServerPid, getProcessCommandLine } from "../../opencode/process-control.js";
import { KeychainSecretStore } from "../../secrets/keychain-secret-store.js";
import { isContainerRuntime } from "../container.js";
import { resolveLogsDirPath } from "../log-location.js";
import { askVisibleOrEof } from "../prompts.js";
import { getBotServiceStatus, stopBotDaemon } from "../service/manager.js";
import { KEYCHAIN_SERVICE, STORED_KEYCHAIN_ACCOUNTS, listAppHomeTargets } from "../stored-data.js";
import {
  resolveUninstallHomes,
  validateOverrideHome,
  type OverrideInvalidReason,
  type UninstallHomes,
} from "./homes.js";
import { removeKeychainAccounts, type KeychainRemoval } from "./keychain.js";
import {
  createUninstallTranslator,
  redactCommandLine,
  resolveUninstallLocale,
} from "./messages.js";
import {
  findOpencodeServer,
  resolveOpencodePort,
  stopOpencodeServer,
  type OpencodeServer,
} from "./opencode-server.js";
import {
  defaultScanDeps,
  findBotProcesses,
  reverifyBotProcess,
  type BotProcess,
  type ScanDeps,
} from "./processes.js";
import { removeAppHomeData, type RemoveAppHomeResult } from "./remove-path.js";
import {
  SYSTEMD_COMMANDS,
  SYSTEMD_UNIT_PATH,
  defaultSystemdDeps,
  formatSystemdCommand,
  removeSystemdUnit,
  type SystemdDeps,
  type SystemdOutcome,
} from "./systemd.js";

// The uninstaller never initializes the file logger. Every line goes through the translator.

/** Printed verbatim: a constant, not process text, so it is not passed through redaction. */
const CLI_UNINSTALL_COMMAND = "npm uninstall -g @grinev/opencode-telegram-bot";
// SIGTERM, then SIGKILL after this long, the same as the daemon stop.
const PROCESS_STOP_TIMEOUT_MS = 5000;
const PROCESS_EXIT_POLL_MS = 100;
const STOP_SIGNALS = ["SIGTERM", "SIGKILL"] as const;

// run.ts lives in <root>/{src,dist}/runtime/uninstall; the running checkout or package root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface UninstallOptions {
  yes: boolean;
  stopOpencode: boolean;
}

export type StopSignal = (typeof STOP_SIGNALS)[number];

export interface UninstallDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isContainer(): boolean;
  getUid(): number | null;
  isInteractive: boolean;
  /** Resolves null at end of input. */
  ask(question: string): Promise<string | null>;
  /** Writes one translated line (the newline is added by the writer). */
  write(line: string): void;
  homes: UninstallHomes;
  getDaemonStatus: typeof getBotServiceStatus;
  stopDaemon: typeof stopBotDaemon;
  findBotProcesses(excludePids: readonly number[]): Promise<BotProcess[]>;
  /** Called immediately before every signal; false means the pid must not be signaled. */
  reverifyProcess(found: BotProcess): Promise<boolean>;
  /** Throws like process.kill (ESRCH when the process is gone). */
  signalProcess(pid: number, signal: StopSignal): void;
  /** Resolves true when the process has exited within the timeout. */
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
  systemd: SystemdDeps;
  findOpencode(): Promise<OpencodeServer | null>;
  stopOpencode(pid: number): Promise<boolean>;
  removeAppHome(appHome: string): ReturnType<typeof removeAppHomeData>;
  removeKeychain(): Promise<KeychainRemoval>;
  /** Resolves the log directory without prompting. */
  resolveLogsDir(): Promise<string>;
}

type Say = (key: I18nKey, params?: Record<string, string | number>) => void;
type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

interface Outcome {
  failures: number;
  left: string[];
}

type DaemonState = { kind: "running"; pid: number } | { kind: "stopped" } | { kind: "error" };

type ScanState =
  | { kind: "found"; processes: BotProcess[] }
  | { kind: "unsupported" }
  | { kind: "failed"; reason: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Only y, Y, or yes (any case, trimmed) is yes; everything else and end of input is no. */
function isYes(answer: string | null): boolean {
  return answer !== null && /^(?:y|yes)$/i.test(answer.trim());
}

async function confirm(deps: UninstallDeps, question: string): Promise<boolean> {
  try {
    return isYes(await deps.ask(question));
  } catch {
    return false;
  }
}

function isInside(target: string, base: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

async function detectDaemon(deps: UninstallDeps): Promise<DaemonState> {
  try {
    const status = await deps.getDaemonStatus();
    return status.status === "running" && status.service
      ? { kind: "running", pid: status.service.pid }
      : { kind: "stopped" };
  } catch {
    return { kind: "error" };
  }
}

async function detectBots(deps: UninstallDeps, daemon: DaemonState): Promise<ScanState> {
  if (deps.platform === "win32") {
    return { kind: "unsupported" };
  }

  try {
    const exclude = daemon.kind === "running" ? [daemon.pid] : [];
    return { kind: "found", processes: await deps.findBotProcesses(exclude) };
  } catch (error) {
    return { kind: "failed", reason: errorText(error) };
  }
}

async function detectSystemdUnit(systemd: SystemdDeps): Promise<boolean> {
  if (systemd.platform !== "linux") {
    return false;
  }

  try {
    return await systemd.unitExists();
  } catch {
    // Unknown: shown in the plan; the removal step reports the error.
    return true;
  }
}

async function detectOpencode(deps: UninstallDeps): Promise<OpencodeServer | null> {
  try {
    return await deps.findOpencode();
  } catch {
    return null;
  }
}

async function hasHomeTargets(appHome: string): Promise<boolean> {
  try {
    return (await listAppHomeTargets(appHome)).length > 0;
  } catch {
    // Unreadable: shown in the plan; the removal step reports the error.
    return true;
  }
}

async function stopDaemonStep(
  deps: UninstallDeps,
  daemon: DaemonState,
  say: Say,
  outcome: Outcome,
): Promise<void> {
  if (daemon.kind === "stopped") {
    say("uninstall.step_daemon_absent");
    return;
  }

  try {
    const result = await deps.stopDaemon();
    const pid = result.service?.pid ?? (daemon.kind === "running" ? daemon.pid : null);
    if (result.alreadyStopped) {
      say("uninstall.step_daemon_absent");
    } else if (result.success && pid !== null) {
      say("uninstall.step_daemon_stopped", { pid });
    } else if (pid !== null) {
      say("uninstall.step_daemon_failed", { pid });
      outcome.failures += 1;
    } else {
      say("uninstall.step_daemon_error", { reason: result.error ?? "" });
      outcome.failures += 1;
    }
  } catch (error) {
    say("uninstall.step_daemon_error", { reason: errorText(error) });
    outcome.failures += 1;
  }
}

type ProcessStopResult = "stopped" | "failed" | "refused";

/**
 * SIGTERM, then SIGKILL after the timeout. The process is re-verified immediately before each
 * signal; a process that no longer verifies is never signaled again (refused), unless it has
 * already exited.
 */
async function stopBotProcess(deps: UninstallDeps, found: BotProcess): Promise<ProcessStopResult> {
  if (!Number.isInteger(found.pid) || found.pid <= 0) {
    return "refused";
  }

  for (const signal of STOP_SIGNALS) {
    if (!(await deps.reverifyProcess(found))) {
      return (await deps.waitForExit(found.pid, 0)) ? "stopped" : "refused";
    }

    try {
      deps.signalProcess(found.pid, signal);
    } catch (error) {
      return errorCode(error) === "ESRCH" ? "stopped" : "failed";
    }

    if (await deps.waitForExit(found.pid, PROCESS_STOP_TIMEOUT_MS)) {
      return "stopped";
    }
  }

  return "failed";
}

async function stopBotsStep(
  deps: UninstallDeps,
  scan: ScanState,
  translate: Translate,
  say: Say,
  outcome: Outcome,
): Promise<void> {
  if (scan.kind === "unsupported") {
    say("uninstall.step_scan_unsupported");
    return;
  }
  if (scan.kind === "failed") {
    say("uninstall.step_scan_failed", { reason: scan.reason });
    outcome.failures += 1;
    return;
  }

  for (const found of scan.processes) {
    const leaveRunning = (): void => {
      say("uninstall.step_process_skipped", { pid: found.pid });
      outcome.left.push(translate("uninstall.left_process", { pid: found.pid }));
    };

    if (!deps.isInteractive) {
      leaveRunning();
      continue;
    }

    if (!found.verified) {
      say("uninstall.process_unverified", { pid: found.pid });
    }
    const question = translate("uninstall.confirm_stop_process", {
      pid: found.pid,
      user: found.user,
      started: found.startedAt ?? translate("uninstall.started_unknown"),
      command: redactCommandLine(found.commandLine),
    });
    if (!(await confirm(deps, question))) {
      leaveRunning();
      continue;
    }

    let result: ProcessStopResult;
    try {
      result = await stopBotProcess(deps, found);
    } catch {
      result = "failed";
    }

    if (result === "stopped") {
      say("uninstall.step_process_stopped", { pid: found.pid });
      continue;
    }
    say(result === "refused" ? "uninstall.step_process_refused" : "uninstall.step_process_failed", {
      pid: found.pid,
    });
    outcome.failures += 1;
    outcome.left.push(translate("uninstall.left_process", { pid: found.pid }));
  }
}

const SYSTEMD_OUTCOME_KEYS: Record<SystemdOutcome, I18nKey> = {
  "not-applicable": "uninstall.systemd_outcome_not_applicable",
  absent: "uninstall.systemd_outcome_absent",
  removed: "uninstall.systemd_outcome_removed",
  "skipped-no-terminal": "uninstall.systemd_outcome_skipped_no_terminal",
  "skipped-no-sudo": "uninstall.systemd_outcome_skipped_no_sudo",
  failed: "uninstall.systemd_outcome_failed",
};

async function systemdStep(
  deps: UninstallDeps,
  translate: Translate,
  say: Say,
  outcome: Outcome,
): Promise<void> {
  let commands: readonly (readonly string[])[];
  try {
    const result = await removeSystemdUnit(deps.systemd);
    say("uninstall.step_systemd", { outcome: translate(SYSTEMD_OUTCOME_KEYS[result.outcome]) });
    if (result.outcome === "removed" || result.commands.length === 0) {
      return;
    }
    if (result.outcome === "failed") {
      outcome.failures += 1;
    }
    commands = result.commands;
  } catch (error) {
    say("uninstall.step_systemd_failed", { reason: errorText(error) });
    outcome.failures += 1;
    commands = SYSTEMD_COMMANDS;
  }

  say("uninstall.step_systemd_commands", {
    commands: commands.map(formatSystemdCommand).join("\n"),
  });
  outcome.left.push(SYSTEMD_UNIT_PATH);
}

async function opencodeStep(
  deps: UninstallDeps,
  server: OpencodeServer | null,
  translate: Translate,
  say: Say,
  outcome: Outcome,
): Promise<void> {
  if (server === null) {
    say("uninstall.step_opencode_none");
    return;
  }

  const leaveRunning = (): void => {
    say("uninstall.step_opencode_skipped");
    outcome.left.push(translate("uninstall.left_opencode", { pid: server.pid }));
  };

  if (!deps.isInteractive) {
    leaveRunning();
    return;
  }

  if (deps.platform === "win32") {
    say("uninstall.confirm_stop_opencode_tree");
  }
  const question = translate("uninstall.confirm_stop_opencode", {
    pid: server.pid,
    port: server.port,
    command:
      server.commandLine === null
        ? translate("uninstall.command_unavailable")
        : redactCommandLine(server.commandLine),
  });
  if (!(await confirm(deps, question))) {
    leaveRunning();
    return;
  }

  // Time of check to time of use: the listener is looked up again right before the kill, and a
  // different pid or command line means the confirmed process is not the one listening now.
  const fresh = await detectOpencode(deps);
  if (fresh === null || fresh.pid !== server.pid || fresh.commandLine !== server.commandLine) {
    say("uninstall.step_opencode_refused", { pid: server.pid });
    outcome.failures += 1;
    outcome.left.push(translate("uninstall.left_opencode", { pid: server.pid }));
    return;
  }

  let stopped: boolean;
  try {
    stopped = await deps.stopOpencode(server.pid);
  } catch {
    stopped = false;
  }

  if (stopped) {
    say("uninstall.step_opencode_stopped", { pid: server.pid });
  } else {
    say("uninstall.step_opencode_failed", { pid: server.pid });
    outcome.failures += 1;
    outcome.left.push(translate("uninstall.left_opencode", { pid: server.pid }));
  }
}

async function removeHomeStep(
  deps: UninstallDeps,
  appHome: string,
  say: Say,
  outcome: Outcome,
): Promise<void> {
  // Taken before the removal: the home itself may be removed when it ends up empty.
  const realHome = await realpathOrSelf(appHome);

  let removal: RemoveAppHomeResult;
  try {
    removal = await deps.removeAppHome(appHome);
  } catch (error) {
    removal = { results: [], homeRemoved: false, homeError: errorText(error) };
  }

  const linkTargets: string[] = [];
  for (const result of removal.results) {
    if (result.status === "failed") {
      say("uninstall.step_failed", { path: result.path, reason: result.error ?? "" });
      outcome.failures += 1;
    } else if (result.status === "absent") {
      say("uninstall.step_absent", { path: result.path });
    } else if (result.linkTarget !== undefined) {
      say("uninstall.step_link_removed", { path: result.path, target: result.linkTarget });
      linkTargets.push(result.linkTarget);
    } else {
      say("uninstall.step_removed", { path: result.path });
    }
  }

  // Only a target that still exists outside the home is left in place; a target inside the home
  // was either removed in this run or stays with the kept home.
  for (const target of linkTargets) {
    if (isInside(target, appHome) || isInside(target, realHome) || !(await pathExists(target))) {
      continue;
    }
    say("uninstall.step_target_left", { path: target });
    outcome.left.push(target);
  }

  if (removal.homeError !== undefined) {
    say("uninstall.step_home_error", { path: appHome, reason: removal.homeError });
    outcome.failures += 1;
  }

  if (removal.homeRemoved) {
    say("uninstall.home_removed", { path: appHome });
  } else if (await pathExists(appHome)) {
    say("uninstall.home_kept", { path: appHome });
  }
}

const OVERRIDE_REASON_KEYS: Record<OverrideInvalidReason, I18nKey> = {
  missing: "uninstall.override_reason_missing",
  unreadable: "uninstall.override_reason_unreadable",
  "not-a-directory": "uninstall.override_reason_not_a_directory",
  root: "uninstall.override_reason_root",
  "user-home": "uninstall.override_reason_user_home",
  "no-bot-files": "uninstall.override_reason_no_bot_files",
};

async function overrideStep(
  deps: UninstallDeps,
  overrideHome: string,
  translate: Translate,
  say: Say,
  outcome: Outcome,
): Promise<void> {
  let reason: OverrideInvalidReason | null;
  try {
    const validation = await validateOverrideHome(overrideHome);
    reason = validation.ok ? null : validation.reason;
  } catch {
    reason = "unreadable";
  }

  if (reason !== null) {
    say("uninstall.step_override_invalid", {
      path: overrideHome,
      reason: translate(OVERRIDE_REASON_KEYS[reason]),
    });
    // A missing directory leaves nothing behind and is never created.
    if (reason !== "missing") {
      outcome.left.push(overrideHome);
    }
    return;
  }

  const confirmed =
    deps.isInteractive &&
    (await confirm(deps, translate("uninstall.confirm_override", { path: overrideHome })));
  if (!confirmed) {
    say("uninstall.step_override_skipped", { path: overrideHome });
    outcome.left.push(overrideHome);
    return;
  }

  await removeHomeStep(deps, overrideHome, say, outcome);
}

const KEYCHAIN_STATUS_KEYS: Record<KeychainRemoval["results"][number]["status"], I18nKey> = {
  removed: "uninstall.keychain_status_removed",
  absent: "uninstall.keychain_status_absent",
  failed: "uninstall.keychain_status_failed",
};

async function keychainStep(
  deps: UninstallDeps,
  translate: Translate,
  say: Say,
  outcome: Outcome,
): Promise<void> {
  let removal: KeychainRemoval;
  try {
    removal = await deps.removeKeychain();
  } catch {
    removal = {
      available: true,
      results: STORED_KEYCHAIN_ACCOUNTS.map((account) => ({ account, status: "failed" })),
    };
  }

  if (!removal.available) {
    say("uninstall.step_keychain_unavailable");
    outcome.left.push(translate("uninstall.left_keychain"));
    return;
  }

  for (const { account, status } of removal.results) {
    say("uninstall.step_keychain", { account, status: translate(KEYCHAIN_STATUS_KEYS[status]) });
    if (status === "failed") {
      outcome.failures += 1;
    }
  }
}

/**
 * Runs the uninstall: refusals, plan, one confirmation (skipped by --yes), then every step in a
 * fixed order. A failing step never stops the others. Returns 0 on success and 1 when a step
 * failed or the run was refused or declined.
 */
export async function runUninstall(
  options: UninstallOptions,
  overrides: Partial<UninstallDeps> = {},
): Promise<number> {
  const deps: UninstallDeps = { ...defaultUninstallDeps(), ...overrides };
  const { defaultHome, overrideHome } = deps.homes;

  // Read-only: the locale comes from the environment or the .env of the app home the bot uses,
  // so even the refusals are localized.
  const locale = await resolveUninstallLocale(
    deps.env,
    path.join(overrideHome ?? defaultHome, ".env"),
  );
  const translate: Translate = createUninstallTranslator(locale);
  const say: Say = (key, params) => deps.write(translate(key, params));

  if (deps.isContainer()) {
    say("uninstall.refused_container");
    return 1;
  }
  if (deps.getUid() === 0) {
    say("uninstall.refused_root");
    return 1;
  }

  let logsDir: string | null;
  try {
    logsDir = await deps.resolveLogsDir();
  } catch {
    logsDir = null;
  }

  const daemon = await detectDaemon(deps);
  const scan = await detectBots(deps, daemon);
  const systemdPlanned = await detectSystemdUnit(deps.systemd);
  const server = options.stopOpencode ? await detectOpencode(deps) : null;

  say("uninstall.plan_header");
  if (daemon.kind === "running") {
    say("uninstall.plan_daemon", { pid: daemon.pid });
  }
  if (scan.kind === "found" && scan.processes.length > 0) {
    say("uninstall.plan_terminal_bots");
  }
  if (systemdPlanned) {
    say("uninstall.plan_systemd", { path: SYSTEMD_UNIT_PATH });
  }
  if (server !== null) {
    say("uninstall.plan_opencode_server");
  }
  if (await hasHomeTargets(defaultHome)) {
    say("uninstall.plan_home", { path: defaultHome });
  }
  if (overrideHome !== null) {
    say("uninstall.plan_override", { path: overrideHome });
  }
  say("uninstall.plan_keychain", { service: KEYCHAIN_SERVICE });
  if (logsDir !== null) {
    say("uninstall.plan_logs_stay", { path: logsDir });
  }

  if (!options.yes) {
    if (!deps.isInteractive) {
      say("uninstall.no_terminal_plan_only");
      return 1;
    }
    if (!(await confirm(deps, translate("uninstall.confirm_plan")))) {
      say("uninstall.aborted");
      return 1;
    }
  }

  const outcome: Outcome = { failures: 0, left: [] };
  await stopDaemonStep(deps, daemon, say, outcome);
  await stopBotsStep(deps, scan, translate, say, outcome);
  await systemdStep(deps, translate, say, outcome);
  if (options.stopOpencode) {
    await opencodeStep(deps, server, translate, say, outcome);
  }
  // Includes secrets.enc and keystore_password.
  await removeHomeStep(deps, defaultHome, say, outcome);
  if (overrideHome !== null) {
    await overrideStep(deps, overrideHome, translate, say, outcome);
  }
  // Runs whatever happened to the override: the keychain belongs to the OS user.
  await keychainStep(deps, translate, say, outcome);

  if (outcome.failures > 0) {
    say("uninstall.summary_failed", { count: outcome.failures });
  }
  if (outcome.left.length > 0) {
    say("uninstall.summary_left", { items: outcome.left.join(", ") });
  }
  if (outcome.failures === 0 && outcome.left.length === 0) {
    say("uninstall.summary_ok");
  }
  say("uninstall.cli_hint", { command: CLI_UNINSTALL_COMMAND });

  return outcome.failures > 0 ? 1 : 0;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else.
    return errorCode(error) !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
  return !isAlive(pid);
}

/** The real system access. Nothing here runs until a step calls it. */
export function defaultUninstallDeps(): UninstallDeps {
  const homes = resolveUninstallHomes(process.env);
  const runtimeEnvFile = path.join(homes.overrideHome ?? homes.defaultHome, ".env");
  let scanDeps: Promise<ScanDeps> | undefined;
  let excludedPids: readonly number[] = [];
  const getScanDeps = async (): Promise<ScanDeps> => ({
    ...(await (scanDeps ??= defaultScanDeps([PACKAGE_ROOT]))),
    excludePids: excludedPids,
  });

  return {
    env: process.env,
    platform: process.platform,
    isContainer: () => isContainerRuntime(),
    getUid: () => (typeof process.getuid === "function" ? process.getuid() : null),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (question) => askVisibleOrEof(question),
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    homes,
    getDaemonStatus: getBotServiceStatus,
    stopDaemon: stopBotDaemon,
    findBotProcesses: async (excludePids) => {
      excludedPids = [...excludePids];
      return findBotProcesses(await getScanDeps());
    },
    reverifyProcess: async (found) => reverifyBotProcess(found, await getScanDeps()),
    signalProcess: (pid, signal) => {
      process.kill(pid, signal);
    },
    waitForExit: waitForProcessExit,
    systemd: defaultSystemdDeps(),
    findOpencode: async () =>
      findOpencodeServer({
        port: await resolveOpencodePort(process.env, runtimeEnvFile),
        findPid: findServerPid,
        commandLine: getProcessCommandLine,
      }),
    stopOpencode: (pid) => stopOpencodeServer(pid),
    removeAppHome: removeAppHomeData,
    removeKeychain: () => removeKeychainAccounts(new KeychainSecretStore()),
    resolveLogsDir: () =>
      resolveLogsDirPath({
        prompt: false,
        isInteractive: false,
        warn: (message) => {
          process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
        },
      }),
  };
}
