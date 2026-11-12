import fs from "node:fs/promises";
import { vi, type MockInstance } from "vitest";

/**
 * Simulates, on any OS, the Windows behavior where renaming over a read-only destination fails
 * with EPERM. The real failure can only be proven on Windows; this guard makes the same
 * condition observable through the owner-write bit, which only POSIX modes expose reliably, so
 * tests that assert on it are skipped on win32.
 *
 * `node:fs/promises` and `fs.promises` are the same object, so the spy covers code importing
 * either form.
 */
export function simulateWindowsReadOnlyRenameFailure(): MockInstance {
  const realRename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    let destinationMode: number | undefined;
    try {
      destinationMode = (await fs.stat(destination)).mode;
    } catch {
      destinationMode = undefined;
    }

    if (destinationMode !== undefined && (destinationMode & 0o200) === 0) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(source)}'`), {
        code: "EPERM",
      });
    }

    return realRename(source, destination);
  });
}
