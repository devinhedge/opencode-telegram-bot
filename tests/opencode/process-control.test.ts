import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const customPromisifySymbol = Symbol.for("nodejs.util.promisify.custom");
  (execFileMock as unknown as Record<symbol, unknown>)[customPromisifySymbol] = (
    file: string,
    args: string[],
  ) => execFileMock(file, args);
  return { execFileMock };
});

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: execFileMock,
}));

import {
  DEFAULT_OPENCODE_API_URLS,
  getProcessCommandLine,
} from "../../src/opencode/process-control.js";

describe("opencode/process-control", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  describe("getProcessCommandLine", () => {
    it("returns the trimmed ps output", async () => {
      execFileMock.mockResolvedValue({ stdout: "  opencode serve --port 4096\n", stderr: "" });

      await expect(getProcessCommandLine(123)).resolves.toBe("opencode serve --port 4096");
      expect(execFileMock).toHaveBeenCalledWith("ps", ["-o", "args=", "-p", "123"]);
    });

    it("returns null when ps fails", async () => {
      execFileMock.mockRejectedValue(new Error("no such process"));

      await expect(getProcessCommandLine(123)).resolves.toBeNull();
    });

    it("returns null on empty output", async () => {
      execFileMock.mockResolvedValue({ stdout: " \n", stderr: "" });

      await expect(getProcessCommandLine(123)).resolves.toBeNull();
    });
  });

  it("owns the default API URLs", () => {
    expect(DEFAULT_OPENCODE_API_URLS).toEqual({
      v1: "http://localhost:4096",
      v2: "http://127.0.0.1:49374",
    });
  });

  it("does not import config.js", () => {
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/opencode/process-control.ts",
    );
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toMatch(/from\s+["'][^"']*config\.js["']/);
  });
});
