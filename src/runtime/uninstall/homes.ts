import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getInstalledAppHome } from "../paths.js";

export interface UninstallHomes {
  defaultHome: string;
  overrideHome: string | null;
}

export type OverrideInvalidReason =
  "missing" | "not-a-directory" | "root" | "user-home" | "no-bot-files";

export type OverrideValidation = { ok: true } | { ok: false; reason: OverrideInvalidReason };

const BOT_FILE_MARKERS = [".env", "settings.json", path.join("run", "bot-service.json")];

export function resolveUninstallHomes(env: NodeJS.ProcessEnv = process.env): UninstallHomes {
  const defaultHome = path.resolve(getInstalledAppHome());
  const rawOverride = env.OPENCODE_TELEGRAM_HOME;

  if (!rawOverride || rawOverride.trim().length === 0) {
    return { defaultHome, overrideHome: null };
  }

  const overrideHome = path.resolve(rawOverride);
  return { defaultHome, overrideHome: overrideHome === defaultHome ? null : overrideHome };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function validateOverrideHome(
  overridePath: string,
  homedir: string = os.homedir(),
): Promise<OverrideValidation> {
  const resolved = path.resolve(overridePath);

  if (path.parse(resolved).root === resolved) {
    return { ok: false, reason: "root" };
  }

  if (resolved === path.resolve(homedir)) {
    return { ok: false, reason: "user-home" };
  }

  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch {
    return { ok: false, reason: "missing" };
  }

  if (!stats.isDirectory()) {
    return { ok: false, reason: "not-a-directory" };
  }

  for (const marker of BOT_FILE_MARKERS) {
    if (await pathExists(path.join(resolved, marker))) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "no-bot-files" };
}
