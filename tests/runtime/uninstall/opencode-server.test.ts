import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findOpencodeServer,
  resolveOpencodePort,
  stopOpencodeServer,
} from "../../../src/runtime/uninstall/opencode-server.js";

describe("runtime/uninstall/opencode-server", () => {
  let tempDir: string;
  let envFilePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-server-test-"));
    envFilePath = path.join(tempDir, ".env");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveOpencodePort", () => {
    it("reads the port from OPENCODE_API_URL in the real environment", async () => {
      const port = await resolveOpencodePort(
        { OPENCODE_API_URL: "http://localhost:5000" },
        envFilePath,
      );

      expect(port).toBe(5000);
    });

    it("reads the port from .env when the environment lacks the URL", async () => {
      await writeFile(envFilePath, "OPENCODE_API_URL=http://127.0.0.1:6000\n");

      expect(await resolveOpencodePort({}, envFilePath)).toBe(6000);
    });

    it("lets the real environment win over .env", async () => {
      await writeFile(envFilePath, "OPENCODE_API_URL=http://127.0.0.1:6000\n");

      const port = await resolveOpencodePort(
        { OPENCODE_API_URL: "http://localhost:5000" },
        envFilePath,
      );

      expect(port).toBe(5000);
    });

    it("treats an empty environment value as unset", async () => {
      await writeFile(envFilePath, "OPENCODE_API_URL=http://127.0.0.1:6000\n");

      expect(await resolveOpencodePort({ OPENCODE_API_URL: "  " }, envFilePath)).toBe(6000);
    });

    it("uses the v1 default port when the URL is unset", async () => {
      expect(await resolveOpencodePort({}, envFilePath)).toBe(4096);
      expect(await resolveOpencodePort({ OPENCODE_SERVER_VERSION: "v1" }, envFilePath)).toBe(4096);
    });

    it("uses the v2 default port for OPENCODE_SERVER_VERSION=v2 from the environment", async () => {
      expect(await resolveOpencodePort({ OPENCODE_SERVER_VERSION: "v2" }, envFilePath)).toBe(49374);
    });

    it("uses the v2 default port for OPENCODE_SERVER_VERSION=v2 from .env", async () => {
      await writeFile(envFilePath, "OPENCODE_SERVER_VERSION=v2\n");

      expect(await resolveOpencodePort({}, envFilePath)).toBe(49374);
    });

    it("falls back to v1 for an unknown version", async () => {
      expect(await resolveOpencodePort({ OPENCODE_SERVER_VERSION: "v9" }, envFilePath)).toBe(4096);
    });

    it("returns null for a remote host", async () => {
      const port = await resolveOpencodePort(
        { OPENCODE_API_URL: "http://opencode.example.com:4096" },
        envFilePath,
      );

      expect(port).toBeNull();
    });

    it("returns null for a remote host in .env", async () => {
      await writeFile(envFilePath, "OPENCODE_API_URL=https://10.0.0.5:4096\n");

      expect(await resolveOpencodePort({}, envFilePath)).toBeNull();
    });

    it("returns null for an unparseable URL", async () => {
      expect(await resolveOpencodePort({ OPENCODE_API_URL: "not a url" }, envFilePath)).toBeNull();
    });
  });

  describe("findOpencodeServer", () => {
    it("returns the pid, port, and command line", async () => {
      const findPid = vi.fn().mockResolvedValue(4242);
      const commandLine = vi.fn().mockResolvedValue("opencode serve --port 4096");

      const server = await findOpencodeServer({ port: 4096, findPid, commandLine });

      expect(server).toEqual({ pid: 4242, port: 4096, commandLine: "opencode serve --port 4096" });
      expect(findPid).toHaveBeenCalledWith(4096);
      expect(commandLine).toHaveBeenCalledWith(4242);
    });

    it("keeps a null command line", async () => {
      const server = await findOpencodeServer({
        port: 4096,
        findPid: vi.fn().mockResolvedValue(7),
        commandLine: vi.fn().mockResolvedValue(null),
      });

      expect(server).toEqual({ pid: 7, port: 4096, commandLine: null });
    });

    it("returns null when no process listens on the port", async () => {
      const commandLine = vi.fn();

      const server = await findOpencodeServer({
        port: 4096,
        findPid: vi.fn().mockResolvedValue(null),
        commandLine,
      });

      expect(server).toBeNull();
      expect(commandLine).not.toHaveBeenCalled();
    });

    it("returns null without looking for a pid when there is no port", async () => {
      const findPid = vi.fn();

      const server = await findOpencodeServer({ port: null, findPid, commandLine: vi.fn() });

      expect(server).toBeNull();
      expect(findPid).not.toHaveBeenCalled();
    });
  });

  describe("stopOpencodeServer", () => {
    it("returns the kill result", async () => {
      const kill = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      expect(await stopOpencodeServer(11, kill)).toBe(true);
      expect(await stopOpencodeServer(12, kill)).toBe(false);
      expect(kill).toHaveBeenNthCalledWith(1, 11);
      expect(kill).toHaveBeenNthCalledWith(2, 12);
    });

    it("refuses a pid that is not a positive integer without killing", async () => {
      const kill = vi.fn().mockResolvedValue(true);

      expect(await stopOpencodeServer(0, kill)).toBe(false);
      expect(await stopOpencodeServer(-1, kill)).toBe(false);
      expect(await stopOpencodeServer(1.5, kill)).toBe(false);
      expect(await stopOpencodeServer(Number.NaN, kill)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    });
  });
});
