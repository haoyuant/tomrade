import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const Kind = z.enum(["project", "repo", "preference"]);
export type Kind = z.infer<typeof Kind>;
export const RecordSchema = z.object({
  kind: Kind, key: z.string().min(1), value: z.json().nullable(), version: z.number().int().nonnegative()
});
export type CloudRecord = z.infer<typeof RecordSchema>;
export const MutationSchema = RecordSchema.omit({ version: true }).extend({
  id: z.uuid(), base_version: z.number().int().nonnegative()
});
export type Mutation = z.infer<typeof MutationSchema>;
const State = z.object({
  v: z.literal(1), endpoint: z.string(), userId: z.string().nullable(), hubId: z.string().nullable(),
  /** The owner's address, so a signed-out machine can still say whose projects it holds. */
  email: z.string().nullable().default(null),
  records: z.array(RecordSchema), outbox: z.array(MutationSchema),
  observed: z.record(z.string(), z.string()), conflicts: z.array(RecordSchema),
  migrated: z.boolean(), lastSyncAt: z.number().nullable(),
  offlineAccess: z.boolean().default(false),
  /** Chosen on the sign-in page: this local Hub is used without an account until someone signs in here. */
  localOnly: z.boolean().default(false),
  /** The terms version agreed to here, kept until the account carries it too. */
  terms: z.string().nullable().default(null)
});
export type CacheState = z.infer<typeof State>;
export const recordKey = (r: { kind: Kind; key: string }) => `${r.kind}:${r.key}`;
export const equal = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
  return v;
}

const empty = (endpoint: string): CacheState => ({
  v: 1, endpoint, userId: null, hubId: null, email: null, records: [], outbox: [], observed: {}, conflicts: [], migrated: false, lastSyncAt: null, offlineAccess: false, localOnly: false, terms: null
});

/** A durable outbox, outside the disposable SQLite caches. No credentials or project rows. */
export class CloudCache {
  data: CacheState;
  constructor(private readonly file: string, private readonly endpoint: string) {
    this.data = fs.existsSync(file) ? State.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : empty(endpoint);
    if (this.data.endpoint !== endpoint) throw new Error("This local Hub belongs to another Supabase project. Use a separate TOMRADE_USER_DATA directory.");
  }
  /** The account is gone: this local Hub belongs to nobody, and the next account starts it afresh from what is on this machine. */
  release(): void {
    this.data = empty(this.endpoint);
    this.save();
  }
  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  bind(userId: string, hubId: string): void {
    if ((this.data.userId && this.data.userId !== userId) || (this.data.hubId && this.data.hubId !== hubId)) {
      throw new Error("This local Hub belongs to another account. Use a separate TOMRADE_USER_DATA directory to switch accounts.");
    }
    this.data.userId = userId;
    this.data.hubId = hubId;
    this.save();
  }
  view(): CloudRecord[] {
    const records = new Map(this.data.records.map(r => [recordKey(r), r]));
    for (const op of this.data.outbox) records.set(recordKey(op), { kind: op.kind, key: op.key, value: op.value, version: op.base_version + 1 });
    return [...records.values()];
  }
  /** Observe local facts, not cloud projections. An unchanged local checkout must not undo another device's change. */
  observe(kind: Kind, key: string, value: CloudRecord["value"]): void {
    const id = recordKey({ kind, key });
    const fingerprint = JSON.stringify(canonical(value));
    if (this.data.observed[id] === fingerprint) return;
    const current = this.view().find(r => recordKey(r) === id);
    if (!equal(current?.value ?? null, value)) {
      this.data.outbox.push({ id: randomUUID(), kind, key, value, base_version: current?.version ?? 0 });
    }
    this.data.observed[id] = fingerprint;
    this.save();
  }
  ingest(records: CloudRecord[]): void {
    this.data.records = records;
    this.save();
  }
  accept(op: Mutation, record: CloudRecord): void {
    this.data.outbox = this.data.outbox.filter(p => p.id !== op.id);
    if (record.version !== op.base_version + 1) {
      // An equivalent value may already exist on another device at a later
      // revision. Rebase only requests that have not been sent, with fresh ids.
      let version = record.version;
      this.data.outbox = this.data.outbox.map(p => recordKey(p) === recordKey(record)
        ? { ...p, id: randomUUID(), base_version: version++ } : p);
    }
    this.data.records = [...this.data.records.filter(r => recordKey(r) !== recordKey(record)), record];
    this.save();
  }
  conflict(record: CloudRecord): void {
    this.data.conflicts = [...this.data.conflicts.filter(r => recordKey(r) !== recordKey(record)), record];
    this.save();
  }
  resolve(id: string, choice: "local" | "cloud"): void {
    const remote = this.data.conflicts.find(r => recordKey(r) === id);
    if (!remote) throw new Error("Conflict no longer exists; refresh the Hub.");
    const desired = this.view().find(r => recordKey(r) === id)!;
    this.data.outbox = this.data.outbox.filter(r => recordKey(r) !== id);
    this.data.records = [...this.data.records.filter(r => recordKey(r) !== id), remote];
    this.data.conflicts = this.data.conflicts.filter(r => recordKey(r) !== id);
    if (choice === "local" && !equal(desired.value, remote.value)) {
      this.data.outbox.push({ id: randomUUID(), kind: remote.kind, key: remote.key, value: desired.value, base_version: remote.version });
    }
    this.save();
  }
}
