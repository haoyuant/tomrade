import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ANON_ROTATE_MS } from "./constants.js";

/**
 * The anonymous identity. A random secret lives only on this machine; the id
 * the cloud sees is derived from it, per rotation epoch, so the cloud cannot
 * reverse it and cannot connect one year to the next. Nothing else on the
 * machine — account, email, hardware — enters the derivation.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, unpadded. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 32 random bytes, base64url — the secret itself; it never leaves this machine. */
export const newSecret = (): string => crypto.randomBytes(32).toString("base64url");

/** Which rotation epoch a moment falls in; 0 for the first year. */
export const epochAt = (startedAt: number, now: number): number => Math.max(0, Math.floor((now - startedAt) / ANON_ROTATE_MS));

/** The 26-character id for one secret and epoch. */
export function deriveAnonId(secret: string, epoch: number): string {
  const digest = crypto.createHmac("sha256", secret).update(`tomrade-anon-v1:${epoch}`).digest();
  return base32(digest.subarray(0, 16));
}

interface IdentityState {
  /** When this installation first ran; drives first_run, not the id. */
  installedAt: number;
  /** When statistics were last switched on; the rotation clock. */
  startedAt: number;
  epoch: number;
  /** The last used sequence; the next event is one more. */
  seq: number;
}

export interface IdentityInfo {
  anonId: string;
  installedAt: number;
  startedAt: number;
  /** The date the current id rotates. */
  rotatesAt: number;
}

/**
 * The secret and its small state file, in `<userData>/analytics`. Machine
 * files only: never a project folder, never the Hub, never a log.
 */
export class AnonIdentity {
  readonly secretFile: string;
  readonly stateFile: string;

  constructor(readonly dir: string, private readonly now: () => number = Date.now) {
    this.secretFile = path.join(dir, "secret");
    this.stateFile = path.join(dir, "state.json");
  }

  /** Creates the secret and state on first use; keeps them otherwise. */
  ensure(): IdentityState {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let state = this.readState();
    const now = this.now();
    if (!state) {
      state = { installedAt: now, startedAt: now, epoch: 0, seq: 0 };
      this.writeState(state);
    }
    if (!fs.existsSync(this.secretFile)) this.writeSecret(newSecret());
    return state;
  }

  /** The id as of now, rotating the epoch (and sequence) when its year is up. */
  current(): string {
    const state = this.ensure();
    const epoch = epochAt(state.startedAt, this.now());
    if (epoch !== state.epoch) {
      state.epoch = epoch;
      state.seq = 0;
      this.writeState(state);
    }
    return deriveAnonId(this.readSecret(), epoch);
  }

  /** One more sequence number, persisted before the event that carries it is queued. */
  nextSeq(): number {
    const state = this.ensure();
    state.seq += 1;
    this.writeState(state);
    return state.seq;
  }

  info(): IdentityInfo {
    const state = this.ensure();
    return {
      anonId: this.current(),
      installedAt: state.installedAt,
      startedAt: state.startedAt,
      rotatesAt: state.startedAt + (state.epoch + 1) * ANON_ROTATE_MS
    };
  }

  /** A new secret and a fresh sequence: what the person sees cannot be joined to what came before. */
  reset(): IdentityInfo {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const state = this.ensure();
    state.seq = 0;
    state.epoch = 0;
    state.startedAt = this.now();
    this.writeSecret(newSecret());
    this.writeState(state);
    return this.info();
  }

  /** Statistics were switched on again after being off: a new identity, as if reset. */
  restart(): IdentityInfo {
    return this.reset();
  }

  /** Opt-out: the secret goes; nothing left can derive the old id. */
  clear(): void {
    for (const file of [this.secretFile, this.stateFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A file that cannot go is no reason to keep collecting; the caller stops anyway.
      }
    }
  }

  private readSecret(): string {
    const secret = fs.readFileSync(this.secretFile, "utf8").trim();
    if (!secret) throw new Error("analytics: empty secret");
    return secret;
  }

  private writeSecret(secret: string): void {
    fs.writeFileSync(this.secretFile, secret, { mode: 0o600 });
    try {
      fs.chmodSync(this.secretFile, 0o600);
    } catch {
      // Windows has no POSIX mode; the file still sits in the user's own folder.
    }
  }

  private readState(): IdentityState | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<IdentityState>;
      if (typeof raw.installedAt !== "number" || typeof raw.startedAt !== "number") return null;
      return {
        installedAt: raw.installedAt,
        startedAt: raw.startedAt,
        epoch: typeof raw.epoch === "number" ? raw.epoch : 0,
        seq: typeof raw.seq === "number" ? raw.seq : 0
      };
    } catch {
      return null;
    }
  }

  private writeState(state: IdentityState): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }
}
