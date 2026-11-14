import { describe, expect, it, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { allowRealProcesses, resetProcessGuard } from "./process-guard.js";

describe("process guard", () => {
  afterEach(() => {
    resetProcessGuard();
  });

  it.each([
    ["spawn", () => childProcess.spawn("node", ["--version"])],
    ["spawnSync", () => childProcess.spawnSync("node", ["--version"])],
    ["exec", () => childProcess.exec("node --version")],
    ["execSync", () => childProcess.execSync("node --version")],
    ["execFile", () => childProcess.execFile("node", ["--version"])],
    ["execFileSync", () => childProcess.execFileSync("node", ["--version"])],
    ["fork", () => childProcess.fork("nonexistent.js")],
  ])("refuses %s by default", (name, start) => {
    expect(start).toThrow(new RegExp(`child_process\\.${name}`));
  });

  it("refuses the promisified execFile by default", () => {
    expect(() => promisify(childProcess.execFile)("node", ["--version"])).toThrow(/execFile/);
  });

  it("allows a real process after an opt-in with a reason", () => {
    allowRealProcesses("verifies the guard itself");

    const result = childProcess.spawnSync(process.execPath, ["--version"]);

    expect(result.status).toBe(0);
  });

  it("rejects an opt-in without a reason", () => {
    expect(() => allowRealProcesses("  ")).toThrow(/reason/);
  });

  it("refuses again after the opt-in is reset", () => {
    allowRealProcesses("temporary");
    resetProcessGuard();

    expect(() => childProcess.spawnSync("node", ["--version"])).toThrow(/spawnSync/);
  });
});
