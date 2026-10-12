// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/github";
import type {} from "@tomradex/storage";
import { createRemoteProvider } from "@tomradex/storage-git";

export { GitHub, GitHubError } from "@tomradex/github";
export type { Repo } from "@tomradex/github";

/** Per-project and non-secret, so it can be committed beside the code it tracks. */
const RepoConfig = z.object({
  owner: z.string().min(1).meta({ title: "Owner" }).describe("GitHub user or organisation"),
  repo: z.string().min(1).meta({ title: "Repository" }).describe("Created for you if it does not exist yet"),
  branch: z.string().min(1).default("main").meta({ title: "Branch" }).describe("The branch the backlog is committed on")
});
type RepoConfig = z.infer<typeof RepoConfig>;

/**
 * GitHub is not a peer of "a folder I choose" — it is a hosting choice on top of
 * the git provider. This plugin adds exactly what git cannot do by itself:
 * find a repository, and make one. The account is `ctx.github`'s.
 */
export const storageGithub = {
  name: "storage-github",
  inject: ["storage", "github"],
  apply(ctx: Context) {
    const api = ctx.github.api;

    ctx.storage.register(
      createRemoteProvider<RepoConfig>({
          id: "github",
          title: "A GitHub repository",
          description: "The project's own repository on GitHub, pushed as text. Private by default.",
          configSchema: RepoConfig,
          defaults: { owner: "", repo: "", branch: "main" },
          settingsSection: "github",
          connection: ctx.github.connection,
          credential: () => ctx.github.credential(),

          /** "backlog" or "acme/backlog" — the account fills in the rest. */
          async draft(name) {
            const trimmed = name.trim();
            const [first, second] = trimmed.split("/");
            const owner = second ? first : await api.whoami();
            const repo = (second ?? first).replace(/[^A-Za-z0-9._-]/g, "-");
            return { owner, repo, branch: "main" };
          },

          // The URL never carries the token: `credential` hands it to git, and
          // without an account the user's own SSH keys or helper are used.
          toRemote: (c) => ({ url: `https://github.com/${c.owner}/${c.repo}.git`, branch: c.branch }),

          async ensureRemote(c) {
            if (!(await ctx.github.token())) return; // nothing to check with; let git report what it finds
            const existing = await api.exists(c.owner, c.repo);
            if (existing) return;
            await api.create(c.owner, c.repo);
          },

          visibility: (c) => api.visibility(c.owner, c.repo),

          async browse() {
            const repos = await ctx.github.repositories();
            return repos.map((r) => ({
              label: `${r.full_name}${r.private ? " (private)" : ""}`,
              config: { owner: r.owner.login, repo: r.name, branch: r.default_branch || "main" }
            }));
          }
      })
    );
  }
};

export default storageGithub;
