// Hermetic-test guard: no test may start a real process unless it opts in.
//
// tests/setup.ts replaces every spawn entry point of node:child_process with a wrapper built by
// `guardChildProcess`. A test that needs a real process (an end-to-end run, a FIFO made in its
// own temp directory) calls `allowRealProcesses(reason)` at the top of its file; the opt-in lasts
// for that file only because each test file gets a fresh module graph. A test file that mocks
// node:child_process itself replaces this wrapper and is unaffected.

const GUARDED_FUNCTIONS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom");

type AnyFunction = (...args: unknown[]) => unknown;
type ChildProcessModule = typeof import("node:child_process");

let allowedReason: string | null = null;

export function allowRealProcesses(reason: string): void {
  if (reason.trim() === "") {
    throw new Error("allowRealProcesses requires a reason");
  }
  allowedReason = reason;
}

export function resetProcessGuard(): void {
  allowedReason = null;
}

function assertAllowed(name: string): void {
  if (allowedReason === null) {
    throw new Error(
      `Test started a real process with child_process.${name}. ` +
        "Mock node:child_process in the test, or call allowRealProcesses(reason) from " +
        "tests/helpers/process-guard.ts when the real process is the thing under test.",
    );
  }
}

function guardFunction(name: string, original: AnyFunction): AnyFunction {
  const guarded: AnyFunction = (...args) => {
    assertAllowed(name);
    return original(...args);
  };

  // exec and execFile carry a custom promisify implementation; keep it guarded too
  const custom = (original as unknown as Record<symbol, AnyFunction | undefined>)[PROMISIFY_CUSTOM];
  if (custom !== undefined) {
    (guarded as unknown as Record<symbol, AnyFunction>)[PROMISIFY_CUSTOM] = (...args) => {
      assertAllowed(name);
      return custom(...args);
    };
  }

  return guarded;
}

export function guardChildProcess(actual: ChildProcessModule): ChildProcessModule {
  const guarded: Record<string, unknown> = { ...actual };
  for (const name of GUARDED_FUNCTIONS) {
    guarded[name] = guardFunction(name, actual[name] as unknown as AnyFunction);
  }
  return { ...guarded, default: guarded } as unknown as ChildProcessModule;
}
