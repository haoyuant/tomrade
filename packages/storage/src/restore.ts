import fs from "node:fs";
import path from "node:path";
import type { RemoteRef } from "@tomradex/hub";
import { GitFolder, cleanRemote, cloneBranch, probeUrl, type Git } from "@tomradex/git";
import type { HubManifest, HubProject } from "./hub.js";
import { ARTIFACT_DIR, MANIFEST, projectIdOf, readClone, type ProjectState } from "./state.js";
import type { RemoteTarget, StorageProvider } from "./types.js";
import { errorMessage } from "@tomradex/contracts";

/**
 * Where a project the Hub names, and this machine lacks, stands. `queued`,
 * `offline` and `unpublished` resolve by themselves; `needs-connection`,
 * `needs-provider`, `not-backed-up` and `failed` wait on the person.
 */
export type RestoreState = "queued" | "restoring" | "offline" | "unpublished" | "needs-connection" | "needs-provider" | "not-backed-up" | "failed";
export type RestoreStep = "contacting" | "downloading" | "opening";

export interface RestoreEntry {
  projectId: string;
  name: string;
  keyPrefix: string;
  state: RestoreState;
  step?: RestoreStep;
  /** The destination it comes back from; null when it was never given one. */
  provider: { id: string; title: string } | null;
  /** That destination without credentials: "github.com/acme/app · main". */
  location: string | null;
  /** For a project without a remote: where the machine that has it said it lives. */
  hint: string | null;
  detail?: string;
  /** When the next automatic attempt is due. */
  retryAt?: number;
}

export interface RestoreSummary {
  entries: RestoreEntry[];
  /** Brought back since the app started. */
  restored: number;
}

export interface RestoreHost {
  manifest(): HubManifest | null;
  known(projectId: string): boolean;
  provider(id: string): StorageProvider | null;
  git: Git;
  /** Tomrade's own project folders: where a copy from an earlier install would still be. */
  projectsDir(): string | null;
  folderFor(name: string): string;
  adopt(projectId: string, dir: string, remote: RemoteRef | null, how: Adoption): Promise<void>;
  changed(): void;
  restored(projectId: string): void;
  warn(message: string): void;
  /** Off in tests that drive restores by hand: no timers, nothing starts by itself. */
  auto: boolean;
}

/** How a folder came to hold the project: already on disk, or just cloned and read (see `readClone`). */
export interface Adoption {
  found: boolean;
  state?: ProjectState;
  fill?: Map<string, string>;
  withheld?: string[];
}

export class RestoreProblem extends Error {
  constructor(
    public readonly kind: "offline" | "unpublished" | "denied" | "invalid",
    message: string,
    public readonly gitDetail?: string
  ) {
    super(message);
    this.name = "RestoreProblem";
  }
}

export const locationOf = (target: RemoteTarget): string => `${cleanRemote(target.url).replace(/^https?:\/\//, "").replace(/\.git$/, "")} · ${target.branch}`;

/**
 * Clone a published project into `staging` and read it back. Nothing lands
 * where a project would be looked for until it has been read whole, so an
 * interrupted download leaves nothing that looks like a project.
 */
export async function fetchProject(git: Git, target: RemoteTarget, staging: string, onStep?: (step: RestoreStep) => void): Promise<NonNullable<ReturnType<typeof readClone>>> {
  const where = locationOf(target);
  const probe = await probeUrl(git, target.url, target.branch);
  if (probe.reach === "offline") throw new RestoreProblem("offline", `Cannot reach ${where}`, probe.detail);
  if (probe.reach === "denied") throw new RestoreProblem("denied", `No access to ${where}`, probe.detail);
  if (probe.reach === "absent") throw new RestoreProblem("unpublished", `Nothing has been published to ${where} yet`);
  onStep?.("downloading");
  fs.rmSync(staging, { recursive: true, force: true });
  const cloned = await cloneBranch(git, target.url, target.branch, staging);
  if (!cloned.ok) throw new RestoreProblem(cloned.reach, cloned.reach === "offline" ? `Cannot reach ${where}` : `No access to ${where}`, cloned.detail);
  const read = readClone(staging);
  if (!read) throw new RestoreProblem("invalid", `${where} holds no Tomrade project`);
  return read;
}

/** Where a record points before its provider is asked: owner/repo, or the URL. Configs hold no secrets. */
const describeRef = (ref: RemoteRef): string | null => {
  const c = ref.config;
  const branch = typeof c.branch === "string" ? ` · ${c.branch}` : "";
  if (typeof c.owner === "string" && typeof c.repo === "string") return `${c.owner}/${c.repo}${branch}`;
  if (typeof c.remote === "string") return `${cleanRemote(c.remote).replace(/^https?:\/\//, "").replace(/\.git$/, "")}${branch}`;
  return null;
};

const sameRemote = (a: string, b: string): boolean => {
  const norm = (u: string) => cleanRemote(u).replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
};


const MINUTE = 60_000;

/** Offline backs off from half a minute to ten; a remote with nothing on it yet is asked every five. */
const delayFor = (state: RestoreState, attempt: number): number =>
  state === "offline" ? Math.min(10 * MINUTE, 30_000 * 2 ** Math.min(attempt, 5)) : state === "unpublished" ? 5 * MINUTE : 10 * MINUTE;

/**
 * Brings back every project the Hub's catalog names and this machine does not
 * have, one at a time: a copy already on disk is adopted, anything else is
 * cloned from its remote. What cannot be brought back says why.
 */
export class Restorer {
  private readonly entries = new Map<string, RestoreEntry>();
  private readonly records = new Map<string, HubProject>();
  private readonly attempts = new Map<string, number>();
  private running: Promise<string[]> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private restored = 0;

  constructor(private readonly host: RestoreHost) {}

  summary(): RestoreSummary {
    const entries = [...this.entries.values()].map((e) => ({ ...e })).sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
    return { entries, restored: this.restored };
  }

  record(projectId: string): HubProject | null {
    return this.records.get(projectId) ?? null;
  }

  entry(projectId: string): RestoreEntry | null {
    return this.entries.get(projectId) ?? null;
  }

  /** Line the entries up with what the Hub names now. */
  scan(): void {
    const wanted = new Map<string, HubProject>();
    for (const p of this.host.manifest()?.projects ?? []) if (!this.host.known(p.id)) wanted.set(p.id, p);
    let moved = false;
    for (const id of [...this.entries.keys()]) {
      if (wanted.has(id)) continue;
      this.entries.delete(id);
      this.records.delete(id);
      this.attempts.delete(id);
      moved = true;
    }
    for (const [id, p] of wanted) {
      const before = this.records.get(id);
      this.records.set(id, p);
      const entry = this.entries.get(id);
      if (!entry) {
        this.entries.set(id, this.fresh(p));
        moved = true;
      } else if (before && JSON.stringify(before.remote) !== JSON.stringify(p.remote) && entry.state !== "restoring") {
        // Another machine gave it a remote, or a different one: what was concluded no longer holds.
        Object.assign(entry, this.fresh(p));
        this.attempts.delete(id);
        moved = true;
      } else if (entry.name !== p.name || entry.keyPrefix !== p.keyPrefix || entry.hint !== p.hint) {
        Object.assign(entry, { name: p.name, keyPrefix: p.keyPrefix, hint: p.hint });
        moved = true;
      }
    }
    if (moved) this.host.changed();
  }

  /** Try again now: every entry the predicate picks that is not already under way. */
  retry(match: (entry: RestoreEntry) => boolean): void {
    let moved = false;
    for (const e of this.entries.values()) {
      if (e.state === "restoring" || !match(e)) continue;
      Object.assign(e, { state: "queued", step: undefined, detail: undefined, retryAt: undefined });
      this.attempts.delete(e.projectId);
      moved = true;
    }
    if (moved) this.host.changed();
  }

  /** Work through everything due, one project at a time. Resolves with the ids brought back. */
  run(): Promise<string[]> {
    // Joined mid-flight, the pass may already have looked past what was queued since: take another after it.
    if (this.running) return this.running.then(async (done) => [...done, ...(await this.run())]);
    this.running = this.pass().finally(() => {
      this.running = null;
      this.arm();
    });
    return this.running;
  }

  private async pass(): Promise<string[]> {
    const done: string[] = [];
    for (;;) {
      if (this.closed) break;
      const now = Date.now();
      const next = [...this.entries.values()].find((e) => e.state === "queued" || (e.retryAt !== undefined && e.retryAt <= now));
      if (!next) break;
      if (await this.one(next)) done.push(next.projectId);
    }
    return done;
  }

  /** The person brought it back some other way (a folder they picked). */
  adopted(projectId: string): void {
    this.finish(projectId);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fresh(p: HubProject): RestoreEntry {
    const provider = p.remote ? { id: p.remote.provider, title: this.host.provider(p.remote.provider)?.title ?? p.remote.provider } : null;
    return { projectId: p.id, name: p.name, keyPrefix: p.keyPrefix, state: "queued", provider, location: p.remote ? describeRef(p.remote) : null, hint: p.hint };
  }

  private patch(e: RestoreEntry, patch: Partial<RestoreEntry>): void {
    Object.assign(e, patch);
    this.host.changed();
  }

  /** Lands on a state that waits; false, since nothing was brought back. */
  private settle(e: RestoreEntry, state: RestoreState, detail?: string): false {
    const attempt = (this.attempts.get(e.projectId) ?? 0) + 1;
    this.attempts.set(e.projectId, attempt);
    const retries = state === "offline" || state === "unpublished" || state === "needs-connection";
    this.patch(e, { state, step: undefined, detail, retryAt: retries && this.host.auto ? Date.now() + delayFor(state, attempt) : undefined });
    return false;
  }

  private finish(projectId: string): true {
    this.entries.delete(projectId);
    this.records.delete(projectId);
    this.attempts.delete(projectId);
    this.restored++;
    this.host.restored(projectId);
    this.host.changed();
    return true;
  }

  private async one(e: RestoreEntry): Promise<boolean> {
    const record = this.records.get(e.projectId);
    if (!record) return false;
    if (this.host.known(e.projectId)) return this.finish(e.projectId);
    this.patch(e, { state: "restoring", step: "contacting", detail: undefined, retryAt: undefined });
    try {
      return await this.attempt(e, record);
    } catch (error) {
      this.host.warn(`restore: ${record.name} (${record.id}) — ${errorMessage(error)}`);
      return this.settle(e, "failed", errorMessage(error));
    }
  }

  private async attempt(e: RestoreEntry, record: HubProject): Promise<boolean> {
    const found = this.findLocal(record.id);
    if (!record.remote) {
      if (!found) return this.settle(e, "not-backed-up");
      this.patch(e, { step: "opening" });
      await this.host.adopt(record.id, found, null, { found: true });
      return this.finish(record.id);
    }
    const provider = this.host.provider(record.remote.provider);
    if (!provider) return this.settle(e, "needs-provider");
    const target = await provider.toRemote(provider.configSchema.parse(record.remote.config));
    this.patch(e, { location: locationOf(target), provider: { id: provider.id, title: provider.title } });
    if (found && (await this.holds(found, target.url))) {
      this.patch(e, { step: "opening" });
      await this.host.adopt(record.id, found, record.remote, { found: true });
      return this.finish(record.id);
    }
    if (found) this.host.warn(`restore: ${record.name}: ${found} holds an older copy that is not a checkout of ${locationOf(target)}; left as it is`);

    const root = this.host.projectsDir();
    if (!root) throw new Error("Choose where Tomrade keeps its files first (the Hub folder)");
    const staging = path.join(root, `.restoring-${record.id}`);
    try {
      const read = await fetchProject(this.host.git, target, staging, (step) => this.patch(e, { step }));
      const { state } = read;
      if (projectIdOf(state) !== record.id) return this.settle(e, "failed", `${locationOf(target)} holds a different project (${projectIdOf(state)})`);
      this.patch(e, { step: "opening" });
      if (this.host.known(record.id)) return this.finish(record.id);
      const dir = this.host.folderFor(String(state.manifest.project.name ?? record.name) || record.name);
      fs.renameSync(staging, dir);
      await this.host.adopt(record.id, dir, record.remote, { found: false, ...read });
      return this.finish(record.id);
    } catch (error) {
      if (!(error instanceof RestoreProblem)) throw error;
      if (error.kind === "offline" || error.kind === "unpublished") return this.settle(e, error.kind === "offline" ? "offline" : "unpublished", error.gitDetail ?? error.message);
      if (error.kind === "denied" && provider.connection) {
        const connection = await provider.connection.status().catch(() => ({ connected: false }));
        if (!connection.connected) return this.settle(e, "needs-connection", error.gitDetail);
      }
      return this.settle(e, "failed", error.gitDetail ? `${error.message}: ${error.gitDetail}` : error.message);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** A folder of Tomrade's own already holding this project — left by an earlier install, say. */
  private findLocal(projectId: string): string | null {
    const root = this.host.projectsDir();
    if (!root || !fs.existsSync(root)) return null;
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(".")) continue;
      const dir = path.join(root, name);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, ARTIFACT_DIR, MANIFEST), "utf8")) as { project?: { id?: unknown } };
        if (String(manifest.project?.id) === projectId) return dir;
      } catch {
        // not a project folder
      }
    }
    return null;
  }

  /** Whether the folder is its own repository with this remote as origin. */
  private async holds(dir: string, url: string): Promise<boolean> {
    const g = new GitFolder(this.host.git, dir);
    const top = await g.toplevel().catch(() => null);
    if (!top || top !== fs.realpathSync(dir)) return false;
    const origin = await g.remoteUrl().catch(() => null);
    return origin !== null && sameRemote(origin, url);
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || !this.host.auto) return;
    const due = Math.min(...[...this.entries.values()].map((e) => e.retryAt ?? Infinity));
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, Math.max(0, due - Date.now()));
    this.timer.unref?.();
  }
}
