import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { saveRestartQueue, loadRestartQueue, clearRestartQueue, type RestartQueueState } from "../../../src/app/services/restart-queue-store.js";

describe("restart-queue-store", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "restart-queue-"));
    filePath = path.join(tempDir, "restart-queue.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips queued prompts including inbox", async () => {
    const state: RestartQueueState = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionDirectory: "/tmp/test",
      sessionId: "ses_123",
      queuedPrompts: [
        {
          id: "queued-1",
          text: "hello",
          fileParts: [],
          photos: [],
          displayText: "hello",
          mediaBytes: 0,
          responseMode: "text_only",
        },
      ],
      inboxPrompts: [
        {
          id: "queued-2",
          text: "",
          fileParts: [],
          photos: [],
          displayText: "inbox prompt",
          mediaBytes: 0,
          inbox: { sessionId: "ses_123", inboxId: "inbox-1", delivery: "queue" },
        },
      ],
    };

    await saveRestartQueue(state, filePath);
    const loaded = await loadRestartQueue(filePath);
    expect(loaded).toEqual(state);
    // file should be deleted after load
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("returns null when file does not exist", async () => {
    const loaded = await loadRestartQueue(filePath);
    expect(loaded).toBeNull();
  });

  it("returns null and deletes corrupt file", async () => {
    await fs.writeFile(filePath, "{ invalid json", "utf-8");
    const loaded = await loadRestartQueue(filePath);
    expect(loaded).toBeNull();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("returns null and deletes file with wrong version", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 999, savedAt: "now" }), "utf-8");
    const loaded = await loadRestartQueue(filePath);
    expect(loaded).toBeNull();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("returns null and deletes file missing required fields", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 1 }), "utf-8");
    const loaded = await loadRestartQueue(filePath);
    expect(loaded).toBeNull();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("clearRestartQueue deletes the file", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 1 }), "utf-8");
    await clearRestartQueue(filePath);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("clearRestartQueue is no-op when file does not exist", async () => {
    await clearRestartQueue(filePath);
    // should not throw
  });

  it("saves empty queue successfully", async () => {
    const state: RestartQueueState = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionDirectory: "/tmp/test",
      sessionId: "ses_123",
      queuedPrompts: [],
      inboxPrompts: [],
    };
    await saveRestartQueue(state, filePath);
    const loaded = await loadRestartQueue(filePath);
    expect(loaded).toEqual(state);
  });

  it("handles file IO errors gracefully on save", async () => {
    const state: RestartQueueState = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionDirectory: "/tmp/test",
      sessionId: "ses_123",
      queuedPrompts: [],
      inboxPrompts: [],
    };
    // Write to a path where the parent is a file (can't create subdirectory)
    const filePath = path.join(tempDir, "blocker");
    await fs.writeFile(filePath, "blocker", "utf-8");
    const badPath = path.join(filePath, "subdir", "file.json");
    await expect(saveRestartQueue(state, badPath)).rejects.toThrow();
  });

  it("atomic write leaves original intact on failure", async () => {
    const originalContent = JSON.stringify({ version: 1, savedAt: "old", queuedPrompts: [], inboxPrompts: [] });
    await fs.writeFile(filePath, originalContent, "utf-8");
    const state: RestartQueueState = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessionDirectory: "/tmp/test",
      sessionId: "ses_123",
      queuedPrompts: [],
      inboxPrompts: [],
    };
    // Fail the temp-file write; a read-only directory is not enforced on Windows.
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(saveRestartQueue(state, filePath)).rejects.toThrow("disk full");
    } finally {
      writeFileSpy.mockRestore();
    }
    // Original file should still exist
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe(originalContent);
  });
});