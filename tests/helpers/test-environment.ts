import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimePaths } from "../../src/runtime/paths.js";

const state = globalThis as typeof globalThis & {
  __opencodeTestHomes?: { defaultHome: string; homes: Set<string> };
  __opencodeTestUserHome?: { root: string };
};

// Every variable from which a user home or an OS default directory is derived. They all point
// inside a temp user home for the whole test file, so os.homedir(), getInstalledAppHome() and the
// canonical log directory can never resolve to the developer's real home.
export const USER_HOME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

function userHomeEnv(root: string): Record<(typeof USER_HOME_ENV_KEYS)[number], string> {
  return {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_STATE_HOME: path.join(root, ".local", "state"),
    APPDATA: path.join(root, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(root, "AppData", "Local"),
  };
}

function getUserHome(): { root: string } {
  state.__opencodeTestUserHome ??= {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "opencode-telegram-user-home-")),
  };
  return state.__opencodeTestUserHome;
}

/** The temp directory that stands in for the user's home during this test file. */
export function getTestUserHome(): string {
  return getUserHome().root;
}

/**
 * Removes the temp user home (setup afterAll). The variables are deliberately NOT restored to the
 * real values: late async work of the finished file must never resolve against the real home. They
 * keep pointing at the removed directory until the next file's setup creates a new temp home and
 * re-points them.
 */
export function releaseTestUserHome(): void {
  const userHome = state.__opencodeTestUserHome;
  if (!userHome) {
    return;
  }
  fs.rmSync(userHome.root, { recursive: true, force: true });
  delete state.__opencodeTestUserHome;
}
// Module resets must not forget ownership or adopt a restored user environment.
const homes = (state.__opencodeTestHomes ??= {
  defaultHome: fs.mkdtempSync(path.join(os.tmpdir(), "opencode-telegram-tests-")),
  homes: new Set<string>(),
});
homes.homes.add(homes.defaultHome);

export async function createTestHome(prefix: string): Promise<string> {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  homes.homes.add(home);
  return home;
}

export function isolateRuntimePaths(paths: RuntimePaths): RuntimePaths {
  if (homes.homes.has(paths.appHome)) {
    return paths;
  }
  const appHome = homes.defaultHome;
  return {
    ...paths,
    appHome,
    envFilePath: path.join(appHome, ".env"),
    settingsFilePath: path.join(appHome, "settings.json"),
    logsDirPath: path.join(appHome, "logs"),
    runDirPath: path.join(appHome, "run"),
    localCommandsDirPath: path.join(appHome, "local-commands"),
  };
}

const TEST_ENV_DEFAULTS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-telegram-token",
  TELEGRAM_ALLOWED_USER_ID: "123456789",
  OPENCODE_API_URL: "http://localhost:4096",
  OPENCODE_MODEL_PROVIDER: "test-provider",
  OPENCODE_MODEL_ID: "test-model",
  LOG_LEVEL: "error",
  LOG_RETENTION: "10",
  OPENCODE_TELEGRAM_HOME: homes.defaultHome,
};

export function ensureTestEnvironment(): void {
  process.env.OPENCODE_TELEGRAM_HOME = homes.defaultHome;
  // Always reset: a test that deleted or restored one of these must not reach the real home.
  for (const [key, value] of Object.entries(userHomeEnv(getUserHome().root))) {
    process.env[key] = value;
  }
  for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
