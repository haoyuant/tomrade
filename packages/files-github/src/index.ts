// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/github";
import { createGitBackend } from "@tomradex/files";

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
 * GitHub adds to the git-backed store exactly what git cannot do by itself:
 * name the remote from an owner and a repository, find one, make one. One
 * account — `ctx.github`'s — publishes both the backlog and the files.
 */
export const filesGithub = {
  name: "files-github",
  inject: ["files", "github"],
  apply(ctx: Context) {
    const api = ctx.github.api;

    ctx.files.register(
      createGitBackend<RepoConfig>({
        id: "github",
        title: "A GitHub repository",
        description: "Share files through a GitHub repository or a folder inside a monorepo. Files only manages the selected folder.",
        configSchema: RepoConfig,
        defaults: { owner: "", repo: "", branch: "main", directory: "" },
        settingsSection: "github",
        connection: ctx.github.connection,
        credential: () => ctx.github.credential(),
        describe: (c) => `github.com/${c.owner}/${c.repo} · ${c.branch}${c.directory ? ` · ${c.directory}/` : " · repository root"}`,

        /** "files" or "acme/files" — the account fills in the rest. */
        async draft(name) {
          const trimmed = name.trim();
          const [first, second] = trimmed.split("/");
          const owner = second ? first! : await api.whoami();
          const repo = (second ?? first ?? "files").replace(/[^A-Za-z0-9._-]/g, "-") || "files";
          return { owner, repo, branch: "main", directory: "project-files" };
        },

        // The URL never carries the token: `credential` hands it to git, and
        // without an account the user's own SSH keys or helper are used.
        remote: (c) => ({ url: `https://github.com/${c.owner}/${c.repo}.git`, branch: c.branch, directory: c.directory }),

        async ensureRemote(c) {
          if (!(await ctx.github.token())) return; // nothing to check with; let git report what it finds
          if (await api.exists(c.owner, c.repo)) return;
          // No README: the first push must not have to merge with a commit nobody made.
          await api.create(c.owner, c.repo, { autoInit: false, description: "Tomrade files" });
        },

        async browse() {
          const repos = await ctx.github.repositories();
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
