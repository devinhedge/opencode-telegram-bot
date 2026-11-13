import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PROJECT_ROOT = resolve(__dirname, "../..");

export interface E2eBuild {
  /** Temporary package root that mimics the installed layout. */
  buildRoot: string;
  /** Directory with the compiled code (`<buildRoot>/dist`). */
  outDir: string;
  /** Removes the temporary package root. */
  cleanup(): void;
}

/**
 * Builds the project with tsc into a temporary directory so a test never writes into the
 * repository (the repo dist/ may also be stale). The temporary root mimics the package layout the
 * compiled code expects: dist/ for the code, package.json and .env.example one level above it
 * (read relative to the compiled files), and node_modules for dependency resolution. On Windows
 * the node_modules link is a junction, which needs no elevated privileges.
 */
export function buildProjectToTempDir(prefix: string): E2eBuild {
  const buildRoot = mkdtempSync(join(tmpdir(), prefix));
  const outDir = join(buildRoot, "dist");
  const tsc = join(PROJECT_ROOT, "node_modules", "typescript", "bin", "tsc");
  const build = spawnSync(
    process.execPath,
    [tsc, "-p", join(PROJECT_ROOT, "tsconfig.json"), "--outDir", outDir],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
  if (build.status !== 0) {
    rmSync(buildRoot, { recursive: true, force: true });
    throw new Error(`tsc build failed:\n${build.stdout}\n${build.stderr}`);
  }

  copyFileSync(join(PROJECT_ROOT, "package.json"), join(buildRoot, "package.json"));
  copyFileSync(join(PROJECT_ROOT, ".env.example"), join(buildRoot, ".env.example"));
  symlinkSync(
    join(PROJECT_ROOT, "node_modules"),
    join(buildRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  return {
    buildRoot,
    outDir,
    cleanup: () => rmSync(buildRoot, { recursive: true, force: true }),
  };
}
