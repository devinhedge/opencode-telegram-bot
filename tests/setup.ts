import { afterAll, beforeEach, afterEach, vi } from "vitest";
import { ensureTestEnvironment, releaseTestUserHome } from "./helpers/test-environment.js";
import { resetSingletonState } from "./helpers/reset-singleton-state.js";

vi.mock("../src/runtime/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/paths.js")>();
  const { isolateRuntimePaths } = await import("./helpers/test-environment.js");
  return { ...actual, getRuntimePaths: () => isolateRuntimePaths(actual.getRuntimePaths()) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { guardChildProcess } = await import("./helpers/process-guard.js");
  return guardChildProcess(actual);
});

ensureTestEnvironment();

beforeEach(() => {
  ensureTestEnvironment();
  return resetSingletonState();
});

afterEach(async () => {
  await resetSingletonState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ensureTestEnvironment();
});

// Removes the temp user home only; the environment keeps pointing at it (never back at the real
// home) and each test file's setup re-points it at a fresh temp home.
afterAll(() => {
  releaseTestUserHome();
});
