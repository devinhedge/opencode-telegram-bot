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
    options: unknown,
  ) => execFileMock(file, args, options);
  return { execFileMock };
});

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: execFileMock,
}));

import * as processControl from "../../src/opencode/process-control.js";
import * as processModule from "../../src/opencode/process.js";
import * as configModule from "../../src/config.js";
import type { OpencodeServerVersion } from "../../src/config.js";

const { DEFAULT_OPENCODE_API_URLS, getProcessCommandLine } = processControl;

const sourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/opencode/process-control.ts",
);

describe("opencode/process-control", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  describe("getProcessCommandLine", () => {
    it.skipIf(process.platform === "win32")("returns the trimmed ps output", async () => {
      execFileMock.mockResolvedValue({ stdout: "  opencode serve --port 4096\n", stderr: "" });

      await expect(getProcessCommandLine(123)).resolves.toBe("opencode serve --port 4096");
      expect(execFileMock).toHaveBeenCalledWith("ps", ["-o", "args=", "-p", "123"], {
        timeout: 5000,
      });
    });

    it.skipIf(process.platform === "win32")("returns null when ps fails", async () => {
      execFileMock.mockRejectedValue(new Error("no such process"));

      await expect(getProcessCommandLine(123)).resolves.toBeNull();
    });

    it.skipIf(process.platform === "win32")("returns null when ps times out", async () => {
      execFileMock.mockRejectedValue(Object.assign(new Error("timed out"), { killed: true }));

      await expect(getProcessCommandLine(123)).resolves.toBeNull();
    });

    it.skipIf(process.platform === "win32")("returns null on empty output", async () => {
      execFileMock.mockResolvedValue({ stdout: " \n", stderr: "" });

      await expect(getProcessCommandLine(123)).resolves.toBeNull();
    });

    it.each([Number.NaN, 0, -1, 1.5])(
      "returns null for pid %s without spawning ps",
      async (pid) => {
        await expect(getProcessCommandLine(pid)).resolves.toBeNull();
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );

    it.skipIf(process.platform !== "win32")(
      "returns null on Windows without spawning ps",
      async () => {
        await expect(getProcessCommandLine(123)).resolves.toBeNull();
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );
  });

  it("owns the default API URLs", () => {
    expect(DEFAULT_OPENCODE_API_URLS).toEqual({
      v1: "http://localhost:4096",
      v2: "http://127.0.0.1:49374",
    });
  });

  it("does not import config.js or config.ts", () => {
    const source = readFileSync(sourcePath, "utf8");
    const configSpecifier = String.raw`["'][^"']*\/config(?:\.js|\.ts)?["']`;
    const patterns = [
      new RegExp(String.raw`\bfrom\s+${configSpecifier}`),
      new RegExp(String.raw`\bimport\s+${configSpecifier}`),
      new RegExp(String.raw`\bimport\s*\(\s*${configSpecifier}`),
    ];

    for (const pattern of patterns) {
      expect(source).not.toMatch(pattern);
    }
  });

  describe("re-exports", () => {
    it("process.ts re-exports the same references as process-control.ts", () => {
      const names = [
        "DEFAULT_OPENCODE_API_URLS",
        "findServerPid",
        "findUnixListeningPidInSs",
        "findWindowsListeningPidInNetstat",
        "getProcessCommandLine",
        "killServerProcess",
        "resolveLocalOpencodeTarget",
      ] as const;

      for (const name of names) {
        expect(processModule[name]).toBe(processControl[name]);
      }
    });

    it("config.ts still exports OpencodeServerVersion", () => {
      const version: OpencodeServerVersion = "v2";
      expect(version).toBe("v2");
      expect(configModule.resolveOpencodeApiUrl("v1", "service")).toBe(
        DEFAULT_OPENCODE_API_URLS.v1,
      );
    });
  });
});
