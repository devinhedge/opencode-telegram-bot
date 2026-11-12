import fs from "node:fs/promises";
import path from "node:path";
import { reopenEnvFileForEdit } from "../secrets/file-permissions.js";

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.${process.pid}.tmp`;
  try {
    // Owner-only from creation: the content may hold secrets and must never be group or
    // other readable, even briefly.
    await fs.writeFile(tempFilePath, content, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tempFilePath, filePath);
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isActiveAssignmentOf(line: string, key: string): boolean {
  const withoutExport = line.replace(/^\s*export\s+/, "");
  const separatorIndex = withoutExport.indexOf("=");
  return separatorIndex !== -1 && withoutExport.slice(0, separatorIndex).trim() === key;
}

async function readExistingEnvContent(envFilePath: string): Promise<string> {
  try {
    return await fs.readFile(envFilePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function readExistingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function restoreMode(filePath: string, mode: number | undefined): Promise<void> {
  if (mode !== undefined) {
    await fs.chmod(filePath, mode);
  }
}

/**
 * Sets `key=value` in the .env file, replacing any active assignment of the key
 * and keeping every other line. Creates the file (0600) when missing; the mode of
 * an existing file is preserved, including a read-only one.
 */
export async function persistEnvValue(
  envFilePath: string,
  key: string,
  value: string,
): Promise<void> {
  const existingContent = await readExistingEnvContent(envFilePath);
  const lineEnding = existingContent.includes("\r\n") ? "\r\n" : "\n";

  const existingLines =
    existingContent === "" ? [] : existingContent.replace(/\r?\n$/, "").split(/\r?\n/);
  const keptLines = existingLines.filter((line) => !isActiveAssignmentOf(line, key));
  while (keptLines.at(-1)?.trim() === "") {
    keptLines.pop();
  }

  const nextContent = `${[...keptLines, `${key}=${value}`].join(lineEnding)}${lineEnding}`;

  const previousMode = await readExistingMode(envFilePath);
  if (previousMode !== undefined && (previousMode & 0o200) === 0) {
    // Renaming over a read-only file fails on Windows, so open it for the update first.
    await reopenEnvFileForEdit(envFilePath);
  }

  try {
    await writeFileAtomically(envFilePath, nextContent);
  } catch (error) {
    await restoreMode(envFilePath, previousMode).catch(() => undefined);
    throw error;
  }

  await restoreMode(envFilePath, previousMode);
}
