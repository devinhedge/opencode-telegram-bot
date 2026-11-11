import path from "node:path";

export type LogLocation = "default" | "app";

export type LogLocationSetting =
  { kind: "unset" } | { kind: "valid"; value: LogLocation } | { kind: "invalid"; raw: string };

const APP_DIR_NAME = "opencode-telegram-bot";

export function parseLogLocation(raw: string | undefined): LogLocationSetting {
  const normalized = (raw ?? "").trim().toLowerCase();

  if (normalized === "") {
    return { kind: "unset" };
  }

  if (normalized === "default" || normalized === "app") {
    return { kind: "valid", value: normalized };
  }

  // raw is the unmodified input (not trimmed) so warnings show exactly what the user typed.
  return { kind: "invalid", raw: raw ?? "" };
}

export function resolveCanonicalLogsDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base = localAppData || path.win32.join(homedir, "AppData", "Local");
    return path.win32.join(base, APP_DIR_NAME, "Logs");
  }

  if (platform === "darwin") {
    return path.posix.join(homedir, "Library", "Logs", APP_DIR_NAME);
  }

  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome && path.posix.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.posix.join(homedir, ".local", "state");
  return path.posix.join(stateHome, APP_DIR_NAME, "logs");
}
