import fs from "node:fs/promises";
import * as path from "node:path";
import type { QueuedPrompt } from "../../app/managers/prompt-queue-manager.js";

export type { QueuedPrompt };

export interface RestartQueueState {
  version: number;
  savedAt: string;
  sessionDirectory: string;
  sessionId: string;
  queuedPrompts: QueuedPrompt[];
  inboxPrompts: QueuedPrompt[];
}

const RESTART_QUEUE_VERSION = 1;

export async function saveRestartQueue(state: RestartQueueState, filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  const content = JSON.stringify(state, null, 2);
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}

export async function loadRestartQueue(filePath: string): Promise<RestartQueueState | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    if (parsed.version !== RESTART_QUEUE_VERSION) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    if (!parsed.savedAt || !parsed.sessionDirectory || !parsed.sessionId ||
        !Array.isArray(parsed.queuedPrompts) || !Array.isArray(parsed.inboxPrompts)) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    await fs.unlink(filePath).catch(() => {});
    return parsed as RestartQueueState;
  } catch {
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore
    }
    return null;
  }
}

export async function clearRestartQueue(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore if file doesn't exist
  }
}