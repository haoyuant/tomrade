// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/settings";
import type {} from "@tomrade/storage";
import type { ProviderConnection } from "@tomrade/storage";
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
  owner: z.string().min(1).meta({ title: "Owner" }).describe("GitHub user or organisation"),
  repo: z.string().min(1).meta({ title: "Repository" }).describe("Created for you if it does not exist yet"),
  branch: z.string().min(1).default("main").meta({ title: "Branch" }).describe("The branch the backlog is committed on"),
  path: z.string().default("").meta({ title: "Subdirectory" }).describe("Where in the repository to commit; blank for the root")
});
type RepoConfig = z.infer<typeof RepoConfig>;

/**
 * Where the token is kept — per machine, because one account serves every
 * project. It is deliberately NOT a card of its own in Settings: the connection
 * is made where it is needed, in a project's own destination block, and the
 * settings dialog skips any section a storage provider claims.
 */
const TOKEN_SECTION = {
  id: "github",
  title: "GitHub",
  description: "The GitHub account Tomrade publishes with. Connected from a project's destination settings.",
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

    const connection: ProviderConnection = {
      prompt: {
        label: "Personal access token",
        help: "A token with repo scope. Tomrade finds and creates repositories with it, and pushes with it when your own git credentials cannot reach the remote.",
        url: "https://github.com/settings/tokens/new?scopes=repo&description=Tomrade"
      },
      async status() {
        if (!token()) return { connected: false };
        try {
          return { connected: true, label: `@${await api.whoami()}` };
        } catch (error) {
          return { connected: false, detail: error instanceof GitHubError ? error.message : "Could not reach GitHub" };
        }
      },
      async connect(secret) {
        const trimmed = secret.trim();
        if (!trimmed) return { connected: false, detail: "Paste a token first" };
        // Verified before it is stored: a token that does not work is never saved.
        const login = await new GitHub(() => trimmed).whoami();
        ctx.settings.set({ ...ctx.settings.get(), github: { token: trimmed } });
        return { connected: true, label: `@${login}` };
      },
      async disconnect() {
        ctx.settings.set({ ...ctx.settings.get(), github: { token: "" } });
      }
    };

    ctx.storage.register(
      createGitProvider<RepoConfig>(
        {
          id: "github",
          title: "A GitHub repository",
          description: "Tomrade keeps a clone and commits the backlog as text. Private by default.",
          configSchema: RepoConfig,
          defaults: { owner: "", repo: "", branch: "main", path: "" },
          settingsSection: "github",
          connection,

          /** "backlog" or "acme/backlog" — the account fills in the rest. */
          async draft(name) {
            const trimmed = name.trim();
            const [first, second] = trimmed.split("/");
            const owner = second ? first : await api.whoami();
            const repo = (second ?? first).replace(/[^A-Za-z0-9._-]/g, "-");
            return { owner, repo, branch: "main", path: "" };
          },

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
