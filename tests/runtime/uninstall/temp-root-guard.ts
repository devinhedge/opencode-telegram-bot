import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isUnder(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return target;
  }
}

function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real location of `target`: the realpath of the nearest existing ancestor of its parent,
 * joined with the rest, so an ancestor that is a symlink (for example into the real home) is
 * resolved even when the target does not exist yet. The target itself is not followed: removing
 * a symlink acts on the link, which lives in the parent. Null (fail closed) when that ancestor
 * cannot be resolved, for example a dangling symlink.
 */
function realLocation(target: string): string | null {
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

/**
 * Throws unless `target` lies strictly inside the temp directory and outside the real user home
 * (taken from the password database, so a stubbed HOME cannot hide it), both lexically and after
 * resolving the nearest existing ancestor. Every fake in the uninstall tests that reaches the
 * filesystem calls this first, so a wiring mistake fails the test instead of touching the
 * developer's data.
 */
export function assertInsideTempRoot(target: string, root: string = os.tmpdir()): void {
  const resolved = path.resolve(target);
  const roots = [path.resolve(root), realpathOrSelf(path.resolve(root))];
  const realHome = os.userInfo().homedir;
  const real = realLocation(resolved);
  if (real === null || !isAllowed(resolved, roots, realHome) || !isAllowed(real, roots, realHome)) {
    throw new Error(`Test touched a path outside the temp root: ${resolved}`);
  }
}
