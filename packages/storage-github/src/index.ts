// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/settings";
import type {} from "@tomrade/storage";
import { createGitProvider, type GitRuntime, type GitTarget } from "@tomrade/storage-git";
import { GitHub, GitHubError } from "./api.js";

export { GitHub, GitHubError } from "./api.js";
export type { Repo } from "./api.js";

export const GitHubPluginConfig = z.object({
  /** Where clones live. Inside userData: only the text artifact is ever here. */
  root: z.string(),
  binary: z.string().default("git")
});
export type GitHubPluginConfig = z.infer<typeof GitHubPluginConfig>;

/** Per-project and non-secret, so it can be committed beside the code it tracks. */
const RepoConfig = z.object({
  owner: z.string().min(1).describe("GitHub user or organisation"),
  repo: z.string().min(1).describe("Repository name"),
  branch: z.string().min(1).default("main").describe("Branch the backlog is committed on"),
  path: z.string().default("").describe("Subdirectory inside the repository; blank for its root")
});
type RepoConfig = z.infer<typeof RepoConfig>;

const TOKEN_SECTION = {
  id: "github",
  title: "GitHub",
  description: "A personal access token with `repo` scope. Used to find and create repositories; pushing uses it too when your own git credentials cannot reach the remote.",
  schema: z.object({ token: z.string().meta({ format: "password" }) }),
  defaults: { token: "" },
  order: 20
};

/**
 * GitHub is not a peer of "a folder I choose" — it is a hosting choice on top of
 * the git provider. This plugin adds exactly what git cannot do by itself:
 * find a repository, and make one.
 */
export const storageGithub = {
  name: "storage-github",
  inject: ["storage", "settings"],
  Config: GitHubPluginConfig,
  apply(ctx: Context, config: GitHubPluginConfig) {
    ctx.settings.register(TOKEN_SECTION);
    const token = () => ((ctx.settings.get().github as { token?: string } | undefined)?.token ?? "").trim();
    const api = new GitHub(token);
    const runtime: GitRuntime = { root: config.root, binary: config.binary };

    ctx.storage.register(
      createGitProvider<RepoConfig>(
        {
          id: "github",
          title: "A GitHub repository",
          description: "Tomrade keeps a clone and commits the backlog as text. Private by default.",
          configSchema: RepoConfig,
          defaults: { owner: "", repo: "", branch: "main", path: "" },
          settingsSection: "github",

          // A token, when there is one, authenticates the push; without one the
          // user's own SSH keys or credential helper are used instead.
          toTarget: (c): GitTarget => {
            const secret = token();
            const host = secret ? `x-access-token:${secret}@github.com` : "github.com";
            return { remote: `https://${host}/${c.owner}/${c.repo}.git`, branch: c.branch, path: c.path };
          },

          async ensureRemote(c) {
            if (!token()) return; // nothing to check with; let git report what it finds
            const existing = await api.exists(c.owner, c.repo);
            if (existing) return;
            await api.create(c.owner, c.repo);
          },

          async browse() {
            const repos = await api.mine();
            return repos.map((r) => ({
              label: `${r.full_name}${r.private ? " (private)" : ""}`,
              config: { owner: r.owner.login, repo: r.name, branch: r.default_branch || "main", path: "" }
            }));
          }
        },
        runtime
      )
    );
  }
};

export default storageGithub;
