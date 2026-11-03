import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorMessage, writeJsonAtomic } from "@tomradex/contracts";

export const Kind = z.enum(["project", "repo", "preference"]);
export type Kind = z.infer<typeof Kind>;
export const RecordSchema = z.object({
  kind: Kind, key: z.string().min(1), value: z.json().nullable(), version: z.number().int().nonnegative()
});
export type CloudRecord = z.infer<typeof RecordSchema>;
const MutationSchema = RecordSchema.omit({ version: true }).extend({
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
  terms: z.string().nullable().default(null),
  /** Requests that may have reached the cloud: never changed again, since a retry must say what the first said. */
  sent: z.array(z.string()).default([])
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
  v: 1, endpoint, userId: null, hubId: null, email: null, records: [], outbox: [], observed: {}, conflicts: [], migrated: false, lastSyncAt: null, offlineAccess: false, localOnly: false, terms: null, sent: []
});

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

/** A durable outbox, outside the disposable SQLite caches. No credentials or project rows. */
export class CloudCache {
  data: CacheState;
  constructor(private readonly file: string, private readonly endpoint: string, private readonly warn: (text: string) => void = () => {}) {
    this.data = this.load() ?? empty(endpoint);
    if (this.data.endpoint !== endpoint) throw new Error("This local Hub belongs to another Supabase project. Use a separate TOMRADE_USER_DATA directory.");
  }
  /** A file that does not read is moved aside and the cache starts empty: the account still signs in, and what was queued is in the copy. */
  private load(): CacheState | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      return State.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch (error) {
      const keptAs = `${this.file}.corrupt-${stamp()}`;
      fs.renameSync(this.file, keptAs);
      this.warn(`hub-cloud: ${this.file} could not be read (${errorMessage(error)}); kept as ${keptAs}, starting from an empty cache`);
      return null;
    }
  }
  /** The account is gone: this local Hub belongs to nobody, and the next account starts it afresh from what is on this machine. */
  release(): void {
    this.data = empty(this.endpoint);
    this.save();
  }
  save(): void {
    // A request that left the outbox — taken, rebased or dropped — is no longer anyone's to keep apart.
    this.data.sent = this.data.sent.filter(id => this.data.outbox.some(p => p.id === id));
    writeJsonAtomic(this.file, this.data, { mode: 0o600 });
  }
  bind(userId: string, hubId: string): void {
    if ((this.data.userId && this.data.userId !== userId) || (this.data.hubId && this.data.hubId !== hubId)) {
      throw new Error("This local Hub belongs to another account. Use a separate TOMRADE_USER_DATA directory to switch accounts.");
    }
    if (this.data.userId === userId && this.data.hubId === hubId) return;
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
    if (!equal(current?.value ?? null, value)) this.queue(kind, key, value, current?.version ?? 0);
    this.data.observed[id] = fingerprint;
    this.save();
  }
  /**
   * What the person asked for, not something observed: queued whenever the Hub would show otherwise, even if this
   * machine asked the same before and another machine has undone it since.
   */
  intend(kind: Kind, key: string, value: CloudRecord["value"]): void {
    const id = recordKey({ kind, key });
    const current = this.view().find(r => recordKey(r) === id);
    if (!equal(current?.value ?? null, value)) this.queue(kind, key, value, current?.version ?? 0);
    this.data.observed[id] = JSON.stringify(canonical(value));
    this.save();
  }
  /**
   * One request per record while none has gone: a later edit to a record whose last request was never sent takes that
   * request's place, and one that brings the record back to what the cloud has needs none.
   */
  private queue(kind: Kind, key: string, value: CloudRecord["value"], base: number): void {
    const id = recordKey({ kind, key });
    const last = this.data.outbox.filter(p => recordKey(p) === id).at(-1);
    if (!last || this.data.sent.includes(last.id)) {
      this.data.outbox.push({ id: randomUUID(), kind, key, value, base_version: base });
      return;
    }
    const held = this.data.records.find(r => recordKey(r) === id);
    const alone = this.data.outbox.filter(p => recordKey(p) === id).length === 1;
    if (alone && held && held.version === last.base_version && equal(held.value, value)) this.data.outbox = this.data.outbox.filter(p => p.id !== last.id);
    else this.data.outbox = this.data.outbox.map(p => (p.id === last.id ? { ...p, value } : p));
  }
  /** Before a request goes: from now on it may have reached the cloud. */
  sending(id: string): void {
    if (this.data.sent.includes(id)) return;
    this.data.sent.push(id);
    this.save();
  }
  /** The cloud's records: all of them, or with `partial` only those changed since the last read, laid over the ones kept. */
  ingest(records: CloudRecord[], partial = false): void {
    let next = records;
    if (partial) {
      // In place: a row read again keeps its position, so reading it again unchanged changes nothing.
      const read = new Map(records.map(r => [recordKey(r), r]));
      const kept = new Set(this.data.records.map(recordKey));
      next = [...this.data.records.map(r => read.get(recordKey(r)) ?? r), ...records.filter(r => !kept.has(recordKey(r)))];
    }
    // A clash waiting for the person shows the cloud's newest side of it, so choosing the cloud never steps back to an older one.
    const conflicts = this.data.conflicts.map(c => {
      const read = records.find(r => recordKey(r) === recordKey(c));
      return read && read.version > c.version ? read : c;
    });
    // Each read overlaps the last by a minute, and the database orders a value's keys its own way: neither is a change.
    if (JSON.stringify(canonical([next, conflicts])) === JSON.stringify(canonical([this.data.records, this.data.conflicts]))) return;
    this.data.records = next;
    this.data.conflicts = conflicts;
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
  /** The cloud holds a record our requests for it did not know of: take it, and send on top of it what is left of ours, if anything is. */
  rebase(record: CloudRecord, value: CloudRecord["value"]): void {
    this.data.outbox = this.data.outbox.filter(p => recordKey(p) !== recordKey(record));
    this.data.records = [...this.data.records.filter(r => recordKey(r) !== recordKey(record)), record];
    if (!equal(value, record.value)) this.data.outbox.push({ id: randomUUID(), kind: record.kind, key: record.key, value, base_version: record.version });
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
