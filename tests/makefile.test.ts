import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowRealProcesses } from "./helpers/process-guard.js";

// make runs only as a dry run (-n, prints the recipe) or the help target (prints text), so no
// npm command ever executes and nothing outside the test is touched.
allowRealProcesses("runs make as a dry run or the print-only help target");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function runMake(args: string[]): { status: number | null; output: string } {
  const result = spawnSync("make", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(process.platform === "win32")("Makefile", () => {
  describe("help", () => {
    it("is the default target and lists install and help", () => {
      const result = runMake([]);

      expect(result.status).toBe(0);
      expect(result.output).toMatch(/^\s*install\s+\S/m);
      expect(result.output).toMatch(/^\s*help\s+\S/m);
    });

    it("prints the same text for an explicit help target", () => {
      expect(runMake(["help"]).output).toBe(runMake([]).output);
    });

    it("still works as root", () => {
      const result = runMake(["help", "CURRENT_UID=0"]);

      expect(result.status).toBe(0);
    });
  });

  describe("install", () => {
    it("installs dependencies, builds, and links the CLI, in that order", () => {
      const result = runMake(["-n", "install", "CURRENT_UID=1000"]);

      expect(result.status).toBe(0);
      const lines = result.output.split("\n").map((line) => line.trim());
      const steps = ["npm ci", "npm run build", "npm link"].map((step) => lines.indexOf(step));
      expect(steps.every((index) => index >= 0)).toBe(true);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    });

    it("never runs the config wizard", () => {
      const result = runMake(["-n", "install", "CURRENT_UID=1000"]);

      expect(result.output).not.toMatch(/opencode-telegram config/);
    });

    it("refuses to run as root before any npm command", () => {
      const result = runMake(["-n", "install", "CURRENT_UID=0"]);

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/must not run as root/);
      expect(result.output).not.toMatch(/npm /);
    });
  });
});
