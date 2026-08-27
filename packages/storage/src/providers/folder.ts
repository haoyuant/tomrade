import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ARTIFACT_DIR, hasArtifact } from "../state.js";
import type { StorageHandle, StorageProvider } from "../types.js";

export const FolderConfig = z.object({
  dir: z.string().min(1).meta({ format: "directory" }).describe("Folder that holds this project's .tomrade artifact")
});
export type FolderConfig = z.infer<typeof FolderConfig>;

/**
 * A directory the user picked — typically inside a code repository, so the
 * backlog is committed with the code and a teammate gets it by cloning. No
 * network, no credentials. Change detection is the artifact's own digest, so an
 * edit that arrives by git, rsync or Finder is noticed the same way.
 */
export const folderProvider: StorageProvider<FolderConfig> = {
  id: "folder",
  title: "A folder I choose",
  description: "A directory on this machine — put it inside a code repository and the backlog travels with the code.",
  configSchema: FolderConfig,
  defaults: { dir: "" },

  async open(config, opts): Promise<StorageHandle> {
    const dir = path.resolve(config.dir);
    if (!opts.create && !hasArtifact(dir)) throw new Error(`${dir} holds no Tomrade project`);
    fs.mkdirSync(path.join(dir, ARTIFACT_DIR), { recursive: true });
    let watcher: fs.FSWatcher | undefined;
    return {
      location: dir,
      dir,
      // The folder IS the destination: nothing is fetched, and a change made in
      // it is found by comparing digests rather than by pulling.
      pull: async () => ({ changed: false }),
      push: async () => {},
      status: async () => ({ state: "synced" as const, location: dir }),
      watch(onChange) {
        try {
          watcher = fs.watch(path.join(dir, ARTIFACT_DIR), { recursive: true }, () => onChange());
        } catch {
          return () => {};
        }
        return () => watcher?.close();
      },
      dispose: async () => {
        watcher?.close();
      }
    };
  }
};
