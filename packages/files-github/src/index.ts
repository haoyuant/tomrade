// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomrade/settings";
import { createGitBackend, type FilesConnection } from "@tomrade/files";
import { GitHub, GitHubError } from "@tomrade/storage-github";

/** Per project and non-secret: it travels in the project's folder. */
const RepoConfig = z.object({
  owner: z.string().min(1).meta({ title: "Owner" }).describe("GitHub user or organisation"),
  repo: z.string().min(1).meta({ title: "Repository" }).describe("Created for you if it does not exist yet"),
  branch: z.string().min(1).default("main").meta({ title: "Branch" }).describe("The branch the files are kept on"),
  directory: z.string().default("").refine((value) => value === "" || (!value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => !!part && part !== "." && part !== ".." && !part.startsWith("."))), "Use a relative folder such as project-files, without hidden or parent directories")
    .meta({ title: "Files directory" }).describe("Only this folder appears in Files. Use project-files for a monorepo; leave empty only for a repository dedicated to Files.")
});
type RepoConfig = z.infer<typeof RepoConfig>;

/**
 * The token section belongs to `@tomrade/storage-github`, which registers it;
 * one account publishes both the backlog and the files. Without that plugin
 * the value is still read and written here — settings keep what they are
 * given — so connecting from a project's Files block works either way.
 */
const SECTION = "github";

/**
 * GitHub adds to the git-backed store exactly what git cannot do by itself:
 * name the remote from an owner and a repository, find one, make one.
 */
export const filesGithub = {
  name: "files-github",
  inject: ["files", "settings"],
  apply(ctx: Context) {
    const token = () => ((ctx.settings.get()[SECTION] as { token?: string } | undefined)?.token ?? "").trim();
    const api = new GitHub(token);

    const connection: FilesConnection = {
      prompt: {
        label: "Personal access token",
        help: "A token with the repo scope. Tomrade finds and creates the files repository with it and pushes with it.",
        url: "https://github.com/settings/tokens/new?scopes=repo&description=Tomrade%20files"
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
        ctx.settings.set({ ...ctx.settings.get(), [SECTION]: { token: trimmed } });
        return { connected: true, label: `@${login}` };
      },
      async disconnect() {
        ctx.settings.set({ ...ctx.settings.get(), [SECTION]: { token: "" } });
      }
    };

    ctx.files.register(
      createGitBackend<RepoConfig>({
        id: "github",
        title: "A GitHub repository",
        description: "Share files through a GitHub repository or a folder inside a monorepo. Files only manages the selected folder.",
        configSchema: RepoConfig,
        defaults: { owner: "", repo: "", branch: "main", directory: "" },
        settingsSection: SECTION,
        connection,
        describe: (c) => `github.com/${c.owner}/${c.repo} · ${c.branch}${c.directory ? ` · ${c.directory}/` : " · repository root"}`,

        /** "files" or "acme/files" — the account fills in the rest. */
        async draft(name) {
          const trimmed = name.trim();
          const [first, second] = trimmed.split("/");
          const owner = second ? first! : await api.whoami();
          const repo = (second ?? first ?? "files").replace(/[^A-Za-z0-9._-]/g, "-") || "files";
          return { owner, repo, branch: "main", directory: "project-files" };
        },

        // A token, when there is one, authenticates the push; without one the
        // user's own SSH keys or credential helper are used instead.
        remote: (c) => {
          const secret = token();
          const host = secret ? `x-access-token:${secret}@github.com` : "github.com";
          return { url: `https://${host}/${c.owner}/${c.repo}.git`, branch: c.branch, directory: c.directory };
        },

        async ensureRemote(c) {
          if (!token()) return; // nothing to check with; let git report what it finds
          if (await api.exists(c.owner, c.repo)) return;
          // No README: the first push must not have to merge with a commit nobody made.
          await api.create(c.owner, c.repo, { autoInit: false, description: "Tomrade files" });
        },

        async browse() {
          const repos = await api.mine();
          return repos.map((r) => ({
            label: `${r.full_name}${r.private ? " (private)" : ""}`,
            config: { owner: r.owner.login, repo: r.name, branch: r.default_branch || "main", directory: "project-files" }
          }));
        }
      })
    );
  }
};

export default filesGithub;
