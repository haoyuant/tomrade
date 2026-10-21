import fs from "node:fs";
import { z } from "zod";
import { AttestationSchema } from "./sign.js";
import { errorMessage, writeJsonAtomic } from "@tomradex/contracts";

// An attestation this build no longer understands (a review tier that is gone) reads as none.
const Installed = z.object({ version: z.string(), dir: z.string(), digest: z.string(), attestation: AttestationSchema.nullable().default(null).catch(null) });

/**
 * Where a plugin came from decides how it is trusted: `store` and `file`
 * packages are checked against their digest; `folder` is a directory a person
 * chose to load as it is; `studio` is one the agent writes, loaded only at a
 * digest a person confirmed.
 */
export const LockEntrySchema = Installed.extend({
  id: z.string(),
  source: z.enum(["store", "file", "folder", "studio"]),
  disabled: z.boolean().default(false),
  /** The version before the last update, kept so a failed update can go back. */
  previous: Installed.nullable().default(null),
  /** Studio: digests a person looked at and allowed to load. */
  confirmed: z.array(z.string()).default([]),
  /** The files changed after install; the plugin is now the person's own copy. */
  modified: z.boolean().default(false),
  autoUpdate: z.boolean().default(false),
  installedAt: z.number(),
  updatedAt: z.number()
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

export const LockSchema = z.object({ v: z.literal(1), plugins: z.array(LockEntrySchema) });
export type Lock = z.infer<typeof LockSchema>;

export const LOCK_FILE = "plugins.lock.json";

export function readLock(file: string): Lock {
  if (!fs.existsSync(file)) return { v: 1, plugins: [] };
  try {
    return LockSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    // Read at boot: the person seeing this has to know which file it is, and what in it is wrong.
    const why = error instanceof z.ZodError ? z.prettifyError(error) : errorMessage(error);
    throw new Error(`${file}: ${why}`, { cause: error });
  }
}

/** Atomic: a crash mid-write leaves the old lock, never half of a new one. */
export function writeLock(file: string, lock: Lock): void {
  writeJsonAtomic(file, LockSchema.parse(lock), { perProcess: true });
}

/** Nothing in the store is reviewed: `community` is a publisher's own build, `official` one Tomrade signed. */
export type TrustTier = "official" | "community" | "local" | "dev";

export function tierOf(entry: Pick<LockEntry, "source" | "modified" | "attestation">): TrustTier {
  if (entry.source === "studio" || entry.source === "folder") return "dev";
  if (entry.modified) return "local";
  if (entry.attestation) return "official";
  return entry.source === "store" ? "community" : "local";
}
