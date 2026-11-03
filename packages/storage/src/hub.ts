import fs from "node:fs";
import path from "node:path";
import type { CatalogProject, RemoteRef } from "@tomradex/hub";
import type { StorageStatus } from "./types.js";
import { errorMessage, writeFileAtomic } from "@tomradex/contracts";

/** A Hub catalog backend. Project folder storage is independent of this port. */
export interface HubBackend {
  read(): HubManifest;
  observe(local: HubManifest): void;
  removeProject(projectId: string): void;
  sync(): Promise<StorageStatus>;
  status(): StorageStatus;
}

export const HUB_MANIFEST = "hub.json";

/** One project as the portable catalog carries it: identity and, when it has one, the remote to clone it from. */
export interface HubProject {
  id: string;
  name: string;
  keyPrefix: string;
  /** Present for a dedicated repository with a remote: another machine can attach from it alone. */
  remote: RemoteRef | null;
  /** For a project living in someone's checkout: where to look, since only a person can point at their own clone. */
  hint: string | null;
  updatedAt: number;
}

export interface HubManifest {
  v: 1;
  projects: HubProject[];
  repos: { remote: string; name: string }[];
  /** Ids removed on purpose; a union must not bring them back. */
  removed: { id: string; at: number }[];
}

export const emptyHub = (): HubManifest => ({ v: 1, projects: [], repos: [], removed: [] });

const sortManifest = (m: HubManifest): HubManifest => ({
  v: 1,
  projects: [...m.projects].sort((a, b) => a.id.localeCompare(b.id)),
  repos: [...m.repos].sort((a, b) => a.remote.localeCompare(b.remote)),
  removed: [...m.removed].sort((a, b) => a.id.localeCompare(b.id))
});

/** The Hub folder holds a manifest that cannot be read; nothing is written over it until it can. */
export class HubManifestUnreadableError extends Error {
  constructor(
    public readonly file: string,
    detail: string
  ) {
    super(`${file} could not be read (${detail}); repair or remove it before Tomrade writes the Hub's catalog again`);
    this.name = "HubManifestUnreadableError";
  }
}

/** Null when there is no manifest yet. One that is there but does not read throws: written over as empty, it would lose every other machine's projects. */
export function readHubManifest(dir: string): HubManifest | null {
  const file = path.join(dir, HUB_MANIFEST);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HubManifest> | null;
    if (!raw || typeof raw !== "object" || [raw.projects, raw.repos, raw.removed].some((list) => list !== undefined && !Array.isArray(list))) throw new Error("not a Hub manifest");
    return sortManifest({ v: 1, projects: raw.projects ?? [], repos: raw.repos ?? [], removed: raw.removed ?? [] });
  } catch (error) {
    throw new HubManifestUnreadableError(file, errorMessage(error));
  }
}

export function writeHubManifest(dir: string, manifest: HubManifest): boolean {
  const file = path.join(dir, HUB_MANIFEST);
  const body = JSON.stringify(sortManifest(manifest), null, 2) + "\n";
  try {
    if (fs.readFileSync(file, "utf8") === body) return false;
  } catch {
    // absent
  }
  writeFileAtomic(file, body);
  return true;
}

/** What this machine contributes: every catalogued project, with its remote when it has a portable one. */
export function hubProjectOf(entry: CatalogProject, origin: { url: string | null; branch: string | null } | null, at: number): HubProject {
  const portable = entry.git === "dedicated" && entry.remote ? entry.remote : null;
  // Where it was last seen, without the branch: a checkout changes branch all day, and each change would be a write every machine sees.
  const hint = !portable && origin?.url ? origin.url : null;
  return { id: entry.id, name: entry.name, keyPrefix: entry.keyPrefix, remote: portable, hint, updatedAt: at };
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])])) : value;

/** The same project record but for its stamp, whatever order its keys came in (a database hands them back in its own). */
export const sameHubProject = (a: HubProject, b: HubProject): boolean => JSON.stringify(canonical({ ...a, updatedAt: 0 })) === JSON.stringify(canonical({ ...b, updatedAt: 0 }));

/**
 * Union by id with tombstones. Low-frequency, low-conflict data, so no log is
 * consulted: a project both sides carry takes the later record.
 */
export function mergeHubManifests(ours: HubManifest, theirs: HubManifest): HubManifest {
  const removed = new Map<string, number>();
  for (const r of [...ours.removed, ...theirs.removed]) removed.set(r.id, Math.max(removed.get(r.id) ?? 0, r.at));
  const projects = new Map<string, HubProject>();
  for (const p of [...ours.projects, ...theirs.projects]) {
    const gone = removed.get(p.id);
    if (gone !== undefined && gone >= p.updatedAt) continue;
    const existing = projects.get(p.id);
    if (!existing || p.updatedAt > existing.updatedAt) projects.set(p.id, p);
  }
  // A project re-added after its removal outlives the tombstone.
  for (const p of projects.values()) removed.delete(p.id);
  const repos = new Map<string, { remote: string; name: string }>();
  for (const r of [...ours.repos, ...theirs.repos]) repos.set(r.remote, r);
  return sortManifest({ v: 1, projects: [...projects.values()], repos: [...repos.values()], removed: [...removed].map(([id, at]) => ({ id, at })) });
}
