import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/storage";
import { createGitProvider, type GitRuntime } from "./provider.js";

export { createGitProvider } from "./provider.js";
export type { GitProviderOptions, GitRuntime, GitTarget } from "./provider.js";
export { GitError, GitMissingError, gitRunner } from "./run.js";
export type { Git } from "./run.js";

export const GitConfig = z.object({
  /** Where clones live. Inside userData: the live database is never here, only text. */
  root: z.string(),
  binary: z.string().default("git")
});
export type GitConfig = z.infer<typeof GitConfig>;

const RemoteConfig = z.object({
  remote: z.string().min(1).meta({ title: "Repository URL" }).describe("Any repository you can push to — https://… or git@…"),
  branch: z.string().min(1).default("main").meta({ title: "Branch" }).describe("The branch the backlog is committed on"),
  path: z
    .string()
    .default("")
    .meta({ title: "Subdirectory" })
    .describe("Where in the repository to commit — e.g. docs, to keep the backlog beside the code. Blank for the root.")
});

/**
 * Any repository the user can already push to: their own project repository, a
 * repository kept just for the backlog, self-hosted, or a bare repository on a
 * NAS. Nothing about the host or the URL is assumed.
 *
 * Tomrade owns two things and nothing else — the clone it keeps under userData,
 * and the subtree named by `path`. It commits only that subtree, so the rest of
 * a working repository is never touched. Credentials are the ones git already
 * has (SSH keys, credential helpers), so nothing secret is stored here; a
 * hosting plugin adds repository discovery and creation on top.
 */
export const storageGit = {
  name: "storage-git",
  inject: ["storage"],
  Config: GitConfig,
  apply(ctx: Context, config: GitConfig) {
    const runtime: GitRuntime = { root: config.root, binary: config.binary };
    ctx.storage.register(
      createGitProvider(
        {
          id: "git",
          title: "A git repository",
          description: "Any repository you can already push to. Uses your own SSH keys or credential helper.",
          configSchema: RemoteConfig,
          defaults: { remote: "", branch: "main", path: "" },
          toTarget: (c) => ({ remote: c.remote, branch: c.branch, path: c.path })
        },
        runtime
      )
    );
  }
};

export default storageGit;
