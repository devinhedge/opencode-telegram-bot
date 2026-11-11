import { describe, expect, it } from "vitest";
import { readLocalOpencodeVersion, getOpencodeApiVersion, parseOpencodeVersionOutput } from "../../src/opencode/process.js";
import { detectOpencodeVersion } from "../../src/config.js";

describe("OpenCode version sensing (real detection)", () => {
  it("readLocalOpencodeVersion returns a real version string", async () => {
    const version = await readLocalOpencodeVersion();
    // On this machine, opencode should be installed
    expect(version).not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("getOpencodeApiVersion maps real version to v1 or v2", async () => {
    const version = await readLocalOpencodeVersion();
    if (version) {
      const apiVersion = getOpencodeApiVersion(version);
      expect(["v1", "v2"]).toContain(apiVersion);
      // OpenCode 2.x → v2
      const major = parseInt(version.split(".")[0], 10);
      expect(apiVersion).toBe(major >= 2 ? "v2" : "v1");
    }
  });

  it("detectOpencodeVersion returns detected version from real opencode", async () => {
    const detected = await detectOpencodeVersion();
    expect(["v1", "v2"]).toContain(detected);
  });

  it("getOpencodeApiVersion handles edge cases", () => {
    expect(getOpencodeApiVersion("2.0.0")).toBe("v2");
    expect(getOpencodeApiVersion("1.0.0")).toBe("v1");
    expect(getOpencodeApiVersion("0.5.0")).toBe("v1");
    expect(getOpencodeApiVersion("3.0.0")).toBe("v2");
    expect(getOpencodeApiVersion("")).toBe("v1"); // NaN → v1
  });

  it("parseOpencodeVersionOutput handles various formats", () => {
    // These are boundary tests for the parser
    expect(parseOpencodeVersionOutput("opencode 2.2.7")).toBe("2.2.7");
    expect(parseOpencodeVersionOutput("2.2.7")).toBe("2.2.7");
    expect(parseOpencodeVersionOutput("v2.2.7")).toBe("2.2.7");
    expect(parseOpencodeVersionOutput("")).toBeNull();
    expect(parseOpencodeVersionOutput("no version here")).toBeNull();
  });
});