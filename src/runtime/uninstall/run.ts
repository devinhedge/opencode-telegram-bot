import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { I18nKey } from "../../i18n/en.js";
import { findServerPid, getProcessCommandLine } from "../../opencode/process-control.js";
import { KeychainSecretStore } from "../../secrets/keychain-secret-store.js";
import { isContainerRuntime } from "../container.js";
import { resolveLogsDirPath } from "../log-location.js";
import { askVisibleOrEof } from "../prompts.js";
import { readBotServiceStatus, stopBotDaemon } from "../service/manager.js";
import type { BotServiceStatus } from "../service/types.js";
import { KEYCHAIN_SERVICE, STORED_KEYCHAIN_ACCOUNTS, listAppHomeTargets } from "../stored-data.js";
import {
  resolveUninstallHomes,
  validateOverrideHome,
  type OverrideInvalidReason,
  type OverrideValidation,
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
  collectOwnChain,
  defaultScanDeps,
  findBotProcesses,
  reverifyBotProcess,
  type BotProcess,
  type ScanDeps,
} from "./processes.js";
import {
  removeAppHomeData,
  removePath,
  type RemoveAppHomeResult,
  type RemoveResult,
} from "./remove-path.js";
import {
  SYSTEMD_COMMANDS,
  SYSTEMD_UNIT_PATH,
  defaultSystemdDeps,
  defaultSystemdMainPidDeps,
  formatSystemdCommand,
  getSystemdMainPid,
  removeSystemdUnit,
  type SystemdDeps,
  type SystemdOutcome,
} from "./systemd.js";

// The uninstaller never initializes the file logger. Every line goes through the translator.

/** A constant, not process text: printed verbatim and therefore not passed through redaction. */
const CLI_UNINSTALL_COMMAND = "npm uninstall -g @grinev/opencode-telegram-bot";
// SIGTERM, then SIGKILL after this long, the same as the daemon stop.
const PROCESS_STOP_TIMEOUT_MS = 5000;
const PROCESS_EXIT_POLL_MS = 100;
const STOP_SIGNALS = ["SIGTERM", "SIGKILL"] as const;
// Removed from a valid override even when the rest of it is kept (spec: secrets are removed
// whatever happens to the override step).
const OVERRIDE_SECRET_FILES = ["secrets.enc", "keystore_password"] as const;

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
  /** May throw (os.homedir); the run then refuses or stops before anything is touched. */
  getHomes(): UninstallHomes;
  /** Read-only: a stale or invalid state file is reported, never removed. */
  getDaemonStatus(): Promise<BotServiceStatus>;
  stopDaemon: typeof stopBotDaemon;
  /** The own pid and its ancestors. */
  getOwnPidChain(): Promise<readonly number[]>;
  /** The main pid of the systemd unit, or null. */
  findSystemdMainPid(): Promise<number | null>;
  findBotProcesses(excludePids: readonly number[]): Promise<BotProcess[]>;
  /** Called immediately before every signal; false means the pid must not be signaled. */
  reverifyProcess(found: BotProcess): Promise<boolean>;
  /** Throws like process.kill (ESRCH when the process is gone). */
  signalProcess(pid: number, signal: StopSignal): void;
  /** Resolves true when the process has exited within the timeout. */
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
  systemd: SystemdDeps;
  findOpencode(excludePids: readonly number[]): Promise<OpencodeServer | null>;
  stopOpencode(pid: number): Promise<boolean>;
  validateOverride(overrideHome: string): Promise<OverrideValidation>;
  removePath(target: string): Promise<RemoveResult>;
  removeAppHome(appHome: string): ReturnType<typeof removeAppHomeData>;
  removeKeychain(): Promise<KeychainRemoval>;
  /** Resolves the log directory without prompting; warnings go to `warn`. */
  resolveLogsDir(warn: (message: string) => void): Promise<string>;
}

type Say = (key: I18nKey, params?: Record<string, string | number>) => void;
type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

interface Context {
  deps: UninstallDeps;
  translate: Translate;
  say: Say;
  failures: number;
  left: string[];
}

type DaemonState = { kind: "running"; pid: number } | { kind: "stopped" } | { kind: "error" };

type ScanState =
  | { kind: "found"; processes: BotProcess[] }
  | { kind: "unsupported" }
  | { kind: "failed"; reason: string };

// Error reasons are raw OS and library diagnostics (English, for example "EACCES: permission
// denied, rm '<path>'"): they carry paths and codes, never a secret value, and are not translated.
// The same holds for the `ps` start time (LC_ALL=C day and month names) and account names.
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

async function detectSystemdMainPid(deps: UninstallDeps): Promise<number | null> {
  try {
    return await deps.findSystemdMainPid();
  } catch {
    return null;
  }
}

async function detectOwnChain(deps: UninstallDeps): Promise<readonly number[]> {
  try {
    return await deps.getOwnPidChain();
  } catch {
    return [process.pid, process.ppid];
  }
}

async function detectBots(deps: UninstallDeps, exclude: readonly number[]): Promise<ScanState> {
  if (deps.platform === "win32") {
    return { kind: "unsupported" };
  }

  try {
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

async function detectOpencode(
  deps: UninstallDeps,
  exclude: readonly number[],
): Promise<OpencodeServer | null> {
  try {
    return await deps.findOpencode(exclude);
  } catch {
    return null;
  }
}

async function validate(
  deps: UninstallDeps,
  overrideHome: string,
): Promise<OverrideInvalidReason | null> {
  try {
    const validation = await deps.validateOverride(overrideHome);
    return validation.ok ? null : validation.reason;
  } catch {
    return "unreadable";
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

async function stopDaemonStep(ctx: Context, daemon: DaemonState): Promise<void> {
  if (daemon.kind === "stopped") {
    ctx.say("uninstall.step_daemon_absent");
    return;
  }

  const failed = (): void => {
    ctx.failures += 1;
    ctx.left.push(ctx.translate("uninstall.left_daemon"));
  };

  try {
    // Runs only after the main confirmation; it may remove the state file in the runtime home.
    const result = await ctx.deps.stopDaemon();
    const pid = result.service?.pid ?? (daemon.kind === "running" ? daemon.pid : null);
    if (result.alreadyStopped) {
      ctx.say("uninstall.step_daemon_absent");
    } else if (result.success && pid !== null) {
      ctx.say("uninstall.step_daemon_stopped", { pid });
    } else if (pid !== null) {
      ctx.say("uninstall.step_daemon_failed", { pid });
      failed();
    } else {
      ctx.say("uninstall.step_daemon_error", { reason: result.error ?? "" });
      failed();
    }
  } catch (error) {
    ctx.say("uninstall.step_daemon_error", { reason: errorText(error) });
    failed();
  }
}

type ProcessStopResult = "stopped" | "failed" | "refused";

/**
 * SIGTERM, then SIGKILL after the timeout. The process is re-verified immediately before each
 * signal; a pid that no longer matches the bot is never signaled (refused) unless it has
 * already exited (stopped). A signal error other than ESRCH is a failure.
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

async function stopBotsStep(ctx: Context, scan: ScanState): Promise<void> {
  const { deps, translate, say } = ctx;
  if (scan.kind === "unsupported") {
    say("uninstall.step_scan_unsupported");
    return;
  }
  if (scan.kind === "failed") {
    // A skipped step, not a failure: the summary says the processes were not checked.
    say("uninstall.step_scan_failed", { reason: scan.reason });
    ctx.left.push(translate("uninstall.left_scan"));
    return;
  }

  for (const found of scan.processes) {
    const leftRunning = (): void => {
      ctx.left.push(translate("uninstall.left_process", { pid: found.pid }));
    };

    if (!deps.isInteractive) {
      say("uninstall.step_process_skipped_no_terminal", { pid: found.pid });
      leftRunning();
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
      say("uninstall.step_process_skipped", { pid: found.pid });
      leftRunning();
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
    } else if (result === "refused") {
      // The pid exited or was reused: not this run's failure, but it is reported as left.
      say("uninstall.step_process_refused", { pid: found.pid });
      leftRunning();
    } else {
      say("uninstall.step_process_failed", { pid: found.pid });
      ctx.failures += 1;
      leftRunning();
    }
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

function formatCommands(commands: readonly (readonly string[])[]): string {
  return commands.map(formatSystemdCommand).join("\n");
}

async function systemdStep(ctx: Context): Promise<void> {
  let commands: readonly (readonly string[])[];
  try {
    const result = await removeSystemdUnit(ctx.deps.systemd);
    ctx.say("uninstall.step_systemd", {
      outcome: ctx.translate(SYSTEMD_OUTCOME_KEYS[result.outcome]),
    });
    if (result.outcome === "removed") {
      ctx.say("uninstall.step_systemd_ran", {
        path: SYSTEMD_UNIT_PATH,
        commands: formatCommands(result.commands),
      });
      return;
    }
    if (result.commands.length === 0) {
      return;
    }
    if (result.outcome === "failed") {
      ctx.failures += 1;
    }
    commands = result.commands;
  } catch (error) {
    ctx.say("uninstall.step_systemd_failed", { reason: errorText(error) });
    ctx.failures += 1;
    commands = SYSTEMD_COMMANDS;
  }

  ctx.say("uninstall.step_systemd_commands", { commands: formatCommands(commands) });
  ctx.left.push(SYSTEMD_UNIT_PATH);
}

async function opencodeStep(
  ctx: Context,
  server: OpencodeServer | null,
  exclude: readonly number[],
): Promise<void> {
  const { deps, translate, say } = ctx;
  if (server === null) {
    say("uninstall.step_opencode_none");
    return;
  }

  const leftRunning = (): void => {
    ctx.left.push(translate("uninstall.left_opencode", { pid: server.pid }));
  };

  if (!deps.isInteractive) {
    say("uninstall.step_opencode_skipped_no_terminal");
    leftRunning();
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
    say("uninstall.step_opencode_skipped");
    leftRunning();
    return;
  }

  // Time of check to time of use: the listener is looked up again right before the kill, and a
  // different pid or command line means the confirmed process is not the one listening now.
  const fresh = await detectOpencode(deps, exclude);
  if (fresh === null || fresh.pid !== server.pid || fresh.commandLine !== server.commandLine) {
    say("uninstall.step_opencode_refused", { pid: server.pid });
    ctx.failures += 1;
    leftRunning();
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
    ctx.failures += 1;
    leftRunning();
  }
}

/** Prints each result; a link target that still exists outside the home is listed as left. */
async function reportRemovals(
  ctx: Context,
  results: readonly RemoveResult[],
  appHome: string,
  realHome: string,
): Promise<void> {
  const linkTargets: string[] = [];
  for (const result of results) {
    if (result.status === "failed") {
      ctx.say("uninstall.step_failed", { path: result.path, reason: result.error ?? "" });
      ctx.failures += 1;
    } else if (result.status === "absent") {
      ctx.say("uninstall.step_absent", { path: result.path });
    } else if (result.linkTarget !== undefined) {
      ctx.say("uninstall.step_link_removed", { path: result.path, target: result.linkTarget });
      linkTargets.push(result.linkTarget);
    } else {
      ctx.say("uninstall.step_removed", { path: result.path });
    }
  }

  // A target inside the home was either removed in this run or stays with the kept home.
  for (const target of linkTargets) {
    if (isInside(target, appHome) || isInside(target, realHome) || !(await pathExists(target))) {
      continue;
    }
    ctx.say("uninstall.step_target_left", { path: target });
    ctx.left.push(target);
  }
}

async function removeHomeStep(ctx: Context, appHome: string): Promise<void> {
  if (!(await pathExists(appHome))) {
    ctx.say("uninstall.step_absent", { path: appHome });
    return;
  }

  // Taken before the removal: the home itself may be removed when it ends up empty.
  const realHome = await realpathOrSelf(appHome);

  let removal: RemoveAppHomeResult;
  try {
    removal = await ctx.deps.removeAppHome(appHome);
  } catch (error) {
    removal = { results: [], homeRemoved: false, homeError: errorText(error) };
  }

  await reportRemovals(ctx, removal.results, appHome, realHome);

  if (removal.homeError !== undefined) {
    ctx.say("uninstall.step_home_error", { path: appHome, reason: removal.homeError });
    ctx.failures += 1;
  }

  if (removal.homeRemoved) {
    ctx.say("uninstall.home_removed", { path: appHome });
  } else if (await pathExists(path.join(appHome, "logs"))) {
    ctx.say("uninstall.home_kept_logs", { path: appHome });
  } else if (await pathExists(appHome)) {
    ctx.say("uninstall.home_kept", { path: appHome });
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

function reportInvalidOverride(
  ctx: Context,
  overrideHome: string,
  reason: OverrideInvalidReason,
): void {
  ctx.say("uninstall.step_override_invalid", {
    path: overrideHome,
    reason: ctx.translate(OVERRIDE_REASON_KEYS[reason]),
  });
  // A missing directory leaves nothing behind and is never created; an invalid one is untouched.
  if (reason !== "missing") {
    ctx.left.push(overrideHome);
  }
}

/** The kept override still loses its secret files: only these two names, links unlinked only. */
async function removeOverrideSecrets(ctx: Context, overrideHome: string): Promise<void> {
  ctx.say("uninstall.step_override_secrets", { path: overrideHome });
  const realHome = await realpathOrSelf(overrideHome);
  const results: RemoveResult[] = [];
  for (const name of OVERRIDE_SECRET_FILES) {
    const target = path.join(overrideHome, name);
    try {
      results.push(await ctx.deps.removePath(target));
    } catch (error) {
      results.push({ path: target, status: "failed", error: errorText(error) });
    }
  }
  await reportRemovals(ctx, results, overrideHome, realHome);
  ctx.left.push(ctx.translate("uninstall.left_override_kept", { path: overrideHome }));
}

async function overrideStep(ctx: Context, overrideHome: string): Promise<void> {
  const before = await validate(ctx.deps, overrideHome);
  if (before !== null) {
    reportInvalidOverride(ctx, overrideHome, before);
    return;
  }

  if (!ctx.deps.isInteractive) {
    ctx.say("uninstall.step_override_skipped_no_terminal", { path: overrideHome });
    await removeOverrideSecrets(ctx, overrideHome);
    return;
  }

  const question = ctx.translate("uninstall.confirm_override", { path: overrideHome });
  if (!(await confirm(ctx.deps, question))) {
    ctx.say("uninstall.step_override_skipped", { path: overrideHome });
    await removeOverrideSecrets(ctx, overrideHome);
    return;
  }

  // The answer may have taken a while: the directory must still qualify right before removal.
  const after = await validate(ctx.deps, overrideHome);
  if (after !== null) {
    reportInvalidOverride(ctx, overrideHome, after);
    return;
  }

  await removeHomeStep(ctx, overrideHome);
}

const KEYCHAIN_STATUS_KEYS: Record<KeychainRemoval["results"][number]["status"], I18nKey> = {
  removed: "uninstall.keychain_status_removed",
  absent: "uninstall.keychain_status_absent",
  failed: "uninstall.keychain_status_failed",
};

async function keychainStep(ctx: Context): Promise<void> {
  let removal: KeychainRemoval;
  try {
    removal = await ctx.deps.removeKeychain();
  } catch {
    // The error text is not printed: a keyring library message is not ours to show.
    removal = {
      available: true,
      results: STORED_KEYCHAIN_ACCOUNTS.map((account) => ({ account, status: "failed" })),
    };
  }

  if (!removal.available) {
    ctx.say("uninstall.step_keychain_unavailable");
    ctx.left.push(ctx.translate("uninstall.left_keychain"));
    return;
  }

  for (const { account, status } of removal.results) {
    ctx.say("uninstall.step_keychain", {
      account,
      status: ctx.translate(KEYCHAIN_STATUS_KEYS[status]),
    });
    if (status === "failed") {
      ctx.failures += 1;
    }
  }
}

function printSummary(ctx: Context): void {
  const items = ctx.left.join(ctx.translate("uninstall.list_separator"));
  if (ctx.failures > 0 && ctx.left.length > 0) {
    ctx.say("uninstall.summary_failed_left", { count: ctx.failures, items });
  } else if (ctx.failures > 0) {
    ctx.say("uninstall.summary_failed", { count: ctx.failures });
  } else if (ctx.left.length > 0) {
    ctx.say("uninstall.summary_left", { items });
  } else {
    ctx.say("uninstall.summary_ok");
  }
  // {command} is the only placeholder not passed through redactCommandLine: it is a constant.
  ctx.say("uninstall.cli_hint", { command: CLI_UNINSTALL_COMMAND });
}

/**
 * Runs the uninstall: refusals, plan, one confirmation (skipped by --yes), then every step in a
 * fixed order. A failing step never stops the others. Returns 0 on success and 1 when a step
 * failed or the run was refused or declined. Pass either every dependency or none: a partial set
 * is a type error, so a missing key can never fall back to real system access.
 */
export async function runUninstall(
  options: UninstallOptions,
  deps: UninstallDeps = defaultUninstallDeps(),
): Promise<number> {
  let homes: UninstallHomes | null = null;
  let homesError = "";
  try {
    homes = deps.getHomes();
  } catch (error) {
    homesError = errorText(error);
  }

  // Read-only: the locale comes from the environment or the .env of the app home the bot uses,
  // so even the refusals are localized.
  const locale = await resolveUninstallLocale(
    deps.env,
    homes === null ? null : path.join(homes.overrideHome ?? homes.defaultHome, ".env"),
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
  if (homes === null) {
    say("uninstall.step_homes_error", { reason: homesError });
    return 1;
  }
  const { defaultHome, overrideHome } = homes;

  let logsDir: string | null;
  try {
    logsDir = await deps.resolveLogsDir((message) =>
      say("uninstall.step_logs_warning", { message: message.trimEnd() }),
    );
  } catch {
    logsDir = null;
  }

  const daemon = await detectDaemon(deps);
  const daemonPids = daemon.kind === "running" ? [daemon.pid] : [];
  const systemdPid = await detectSystemdMainPid(deps);
  // A bot run by systemd is stopped through the unit and is never asked about twice.
  const scan = await detectBots(
    deps,
    systemdPid === null ? daemonPids : [...daemonPids, systemdPid],
  );
  const systemdPlanned = await detectSystemdUnit(deps.systemd);
  const opencodeExclude = options.stopOpencode
    ? [...(await detectOwnChain(deps)), ...daemonPids]
    : [];
  const server = options.stopOpencode ? await detectOpencode(deps, opencodeExclude) : null;
  const overrideValid = overrideHome !== null && (await validate(deps, overrideHome)) === null;

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
    if (overrideValid) {
      say("uninstall.plan_override_secrets", { path: overrideHome });
    }
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

  const ctx: Context = { deps, translate, say, failures: 0, left: [] };
  await stopDaemonStep(ctx, daemon);
  await stopBotsStep(ctx, scan);
  await systemdStep(ctx);
  if (options.stopOpencode) {
    await opencodeStep(ctx, server, opencodeExclude);
  }
  // Includes secrets.enc and keystore_password.
  await removeHomeStep(ctx, defaultHome);
  if (overrideHome !== null) {
    await overrideStep(ctx, overrideHome);
  }
  // Runs whatever happened to the override: the keychain belongs to the OS user.
  await keychainStep(ctx);

  printSummary(ctx);
  return ctx.failures > 0 ? 1 : 0;
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

/**
 * The real system access. Building it touches nothing and cannot throw: every lookup, including
 * the app homes (os.homedir can throw), runs only when a step calls it.
 */
export function defaultUninstallDeps(): UninstallDeps {
  let homes: UninstallHomes | undefined;
  const getHomes = (): UninstallHomes => (homes ??= resolveUninstallHomes(process.env));
  const runtimeEnvFile = (): string => {
    const { defaultHome, overrideHome } = getHomes();
    return path.join(overrideHome ?? defaultHome, ".env");
  };
  let scanDeps: Promise<ScanDeps> | undefined;
  let excludedPids: readonly number[] = [];
  const getScanDeps = async (): Promise<ScanDeps> => ({
    ...(await (scanDeps ??= defaultScanDeps([PACKAGE_ROOT]))),
    excludePids: excludedPids,
  });
  const systemd = defaultSystemdDeps();

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
    getHomes,
    getDaemonStatus: () => readBotServiceStatus(),
    stopDaemon: stopBotDaemon,
    getOwnPidChain: async () => {
      const scan = await getScanDeps();
      return [...collectOwnChain(await scan.listProcesses(), scan.ownPid, scan.ownPpid)];
    },
    findSystemdMainPid: () => getSystemdMainPid(defaultSystemdMainPidDeps(systemd)),
    findBotProcesses: async (excludePids) => {
      // Kept for reverifyProcess, which must apply the same exclusions before every signal.
      excludedPids = [...excludePids];
      return findBotProcesses(await getScanDeps());
    },
    reverifyProcess: async (found) => reverifyBotProcess(found, await getScanDeps()),
    signalProcess: (pid, signal) => {
      process.kill(pid, signal);
    },
    waitForExit: waitForProcessExit,
    systemd,
    findOpencode: async (excludePids) =>
      findOpencodeServer({
        port: await resolveOpencodePort(process.env, runtimeEnvFile()),
        findPid: findServerPid,
        commandLine: getProcessCommandLine,
        excludePids,
      }),
    stopOpencode: (pid) => stopOpencodeServer(pid),
    validateOverride: (overrideHome) => validateOverrideHome(overrideHome),
    removePath,
    removeAppHome: removeAppHomeData,
    removeKeychain: () => removeKeychainAccounts(new KeychainSecretStore()),
    resolveLogsDir: (warn) => resolveLogsDirPath({ prompt: false, isInteractive: false, warn }),
  };
}
