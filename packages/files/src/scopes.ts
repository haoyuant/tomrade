import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadJson } from "./git-sync.js";

/** Stores from before ids were kept are the one store their project ever had. */
const LEGACY_STORE_ID = "base";
const TARGET = "files-target.json";
const ID = "files-store-id";

/** The remote directory a store was last bound to: "" for a repository root, null when it never shared. */
export function boundDirectory(dir: string): string | null {
  const target = loadJson<{ directory?: unknown } | null>(path.join(dir, ".git", TARGET), null);
  if (target && typeof target.directory === "string") return target.directory;
  // Before directories existed the store itself held the remote, and only ever at its root.
  try {
    return /^\[remote "origin"\]/m.test(fs.readFileSync(path.join(dir, ".git", "config"), "utf8")) ? "" : null;
  } catch {
    return null;
  }
}

/** A repository root and a folder in it are different enough that a store must not serve both; folders are alike. */
export const separateWorlds = (from: string | null, to: string): boolean => from !== null && from !== to && (from === "" || to === "");

/** The id a store's operations are filed under, so undo knows which store they belong to. */
export function storeId(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, ".git", ID), "utf8").trim() || LEGACY_STORE_ID;
  } catch {
    return LEGACY_STORE_ID;
  }
}

export function ensureStoreId(dir: string, created: boolean): void {
  const file = path.join(dir, ".git", ID);
  if (!fs.existsSync(file)) fs.writeFileSync(file, created ? randomUUID() : LEGACY_STORE_ID);
}

/**
 * Where a project's earlier Files stores go when the remote scope moves
 * between a repository root and a folder: whole, beside the live one, never
 * copied into it. A root scope shows the repository as it is — code and all —
 * so its content is not what a folder scope should publish, and a folder's
 * content is not what a root scope should receive twice.
 */
export class FilesArchive {
  constructor(readonly root: string) {}

  /** Whether moving a store from one remote directory to another calls for a separate store. */
  static rotates(from: string | null, to: string): boolean {
    return separateWorlds(from, to);
  }

  /** Stores kept here. */
  dirs(): string[] {
    try {
      return fs.readdirSync(this.root).map((name) => path.join(this.root, name)).filter((dir) => fs.existsSync(path.join(dir, ".git"))).sort();
    } catch {
      return [];
    }
  }

  /**
   * Park the live store and bring back the one bound to `directory` if it is
   * here, so switching back and forth restores each view as it was. Returns
   * how to put things back, for a bind that then fails.
   */
  rotate(live: string, directory: string): () => void {
    fs.mkdirSync(this.root, { recursive: true });
    const returning = this.dirs().find((dir) => boundDirectory(dir) === directory) ?? null;
    let parked = path.join(this.root, storeId(live));
    while (fs.existsSync(parked)) parked = path.join(this.root, `${storeId(live)}-${randomUUID().slice(0, 8)}`);
    fs.renameSync(live, parked);
    if (returning) fs.renameSync(returning, live);
    return () => {
      if (returning) fs.renameSync(live, returning);
      else fs.rmSync(live, { recursive: true, force: true });
      fs.renameSync(parked, live);
    };
  }
}
