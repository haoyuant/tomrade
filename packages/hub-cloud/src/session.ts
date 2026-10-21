import fs from "node:fs";
import { writeFileAtomic } from "@tomradex/contracts";

export interface Cipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

/** Electron supplies the OS-backed cipher. Refuse plaintext fallback, including Linux basic_text. */
export class EncryptedSessionStorage {
  constructor(private readonly file: string, private readonly cipher: Cipher) {}
  private check(): void {
    if (!this.cipher.available()) throw new Error("Secure credential storage is unavailable. Unlock your system keychain and restart Tomrade.");
  }
  getItem(key: string): string | null {
    if (!fs.existsSync(this.file)) return null;
    this.check();
    const data = JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file))) as Record<string, string>;
    return data[key] ?? null;
  }
  setItem(key: string, value: string): void {
    this.check();
    const data = fs.existsSync(this.file) ? JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file))) : {};
    data[key] = value;
    writeFileAtomic(this.file, this.cipher.encrypt(JSON.stringify(data)), { mode: 0o600 });
  }
  removeItem(key: string): void {
    if (!fs.existsSync(this.file)) return;
    this.check();
    const data = JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file)));
    delete data[key];
    writeFileAtomic(this.file, this.cipher.encrypt(JSON.stringify(data)), { mkdir: false, mode: 0o600 });
  }
}
