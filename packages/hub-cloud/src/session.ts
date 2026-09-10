import fs from "node:fs";
import path from "node:path";

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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, this.cipher.encrypt(JSON.stringify(data)), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  removeItem(key: string): void {
    if (!fs.existsSync(this.file)) return;
    this.check();
    const data = JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file)));
    delete data[key];
    fs.writeFileSync(`${this.file}.tmp`, this.cipher.encrypt(JSON.stringify(data)), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
