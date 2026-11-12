import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getInstalledAppHome } from "../paths.js";

export interface UninstallHomes {
  defaultHome: string;
  overrideHome: string | null;
}

export type OverrideInvalidReason =
  // The path does not exist (also a path below a file).
  | "missing"
  // The path exists but cannot be inspected (permissions or another filesystem error).
  | "unreadable"
  // The path exists and is not a directory.
  | "not-a-directory"
  // The path is, or links to, a filesystem root.
  | "root"
  // The path is, or links to, the user's home directory.
  | "user-home"
  // The directory holds none of .env, settings.json, run/bot-service.json as a regular file.
  | "no-bot-files";

export type OverrideValidation = { ok: true } | { ok: false; reason: OverrideInvalidReason };

const BOT_FILE_MARKERS = [".env", "settings.json", path.join("run", "bot-service.json")];

function isFilesystemRoot(target: string): boolean {
  return path.parse(target).root === target;
}

function realpathOrNull(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

function isSamePath(left: string, right: string): boolean {
  const realLeft = realpathOrNull(left);
  const realRight = realpathOrNull(right);
  if (realLeft !== null && realRight !== null) {
    return realLeft === realRight;
  }

  if (process.platform === "darwin" || process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }

  return left === right;
}

export function resolveUninstallHomes(env: NodeJS.ProcessEnv = process.env): UninstallHomes {
  // Only the override is read from `env`; the default home comes from the process environment.
  const defaultHome = path.resolve(getInstalledAppHome());
  const rawOverride = env.OPENCODE_TELEGRAM_HOME;

  if (!rawOverride || rawOverride.trim().length === 0) {
    return { defaultHome, overrideHome: null };
  }

  // Resolved untrimmed, the same way resolveAppHome in paths.ts resolves it.
  const overrideHome = path.resolve(rawOverride);
  return { defaultHome, overrideHome: isSamePath(overrideHome, defaultHome) ? null : overrideHome };
}

async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function validateOverrideHome(
  overridePath: string,
  homedir: string = os.homedir(),
): Promise<OverrideValidation> {
  const resolved = path.resolve(overridePath);
  const resolvedHome = path.resolve(homedir);

  if (isFilesystemRoot(resolved)) {
    return { ok: false, reason: "root" };
  }

  if (resolved === resolvedHome) {
    return { ok: false, reason: "user-home" };
  }

  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
    };
  }

  if (!stats.isDirectory()) {
    return { ok: false, reason: "not-a-directory" };
  }

  // Symlinks and case variants on case-insensitive volumes only show up after realpath.
  let realOverride: string;
  try {
    realOverride = await fs.realpath(resolved);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  if (isFilesystemRoot(realOverride)) {
    return { ok: false, reason: "root" };
  }

  const realHome = realpathOrNull(resolvedHome) ?? resolvedHome;
  if (realOverride === realHome) {
    return { ok: false, reason: "user-home" };
  }

  for (const marker of BOT_FILE_MARKERS) {
    if (await isRegularFile(path.join(resolved, marker))) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "no-bot-files" };
}
