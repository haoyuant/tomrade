import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModelErrorKind } from "@tomradex/domain";

/** What identifies a test's subject: endpoint, key and model — editing any of them forgets the outcome. */
export interface TestedProfile {
  provider: string;
  baseURL?: string;
  model: string;
  apiKey: string;
}

export interface KeptTest {
  ok: boolean;
  /** Failed: why, in the provider's own words. */
  kind?: ModelErrorKind;
  detail?: string;
  at: number;
}

/** Drafts tested in the profile form come and go; only this many outcomes are worth keeping. */
const KEEP = 50;

export const testKey = (profile: TestedProfile): string =>
  createHash("sha256").update(JSON.stringify([profile.provider, profile.baseURL ?? "", profile.model, profile.apiKey])).digest("hex");

/**
 * Profiles' one-token test outcomes, remembered so setup never re-asks on a
 * render. In memory always, mirrored to a file when the app has a data folder.
 */
export class KeptTests {
  private entries = new Map<string, KeptTest>();
  private file: string | null = null;

  /** Starts mirroring to `file` and reads what an earlier run kept there. */
  attach(file: string | null): void {
    this.file = file;
    if (!file) return;
    try {
      const read = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, KeptTest>;
      for (const [key, entry] of Object.entries(read)) if (!this.entries.has(key)) this.entries.set(key, entry);
    } catch {
      // Nothing kept yet.
    }
  }

  read(profile: TestedProfile): KeptTest | undefined {
    return this.entries.get(testKey(profile));
  }

  write(profile: TestedProfile, test: KeptTest): void {
    this.entries.set(testKey(profile), test);
    if (this.entries.size > KEEP) this.entries = new Map([...this.entries.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP));
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(Object.fromEntries(this.entries), null, 2)}\n`);
    } catch {
      // Only the next launch loses the memo.
    }
  }
}
