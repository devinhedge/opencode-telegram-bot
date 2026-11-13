import fs from "node:fs/promises";
import path from "node:path";
import { resolveSymlinkTarget } from "../env-file.js";
import { listAppHomeTargets } from "../stored-data.js";

export type RemoveStatus = "removed" | "absent" | "failed";

export interface RemoveResult {
  path: string;
  status: RemoveStatus;
  linkTarget?: string | undefined;
  /** Diagnostic text; never printed by the uninstaller (it prints `code` only). */
  error?: string | undefined;
  /** The errno code of a failure (for example EACCES), when the error carried one. */
  code?: string | undefined;
}

export interface RemoveAppHomeResult {
  results: RemoveResult[];
  homeRemoved: boolean;
  // Set when the app home could not be listed or its empty directory could not be removed.
  homeError?: string | undefined;
  /** The errno code that goes with `homeError`, when the error carried one. */
  homeErrorCode?: string | undefined;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(target: string, error: unknown): RemoveResult {
  const code = errorCode(error);
  return code === undefined
    ? { path: target, status: "failed", error: errorText(error) }
    : { path: target, status: "failed", error: errorText(error), code };
}

function endsWithSeparator(target: string): boolean {
  return target.endsWith("/") || target.endsWith(path.sep);
}

async function removeEntry(
  target: string,
  isSymlink: boolean,
  isDirectory: boolean,
): Promise<void> {
  try {
    await fs.rm(target, { recursive: true });
  } catch (error) {
    const code = errorCode(error);
    // chmod follows links, so a symlink is never chmodded: only a real entry is made writable.
    if ((code !== "EPERM" && code !== "EACCES") || isSymlink) {
      throw error;
    }
    // Covers the Windows read-only attribute: make the entry owner-writable once and retry.
    await fs.chmod(target, isDirectory ? 0o700 : 0o600);
    await fs.rm(target, { recursive: true });
  }
}

/**
 * Removes one path without ever following a symlink. A symlink is unlinked and its final target
 * is reported in `linkTarget` and left in place; a file or directory is removed recursively.
 * Never throws: failures are returned as `failed` with the error text.
 *
 * Precondition: callers pass only `listAppHomeTargets` output, that is direct children of the app
 * home. A target ending in a path separator is rejected because `link/` would make lstat follow
 * the link.
 */
export async function removePath(target: string): Promise<RemoveResult> {
  if (endsWithSeparator(target)) {
    return {
      path: target,
      status: "failed",
      error: "Refusing a path that ends with a separator",
    };
  }

  let isSymlink: boolean;
  let isDirectory: boolean;
  try {
    const stats = await fs.lstat(target);
    isSymlink = stats.isSymbolicLink();
    isDirectory = stats.isDirectory();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { path: target, status: "absent" };
    }
    return failed(target, error);
  }

  let linkTarget: string | undefined;
  if (isSymlink) {
    try {
      linkTarget = await resolveSymlinkTarget(target);
    } catch {
      // An unresolvable link is still only unlinked, never followed.
      linkTarget = undefined;
    }
  }

  try {
    await removeEntry(target, isSymlink, isDirectory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { path: target, status: "absent" };
    }
    return failed(target, error);
  }

  return linkTarget === undefined
    ? { path: target, status: "removed" }
    : { path: target, status: "removed", linkTarget };
}

function homeFailure(error: unknown): { homeError: string; homeErrorCode?: string } {
  const code = errorCode(error);
  return code === undefined
    ? { homeError: errorText(error) }
    : { homeError: errorText(error), homeErrorCode: code };
}

async function removeHomeIfEmpty(
  appHome: string,
): Promise<{ homeRemoved: boolean; homeError?: string; homeErrorCode?: string }> {
  try {
    // A symlinked home is never removed or followed.
    if (!(await fs.lstat(appHome)).isDirectory()) {
      return { homeRemoved: false };
    }
    if ((await fs.readdir(appHome)).length > 0) {
      return { homeRemoved: false };
    }
    // rmdir fails on a non-empty directory, so a file created meanwhile is never lost.
    await fs.rmdir(appHome);
    return { homeRemoved: true };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ENOTEMPTY" || code === "EEXIST") {
      return { homeRemoved: false };
    }
    return { homeRemoved: false, ...homeFailure(error) };
  }
}

/**
 * Removes the stored-data inventory from an app home, keeping logs and every unknown entry,
 * then removes the home directory only when nothing is left in it. Never throws.
 */
export async function removeAppHomeData(appHome: string): Promise<RemoveAppHomeResult> {
  let targets: string[];
  try {
    targets = await listAppHomeTargets(appHome);
  } catch (error) {
    return { results: [], homeRemoved: false, ...homeFailure(error) };
  }

  const results: RemoveResult[] = [];
  for (const target of targets) {
    results.push(await removePath(target));
  }
  return { results, ...(await removeHomeIfEmpty(appHome)) };
}
