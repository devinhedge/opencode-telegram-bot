import type { RuntimeMode } from "../runtime/mode.js";

export type CliCommand = "start" | "status" | "stop" | "config" | "uninstall";

const CLI_MESSAGES = {
  unknownCommand: (value: string) => `Unknown command: ${value}`,
  modeRequiresValue: "Option --mode requires a value: sources|installed",
  invalidMode: (value: string) => `Invalid mode value: ${value}. Expected sources|installed`,
  unknownOption: (value: string) => `Unknown option: ${value}`,
  modeOnlyStart: "Option --mode is supported only for the start command",
  daemonOnlyStart: "Option --daemon is supported only for the start command",
  yesOnlyUninstall: "Option --yes is supported only for the uninstall command",
  stopOpencodeOnlyUninstall: "Option --stop-opencode is supported only for the uninstall command",
} as const;

export interface ParsedCliArgs {
  command: CliCommand;
  mode?: RuntimeMode | undefined;
  daemon: boolean;
  restart: boolean;
  showHelp: boolean;
  yes: boolean;
  stopOpencode: boolean;
  error?: string | undefined;
}

const SUPPORTED_COMMANDS: readonly CliCommand[] = [
  "start",
  "status",
  "stop",
  "config",
  "uninstall",
];

function isCliCommand(value: string): value is CliCommand {
  return SUPPORTED_COMMANDS.includes(value as CliCommand);
}

function normalizeMode(value: string): RuntimeMode | null {
  if (value === "installed") {
    return "installed";
  }

  if (value === "sources") {
    return "sources";
  }

  return null;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const args = [...argv];
  let command: CliCommand = "start";
  let mode: RuntimeMode | undefined;
  let daemon = false;
  let restart = false;
  let yes = false;
  let stopOpencode = false;
  let showHelp = false;
  let currentIndex = 0;

  const firstArg = args[0];
  if (firstArg && !firstArg.startsWith("-")) {
    if (!isCliCommand(firstArg)) {
      return {
        command,
        daemon,
        restart,
        yes,
        stopOpencode,
        showHelp: true,
        error: CLI_MESSAGES.unknownCommand(firstArg),
      };
    }

    command = firstArg;
    currentIndex = 1;
  }

  while (currentIndex < args.length) {
    const token = args[currentIndex];
    if (!token) {
      break;
    }

    if (token === "--help" || token === "-h") {
      showHelp = true;
      currentIndex += 1;
      continue;
    }

    if (token === "--daemon") {
      daemon = true;
      currentIndex += 1;
      continue;
    }

    if (token === "--restart") {
      restart = true;
      currentIndex += 1;
      continue;
    }

    if (token === "--yes") {
      yes = true;
      currentIndex += 1;
      continue;
    }

    if (token === "--stop-opencode") {
      stopOpencode = true;
      currentIndex += 1;
      continue;
    }

    if (token === "--mode") {
      const modeValue = args[currentIndex + 1];
      if (!modeValue || modeValue.startsWith("-")) {
        return {
          command,
          daemon,
          restart,
          yes,
          stopOpencode,
          mode,
          showHelp: true,
          error: CLI_MESSAGES.modeRequiresValue,
        };
      }

      const parsedMode = normalizeMode(modeValue);
      if (!parsedMode) {
        return {
          command,
          daemon,
          restart,
          yes,
          stopOpencode,
          mode,
          showHelp: true,
          error: CLI_MESSAGES.invalidMode(modeValue),
        };
      }

      mode = parsedMode;
      currentIndex += 2;
      continue;
    }

    if (token.startsWith("--mode=")) {
      const modeValue = token.slice("--mode=".length);
      const parsedMode = normalizeMode(modeValue);
      if (!parsedMode) {
        return {
          command,
          daemon,
          restart,
          yes,
          stopOpencode,
          mode,
          showHelp: true,
          error: CLI_MESSAGES.invalidMode(modeValue),
        };
      }

      mode = parsedMode;
      currentIndex += 1;
      continue;
    }

    return {
      command,
      daemon,
      restart,
      yes,
      stopOpencode,
      mode,
      showHelp: true,
      error: CLI_MESSAGES.unknownOption(token),
    };
  }

  if (command !== "start" && mode) {
    return {
      command,
      daemon,
      restart,
      yes,
      stopOpencode,
      mode,
      showHelp: true,
      error: CLI_MESSAGES.modeOnlyStart,
    };
  }

  if (command !== "start" && daemon) {
    return {
      command,
      daemon,
      restart,
      yes,
      stopOpencode,
      mode,
      showHelp: true,
      error: CLI_MESSAGES.daemonOnlyStart,
    };
  }

  if (command !== "start" && restart) {
    return {
      command,
      daemon,
      restart,
      yes,
      stopOpencode,
      mode,
      showHelp: true,
      error: "Option --restart is supported only for the start command",
    };
  }

  if (command !== "uninstall" && yes) {
    return {
      command,
      daemon,
      restart,
      yes,
      stopOpencode,
      mode,
      showHelp: true,
      error: CLI_MESSAGES.yesOnlyUninstall,
    };
  }

  if (command !== "uninstall" && stopOpencode) {
    return {
      command,
      daemon,
      restart,
      yes,
      stopOpencode,
      mode,
      showHelp: true,
      error: CLI_MESSAGES.stopOpencodeOnlyUninstall,
    };
  }

  return {
    command,
    daemon,
    restart,
    yes,
    stopOpencode,
    mode,
    showHelp,
  };
}
