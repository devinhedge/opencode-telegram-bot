import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenEnvFile, reopenEnvFileForEdit, finalizeEnvFile } from "../../src/secrets/file-permissions.js";

describe("file-permissions", () => {
  let dir: string;
  let envFilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fp-"));
    envFilePath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hardenEnvFile sets 0600 on create", async () => {
    await hardenEnvFile(envFilePath);
    const stats = await stat(envFilePath);
    // 0600 = owner read/write only (octal 0o600 = decimal 384)
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("hardenEnvFile writes content with 0600", async () => {
    await hardenEnvFile(envFilePath, "TEST_KEY=test_value\n");
    const stats = await stat(envFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
    const content = await readFile(envFilePath, "utf8");
    expect(content).toBe("TEST_KEY=test_value\n");
  });

  it("reopenEnvFileForEdit sets 0600 for editing", async () => {
    await hardenEnvFile(envFilePath, "TEST_KEY=test_value\n");
    await reopenEnvFileForEdit(envFilePath);
    const stats = await stat(envFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
    // Should be able to write after reopening
    await writeFile(envFilePath, "TEST_KEY=new_value\n", "utf8");
    const content = await readFile(envFilePath, "utf8");
    expect(content).toBe("TEST_KEY=new_value\n");
  });

  it("finalizeEnvFile sets 0400 after wizard completion", async () => {
    await hardenEnvFile(envFilePath, "TEST_KEY=test_value\n");
    await finalizeEnvFile(envFilePath);
    const stats = await stat(envFilePath);
    // 0400 = owner read only (octal 0o400 = decimal 256)
    expect(stats.mode & 0o777).toBe(0o400);
  });

  it("finalizeEnvFile prevents writes", async () => {
    await hardenEnvFile(envFilePath, "TEST_KEY=test_value\n");
    await finalizeEnvFile(envFilePath);
    // After finalize, writing should fail (EACCES or EPERM depending on platform)
    await expect(writeFile(envFilePath, "TEST_KEY=new_value\n", "utf8")).rejects.toThrow();
  });

  it("recovery: reopen after finalize allows edits again", async () => {
    await hardenEnvFile(envFilePath, "TEST_KEY=test_value\n");
    await finalizeEnvFile(envFilePath);
    // Reopen for edit should work
    await reopenEnvFileForEdit(envFilePath);
    const stats = await stat(envFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
    // Should be able to write after reopening
    await writeFile(envFilePath, "TEST_KEY=recovered_value\n", "utf8");
    const content = await readFile(envFilePath, "utf8");
    expect(content).toBe("TEST_KEY=recovered_value\n");
  });

  it("hardenEnvFile creates parent directories if needed", async () => {
    const nestedPath = join(dir, "nested", "deep", ".env");
    await hardenEnvFile(nestedPath, "NESTED=value\n");
    const stats = await stat(nestedPath);
    expect(stats.mode & 0o777).toBe(0o600);
    const content = await readFile(nestedPath, "utf8");
    expect(content).toBe("NESTED=value\n");
  });

  it("hardenEnvFile on existing file preserves content and sets 0600", async () => {
    await writeFile(envFilePath, "EXISTING=value\n", "utf8");
    await chmod(envFilePath, 0o644); // World readable
    await hardenEnvFile(envFilePath);
    const stats = await stat(envFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
    const content = await readFile(envFilePath, "utf8");
    expect(content).toBe("EXISTING=value\n");
  });

  it("reopenEnvFileForEdit on non-existent file creates it with 0600", async () => {
    await reopenEnvFileForEdit(envFilePath);
    const stats = await stat(envFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("finalizeEnvFile on non-existent file throws", async () => {
    await expect(finalizeEnvFile(envFilePath)).rejects.toThrow();
  });
});