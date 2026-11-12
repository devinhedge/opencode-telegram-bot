import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";
import { resolveSymlinkTarget, writeFileAtomically } from "../runtime/env-file.js";
import type { SecretStore } from "./secret-store.js";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

interface FilePayload {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedFileSecretStore implements SecretStore {
  public readonly name = "encrypted-file";

  private readonly filePath: string;
  private salt: Buffer | null = null;
  private key: Buffer | null = null;
  private secrets: Map<string, string> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async unlock(password: string): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (raw !== null && process.platform !== "win32") {
      try {
        // Best effort: an older or hand-copied file may be group or other readable. The file
        // stays usable when this fails, so the failure is ignored. Tightening before the
        // password check is acceptable: the file only becomes more restrictive.
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // ignored
      }
    }

    if (raw === null) {
      this.salt = randomBytes(SALT_LENGTH);
      this.key = (await scryptAsync(password, this.salt, KEY_LENGTH)) as Buffer;
      this.secrets = new Map();
      return;
    }

    const payload = JSON.parse(raw) as FilePayload;
    const salt = Buffer.from(payload.salt, "base64");
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");

    const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

    this.salt = salt;
    this.key = key;
    this.secrets = new Map(Object.entries(JSON.parse(plaintext) as Record<string, string>));
  }

  private ensureUnlocked(): void {
    if (this.key === null || this.salt === null || this.secrets === null) {
      throw new Error("EncryptedFileSecretStore is locked");
    }
  }

  private async persist(): Promise<void> {
    this.ensureUnlocked();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key!, iv);
    const plaintext = JSON.stringify(Object.fromEntries(this.secrets!));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload: FilePayload = {
      salt: this.salt!.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };

    // Atomic replace through an owner-only temp file: the rename gives secrets.enc a fresh 0600
    // file (tightening a wider existing one), and a crash mid-write cannot truncate the secrets.
    // A symlinked secrets.enc keeps its link and the target is replaced.
    await writeFileAtomically(await resolveSymlinkTarget(this.filePath), JSON.stringify(payload));
  }

  async getSecret(account: string): Promise<string | null> {
    this.ensureUnlocked();
    return this.secrets!.get(account) ?? null;
  }

  async setSecret(account: string, value: string): Promise<void> {
    this.ensureUnlocked();
    this.secrets!.set(account, value);
    await this.persist();
  }

  async deleteSecret(account: string): Promise<void> {
    this.ensureUnlocked();
    this.secrets!.delete(account);
    await this.persist();
  }
}
