import { gitRunner } from "@tomradex/storage";
import { GitFileStore, type GitRemoteTarget } from "./git-store.js";
import type { FilesBackend, FilesConnection } from "./types.js";

export interface GitBackendOptions<C> {
  id: string;
  title: string;
  description?: string;
  configSchema: FilesBackend<C>["configSchema"];
  defaults: C;
  settingsSection?: string;
  connection?: FilesConnection;
  browse?: FilesBackend<C>["browse"];
  draft?: FilesBackend<C>["draft"];
  describe?: (config: C) => string;
  /** The git remote a config stands for; null for a backend that shares nothing. */
  remote: ((config: C) => Promise<GitRemoteTarget> | GitRemoteTarget) | null;
  /** Bring the remote into being — create the repository, say. */
  ensureRemote?: (config: C) => Promise<void>;
}

/**
 * A backend that keeps the files as a git repository and, given a remote,
 * shares them through it. What a remote backend adds is exactly what git
 * cannot do by itself: name the remote from a non-secret config, find one,
 * make one.
 */
export function createGitBackend<C>(opts: GitBackendOptions<C>): FilesBackend<C> {
  return {
    id: opts.id,
    title: opts.title,
    description: opts.description,
    configSchema: opts.configSchema,
    defaults: opts.defaults,
    settingsSection: opts.settingsSection,
    connection: opts.connection,
    browse: opts.browse,
    draft: opts.draft,
    describe: opts.describe,
    open(o) {
      const config = o.remote;
      const shared = opts.remote && config !== null;
      return new GitFileStore({
        git: gitRunner(o.env.gitBinary),
        gitBinary: o.env.gitBinary,
        dir: o.dir,
        remote: shared ? () => opts.remote!(config) : null,
        ensureRemote: shared && opts.ensureRemote ? () => opts.ensureRemote!(config) : undefined,
        location: shared && opts.describe ? opts.describe(config) : null,
        warn: o.warn,
        onChange: o.onChange,
        watch: o.env.watch,
        settleMs: o.env.settleMs,
        pushMs: o.env.pushMs
      }).open();
    }
  };
}
