import fs from "node:fs";
import type { Grant } from "./device.js";
import { writeFileAtomic } from "@tomradex/contracts";

/** The OS-backed cipher Electron supplies (safeStorage); nothing is kept in plain text without it. */
export interface Cipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface Session extends Grant {
  login: string;
}

/**
 * The signed-in session, encrypted on disk. The renewal token lasts months, so
 * without a cipher it is held in memory only and the sign-in lasts until quit.
 */
export class SessionStore {
  private memory: Session | null = null;

  constructor(
    private readonly file: string | undefined,
    private readonly cipher: Cipher | undefined
  ) {}

  private get durable(): boolean {
    return !!this.file && !!this.cipher?.available();
  }

  load(): Session | null {
    if (!this.durable || !fs.existsSync(this.file!)) return this.memory;
    try {
      return JSON.parse(this.cipher!.decrypt(fs.readFileSync(this.file!))) as Session;
    } catch {
      return this.memory;
    }
  }

  save(session: Session | null): void {
    this.memory = session;
    if (!this.durable) return;
    if (!session) {
      fs.rmSync(this.file!, { force: true });
      return;
    }
    writeFileAtomic(this.file!, this.cipher!.encrypt(JSON.stringify(session)), { mode: 0o600 });
  }
}
