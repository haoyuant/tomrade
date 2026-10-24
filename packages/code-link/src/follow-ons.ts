import fs from "node:fs";
import { z } from "zod";
import { writeJsonAtomic } from "@tomradex/contracts";

const FollowOnOptions = z.object({
  mode: z.enum(["run", "terminal"]),
  engine: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  permissionMode: z.string().min(1).optional(),
  playbook: z.string().min(1).optional()
});
const FollowOn = z.object({
  projectId: z.string().min(1),
  /** The ticket that starts by itself. */
  itemId: z.string().min(1),
  /** Once this ticket is done. */
  afterItemId: z.string().min(1),
  /** The choices made for it in the Start dialog: the same ones the ticket it waited on ran with. */
  options: FollowOnOptions,
  at: z.number()
});
export type FollowOn = z.infer<typeof FollowOn>;

/**
 * Tickets to start by themselves once another lands: a bootstrap started ahead
 * of the ticket that needs it. Machine-local, beside the Start defaults: the
 * choices it carries name agents installed here. Read leniently, entry by
 * entry, so one this version no longer understands does not lose the others.
 */
export class FollowOnStore {
  private memory: FollowOn[] = [];

  constructor(private readonly file: string | null) {}

  list(): FollowOn[] {
    if (!this.file) return [...this.memory];
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    return Array.isArray(raw) ? raw.flatMap((entry) => (FollowOn.safeParse(entry).success ? [FollowOn.parse(entry)] : [])) : [];
  }

  /** One follow-on per ticket: starting the same bootstrap again replaces what it waits on, never doubles it. */
  add(followOn: FollowOn): void {
    this.write([...this.list().filter((f) => !(f.projectId === followOn.projectId && f.itemId === followOn.itemId)), followOn]);
  }

  /** The follow-ons waiting on this ticket, removed as they are handed out: each starts once. */
  take(projectId: string, afterItemId: string): FollowOn[] {
    const all = this.list();
    const taken = all.filter((f) => f.projectId === projectId && f.afterItemId === afterItemId);
    if (taken.length) this.write(all.filter((f) => !taken.includes(f)));
    return taken;
  }

  /** The ticket is done or cancelled on its own: nothing waits for it any more. */
  drop(projectId: string, itemId: string): void {
    const all = this.list();
    const kept = all.filter((f) => !(f.projectId === projectId && f.itemId === itemId));
    if (kept.length !== all.length) this.write(kept);
  }

  private write(entries: FollowOn[]): void {
    if (!this.file) {
      this.memory = entries;
      return;
    }
    writeJsonAtomic(this.file, entries);
  }
}
