import fs from "node:fs/promises";
import path from "node:path";
import { finalizeEnvFile } from "../secrets/file-permissions.js";

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempFilePath, content, "utf-8");
  await fs.rename(tempFilePath, filePath);
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

/**
 * Sets `key=value` in the .env file, replacing any active assignment of the key
 * and keeping every other line. Creates the file when missing.
 */
export async function persistEnvValue(
  envFilePath: string,
  key: string,
  value: string,
): Promise<void> {
  const existingContent = await readExistingEnvContent(envFilePath);
  const assignmentPrefix = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);

  const existingLines =
    existingContent === "" ? [] : existingContent.replace(/\r?\n$/, "").split(/\r?\n/);
  const keptLines = existingLines.filter((line) => !assignmentPrefix.test(line));

  const nextContent = `${[...keptLines, `${key}=${value}`].join("\n")}\n`;

  await writeFileAtomically(envFilePath, nextContent);
  await finalizeEnvFile(envFilePath);
}
