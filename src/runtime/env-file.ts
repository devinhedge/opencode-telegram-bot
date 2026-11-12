import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reopenEnvFileForEdit } from "../secrets/file-permissions.js";

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // A unique name per call keeps concurrent writers (and a stale file of an earlier crash) from
  // touching each other's temp file.
  const tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Owner-only from creation: the content may hold secrets and must never be group or
    // other readable, even briefly. The wx flag guarantees the file is new, so the mode applies.
    await fs.writeFile(tempFilePath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
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

const MAX_LINK_DEPTH = 40;

/**
 * Returns the path a write must go to so a symlink is kept and its target is updated: the real
 * path of an existing file, the final target of a dangling link (a chain of links is followed,
 * relative targets resolve against the link's directory), or the path itself when nothing is
 * there. Other errors, such as a link loop, propagate.
 */
export async function resolveSymlinkTarget(filePath: string): Promise<string> {
  let current = filePath;

  for (let depth = 0; depth < MAX_LINK_DEPTH; depth += 1) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return current;
      }
      throw error;
    }

    if (!stats.isSymbolicLink()) {
      return current;
    }

    // A relative target resolves against the physical directory of the link: a parent that is
    // itself a symlink changes what `..` means. The lexical directory is the fallback.
    const lexicalDir = path.dirname(current);
    const physicalDir = await fs.realpath(lexicalDir).catch(() => lexicalDir);
    current = path.resolve(physicalDir, await fs.readlink(current));
  }

  throw new Error(`Too many levels of symbolic links: ${filePath}`);
}

async function restoreMode(filePath: string, mode: number | undefined): Promise<void> {
  if (mode !== undefined) {
    await fs.chmod(filePath, mode);
  }
}

/**
 * Replaces the whole content of an env file atomically. A missing file is created 0600; the mode
 * of an existing file is kept, including a read-only one (also when the write fails). A symlink
 * is followed: the target is replaced and the link stays.
 */
export async function replaceEnvFile(filePath: string, content: string): Promise<void> {
  const targetPath = await resolveSymlinkTarget(filePath);
  const previousMode = await readExistingMode(targetPath);
  if (previousMode !== undefined && (previousMode & 0o200) === 0) {
    // Renaming over a read-only file fails on Windows, so open it for the update first.
    await reopenEnvFileForEdit(targetPath);
  }

  try {
    await writeFileAtomically(targetPath, content);
  } catch (error) {
    await restoreMode(targetPath, previousMode).catch(() => undefined);
    throw error;
  }

  // The replacement is already in place and owner-only (0600), so a failed restore of the previous
  // mode must not fail the call: callers would treat a completed replacement as failed. This module
  // runs before the logger exists and cannot report it.
  await restoreMode(targetPath, previousMode).catch(() => undefined);
}

/**
 * Sets `key=value` in the .env file. The first active assignment of the key is replaced in place
 * (its indentation and `export` prefix are kept), later duplicate active assignments are
 * dropped, and the key is appended when absent. Every other line and the line-ending style are
 * kept. The file is not touched when the result equals its content. Creates the file (0600)
 * when missing; the mode of an existing file is preserved, including a read-only one.
 */
export async function persistEnvValue(
  envFilePath: string,
  key: string,
  value: string,
): Promise<void> {
  const existingContent = await readExistingEnvContent(envFilePath);
  const lineEnding = existingContent.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `${key}=${value}`;

  const existingLines =
    existingContent === "" ? [] : existingContent.replace(/\r?\n$/, "").split(/\r?\n/);
  const hasAssignment = existingLines.some((line) => isActiveAssignmentOf(line, key));

  let nextLines: string[];
  if (hasAssignment) {
    let replaced = false;
    nextLines = [];
    for (const line of existingLines) {
      if (!isActiveAssignmentOf(line, key)) {
        nextLines.push(line);
      } else if (!replaced) {
        // Keep the indentation and the export prefix, so a shell sourcing the file still
        // exports the key.
        const prefix = line.match(/^\s*(?:export\s+)?/)?.[0] ?? "";
        nextLines.push(`${prefix}${assignment}`);
        replaced = true;
      }
    }
  } else {
    nextLines = [...existingLines];
    while (nextLines.at(-1)?.trim() === "") {
      nextLines.pop();
    }
    nextLines.push(assignment);
  }

  const nextContent = `${nextLines.join(lineEnding)}${lineEnding}`;
  if (nextContent === existingContent) {
    return;
  }

  await replaceEnvFile(envFilePath, nextContent);
}
