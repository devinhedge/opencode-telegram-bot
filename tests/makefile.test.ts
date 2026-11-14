import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowRealProcesses } from "./helpers/process-guard.js";

// make runs only as a dry run (-n, prints the recipe) or the help target (prints text), so no
// npm command ever executes and nothing outside the test is touched.
allowRealProcesses("runs make as a dry run or the print-only help target");

const PROJECT_ROOT = path.resolve(__dirname, "..");

interface MakeOptions {
  cwd?: string;
  path?: string;
}

function runMake(
  args: string[],
  options: MakeOptions = {},
): { status: number | null; output: string } {
  const result = spawnSync("make", args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: "utf8",
    env: { PATH: options.path ?? process.env.PATH ?? "" },
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

    it("behaves the same from another directory", () => {
      // --no-print-directory: GNU Make 4 prints "Entering directory" under -C, Make 3.81 does not.
      const result = runMake(["-C", PROJECT_ROOT, "--no-print-directory", "help"], {
        cwd: os.tmpdir(),
      });

      expect(result.status).toBe(0);
      expect(result.output).toBe(runMake([]).output);
    });

    it("fails on an unknown target without running anything", () => {
      const result = runMake(["nope"]);

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/No rule to make target/);
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

    it.each([
      ["empty", ""],
      ["not a number", "abc"],
    ])("refuses when the user id is %s", (_label, value) => {
      const result = runMake(["-n", "install", `CURRENT_UID=${value}`]);

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/cannot determine the user id/);
      expect(result.output).not.toMatch(/npm /);
    });

    it("behaves the same from another directory", () => {
      const result = runMake(
        ["-C", PROJECT_ROOT, "--no-print-directory", "-n", "install", "CURRENT_UID=1000"],
        {
          cwd: os.tmpdir(),
        },
      );

      const lines = result.output.split("\n").map((line) => line.trim());
      expect(result.status).toBe(0);
      expect(lines.filter((line) => line.startsWith("npm "))).toEqual([
        "npm ci",
        "npm run build",
        "npm link",
      ]);
    });

    describe("with a fake npm", () => {
      let fakeBin: string;

      beforeEach(() => {
        fakeBin = mkdtempSync(path.join(os.tmpdir(), "make-install-fake-npm-"));
        const script = [
          "#!/bin/sh",
          `echo "$@" >> "${path.join(fakeBin, "calls.log")}"`,
          '[ "$1" = "run" ] && exit 1',
          "exit 0",
          "",
        ].join("\n");
        writeFileSync(path.join(fakeBin, "npm"), script, { mode: 0o755 });
      });

      afterEach(() => {
        rmSync(fakeBin, { recursive: true, force: true });
      });

      it("stops at the first failing step and never links", () => {
        const result = runMake(["install", "CURRENT_UID=1000"], {
          path: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        });

        expect(result.status).not.toBe(0);
        expect(readFileSync(path.join(fakeBin, "calls.log"), "utf8").trim().split("\n")).toEqual([
          "ci",
          "run build",
        ]);
      });
    });
  });
});
