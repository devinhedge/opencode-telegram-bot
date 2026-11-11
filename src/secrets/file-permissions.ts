import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Sets restrictive permissions (0600) on the .env file for writing/editing.
 * Creates parent directories if they don't exist.
 * If content is provided, writes it to the file.
 * If content is not provided, preserves existing file content.
 *
 * @param envFilePath - Path to the .env file
 * @param content - Optional content to write to the file
 */
export async function hardenEnvFile(envFilePath: string, content?: string): Promise<void> {
  await fs.mkdir(dirname(envFilePath), { recursive: true });
  if (content !== undefined) {
    await fs.writeFile(envFilePath, content, "utf8");
  } else {
    // Preserve existing content if file exists
    try {
      await fs.access(envFilePath, fs.constants.F_OK);
      // File exists, just chmod it
    } catch {
      // File doesn't exist, create empty
      await fs.writeFile(envFilePath, "", "utf8");
    }
  }
  // 0600 = owner read/write only
  await fs.chmod(envFilePath, 0o600);
}

/**
 * Reopens the .env file for editing by setting permissions to 0600.
 * This is used after finalizeEnvFile() has set the file to 0400,
 * or when the file needs to be modified.
 *
 * @param envFilePath - Path to the .env file
 */
export async function reopenEnvFileForEdit(envFilePath: string): Promise<void> {
  await fs.mkdir(dirname(envFilePath), { recursive: true });
  // Ensure file exists
  try {
    await fs.access(envFilePath, fs.constants.F_OK);
  } catch {
    await fs.writeFile(envFilePath, "", "utf8");
  }
  // 0600 = owner read/write
  await fs.chmod(envFilePath, 0o600);
}

/**
 * Finalizes the .env file after wizard completion by setting permissions to 0400.
 * This makes the file read-only for the owner, preventing accidental modifications.
 *
 * @param envFilePath - Path to the .env file
 * @throws Error if the file does not exist
 */
export async function finalizeEnvFile(envFilePath: string): Promise<void> {
  try {
    await fs.access(envFilePath, fs.constants.F_OK);
  } catch {
    throw new Error(`Cannot finalize: file does not exist at ${envFilePath}`);
  }
  // 0400 = owner read only
  await fs.chmod(envFilePath, 0o400);
}