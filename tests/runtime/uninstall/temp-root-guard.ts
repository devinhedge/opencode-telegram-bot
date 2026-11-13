import { realpathSync } from "node:fs";
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

/**
 * Throws unless `target` lies strictly inside the temp directory and outside the real user home
 * (taken from the password database, so a stubbed HOME cannot hide it). Every fake in the
 * uninstall tests that reaches the filesystem calls this first, so a wiring mistake fails the test
 * instead of touching the developer's data.
 */
export function assertInsideTempRoot(target: string, root: string = os.tmpdir()): void {
  const resolved = path.resolve(target);
  const roots = [path.resolve(root), realpathOrSelf(path.resolve(root))];
  const realHome = os.userInfo().homedir;
  const inside = roots.some((base) => isUnder(resolved, base) && resolved !== base);
  const inRealHome = roots.every((base) => !isUnder(base, realHome)) && isUnder(resolved, realHome);
  if (!inside || inRealHome) {
    throw new Error(`Test touched a path outside the temp root: ${resolved}`);
  }
}
