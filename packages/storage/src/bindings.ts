import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Which destination a project uses on THIS machine. Machine-local: never synced,
 * never committed, and rebuildable — a project's identity lives in its own rows,
 * so a lost bindings file costs the destinations, not the data.
 *
 * An absent binding is what "stored on this machine" means. There is no `local`
 * provider to keep in step.
 */
export const StorageBinding = z.object({
  projectId: z.string(),
  provider: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Digest of the artifact as last published; the basis of ahead/behind/diverged. */
  lastFlushedDigest: z.string().nullable().default(null),
  lastSyncAt: z.number().nullable().default(null)
});
export type StorageBinding = z.infer<typeof StorageBinding>;

const BindingsFile = z.object({ v: z.literal(1).default(1), bindings: z.array(StorageBinding).default([]) });

export class Bindings {
  private map = new Map<string, StorageBinding>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = BindingsFile.safeParse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      if (parsed.success) for (const b of parsed.data.bindings) this.map.set(b.projectId, b);
    } catch {
      // first run, or a file we refuse to guess at; the destinations are re-bound by hand
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = JSON.stringify({ v: 1, bindings: [...this.map.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)) }, null, 2) + "\n";
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, this.file);
  }

  get(projectId: string): StorageBinding | null {
    return this.map.get(projectId) ?? null;
  }

  all(): StorageBinding[] {
    return [...this.map.values()];
  }

  set(binding: StorageBinding): StorageBinding {
    this.map.set(binding.projectId, binding);
    this.save();
    return binding;
  }

  patch(projectId: string, patch: Partial<StorageBinding>): StorageBinding | null {
    const existing = this.map.get(projectId);
    if (!existing) return null;
    return this.set({ ...existing, ...patch });
  }

  remove(projectId: string): void {
    if (this.map.delete(projectId)) this.save();
  }
}
