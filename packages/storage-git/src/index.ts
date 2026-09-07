import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/storage";
import { createRemoteProvider } from "./provider.js";

export { createRemoteProvider } from "./provider.js";
export type { RemoteProviderOptions } from "./provider.js";
export { GitError, GitFolder, GitMissingError, cleanRemote, cloneInto, gitRunner, shortHash } from "@tomrade/storage";
export type { Git } from "@tomrade/storage";

const RemoteConfig = z.object({
  remote: z.string().min(1).meta({ title: "Repository URL" }).describe("Any repository you can push to — https://… or git@…"),
  branch: z.string().min(1).default("main").meta({ title: "Branch" }).describe("The branch the backlog is committed on")
});

/**
 * Any repository the user can already push to: one kept just for the backlog,
 * self-hosted, or a bare repository on a NAS. Nothing about the host or the URL
 * is assumed. Credentials are the ones git already has (SSH keys, credential
 * helpers), so nothing secret is stored here; a hosting plugin adds repository
 * discovery and creation on top.
 */
export const storageGit = {
  name: "storage-git",
  inject: ["storage"],
  apply(ctx: Context) {
    ctx.storage.register(
      createRemoteProvider({
        id: "git",
        title: "A git repository",
        description: "Any repository you can already push to. Uses your own SSH keys or credential helper.",
        configSchema: RemoteConfig,
        defaults: { remote: "", branch: "main" },
        toRemote: (c) => ({ url: c.remote, branch: c.branch })
      })
    );
  }
};

export default storageGit;
