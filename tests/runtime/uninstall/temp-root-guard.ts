import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** True when `target` is `root` or lies below it (lexical; no symlink resolution). */
export function isUnder(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  );
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return target;
  }
}

/** True when an entry exists at `target` (lstat, so a dangling symlink counts). */
export function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real location of `target`. With `followTarget` an existing target is resolved itself (a
 * home or directory acted on through a symlink lands where the link points). Without it the
 * target is not followed (unlinking acts on the link, which lives in its parent) and only its
 * parent chain is resolved. A missing target resolves through its nearest existing ancestor, so
 * an ancestor symlink (for example into the real home) is caught. Null (fail closed) when the
 * entry to resolve cannot be resolved, for example a dangling symlink.
 */
function realLocation(target: string, followTarget: boolean): string | null {
  if (followTarget && exists(target)) {
    try {
      return realpathSync.native(target);
    } catch {
      return null;
    }
  }
  let existing = path.dirname(target);
  const rest: string[] = [path.basename(target)];
  while (!exists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return null;
    }
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(realpathSync.native(existing), ...rest);
  } catch {
    return null;
  }
}

function isAllowed(target: string, roots: readonly string[], realHome: string): boolean {
  const inside = roots.some((base) => isUnder(target, base) && target !== base);
  const rootsInHome = roots.some((base) => isUnder(base, realHome));
  return inside && (rootsInHome || !isUnder(target, realHome));
}

export interface GuardOptions {
  /**
   * Resolve the target itself (default). Pass false only for an operation that unlinks the entry
   * itself (removePath); every fake acting through a directory or home keeps the default.
   */
  followTarget?: boolean;
}

/**
 * Throws unless `target` lies strictly inside the temp directory and outside the real user home
 * (taken from the password database, so a stubbed HOME cannot hide it), both lexically and after
 * resolution (see realLocation). Every fake in the uninstall tests that reaches the filesystem
 * calls this first, so a wiring mistake fails the test instead of touching the developer's data.
 */
export function assertInsideTempRoot(
  target: string,
  root: string = os.tmpdir(),
  options: GuardOptions = {},
): void {
  const resolved = path.resolve(target);
  const roots = [path.resolve(root), realpathOrSelf(path.resolve(root))];
  const realHome = os.userInfo().homedir;
  const real = realLocation(resolved, options.followTarget ?? true);
  if (real === null || !isAllowed(resolved, roots, realHome) || !isAllowed(real, roots, realHome)) {
    throw new Error(`Test touched a path outside the temp root: ${resolved}`);
  }
}
