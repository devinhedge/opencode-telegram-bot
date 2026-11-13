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
 * The real location of `target`: the realpath of its nearest existing ancestor joined with the
 * rest, so an ancestor that is a symlink (for example into the real home) is resolved even when
 * the target itself does not exist yet.
 */
function realLocation(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!exists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return target;
    }
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathOrSelf(existing), ...rest);
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
  if (
    !isAllowed(resolved, roots, realHome) ||
    !isAllowed(realLocation(resolved), roots, realHome)
  ) {
    throw new Error(`Test touched a path outside the temp root: ${resolved}`);
  }
}
