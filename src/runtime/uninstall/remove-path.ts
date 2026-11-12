import fs from "node:fs/promises";
import { resolveSymlinkTarget } from "../env-file.js";
import { listAppHomeTargets } from "../stored-data.js";

export type RemoveStatus = "removed" | "absent" | "failed";

export interface RemoveResult {
  path: string;
  status: RemoveStatus;
  linkTarget?: string | undefined;
  error?: string | undefined;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeEntry(target: string, isSymlink: boolean): Promise<void> {
  try {
    await fs.rm(target, { recursive: true });
  } catch (error) {
    const code = errorCode(error);
    // chmod follows links, so a symlink is never chmodded: only a real entry is made writable.
    if ((code !== "EPERM" && code !== "EACCES") || isSymlink) {
      throw error;
    }
    // Covers the Windows read-only attribute: make the entry owner-writable once and retry.
    await fs.chmod(target, 0o700);
    await fs.rm(target, { recursive: true });
  }
}

/**
 * Removes one path without ever following a symlink. A symlink is unlinked and its final target
 * is reported in `linkTarget` and left in place; a file or directory is removed recursively.
 * Never throws: failures are returned as `failed` with the error text.
 */
export async function removePath(target: string): Promise<RemoveResult> {
  let isSymlink: boolean;
  try {
    isSymlink = (await fs.lstat(target)).isSymbolicLink();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { path: target, status: "absent" };
    }
    return { path: target, status: "failed", error: errorText(error) };
  }

  let linkTarget: string | undefined;
  if (isSymlink) {
    try {
      linkTarget = await resolveSymlinkTarget(target);
    } catch {
      // An unresolvable link (for example a loop) is still only unlinked, never followed.
      linkTarget = undefined;
    }
  }

  try {
    await removeEntry(target, isSymlink);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { path: target, status: "absent" };
    }
    return { path: target, status: "failed", error: errorText(error) };
  }

  return linkTarget === undefined
    ? { path: target, status: "removed" }
    : { path: target, status: "removed", linkTarget };
}

async function removeHomeIfEmpty(appHome: string): Promise<boolean> {
  try {
    // A symlinked home is never removed or followed.
    if (!(await fs.lstat(appHome)).isDirectory()) {
      return false;
    }
    if ((await fs.readdir(appHome)).length > 0) {
      return false;
    }
    // rmdir fails on a non-empty directory, so a file created meanwhile is never lost.
    await fs.rmdir(appHome);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the stored-data inventory from an app home, keeping logs and every unknown entry,
 * then removes the home directory only when nothing is left in it.
 */
export async function removeAppHomeData(
  appHome: string,
): Promise<{ results: RemoveResult[]; homeRemoved: boolean }> {
  const results: RemoveResult[] = [];
  for (const target of await listAppHomeTargets(appHome)) {
    results.push(await removePath(target));
  }
  return { results, homeRemoved: await removeHomeIfEmpty(appHome) };
}
