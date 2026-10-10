import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { check, type CheckReport } from "@tomradex/plugin-cli";
import { readManifest } from "@tomradex/plugin-kit";
import { MANIFEST_FILE, nameOf, namespaceOf, publisherOf } from "@tomradex/plugin-sdk";

const run = promisify(execFile);

/** What publishing needs from GitHub; the app's is backed by the token in Settings → GitHub. */
export interface GitHubAccess {
  login(): Promise<string>;
  /** Creates the public repository when it is not there yet. */
  ensureRepo(owner: string, name: string, description: string): Promise<void>;
  /** Where `git push` goes, and the extra git config that authenticates it without the token in argv. */
  remote(owner: string, name: string): { url: string; env: Record<string, string> };
}

export class PublishRefused extends Error {
  override name = "PublishRefused";
  constructor(
    message: string,
    public readonly report: CheckReport | null = null
  ) {
    super(message);
  }
}

export function githubAccess(token: () => string, fetchImpl: typeof fetch = fetch): GitHubAccess {
  const call = async (method: string, route: string, body?: unknown) => {
    const t = token();
    if (!t) throw new PublishRefused("Connect GitHub first: Settings → GitHub, a token with the repo scope");
    const res = await fetchImpl(`https://api.github.com${route}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000)
    });
    return res;
  };
  return {
    async login() {
      const res = await call("GET", "/user");
      if (!res.ok) throw new PublishRefused(`GitHub refused the token (${res.status})`);
      return String(((await res.json()) as { login: string }).login).toLowerCase();
    },
    async ensureRepo(owner, name, description) {
      const found = await call("GET", `/repos/${owner}/${name}`);
      if (found.ok) {
        if ((await found.json() as { private?: boolean }).private) throw new PublishRefused(`github.com/${owner}/${name} is private; the store takes plugins whose source anyone can read`);
        return;
      }
      if (found.status !== 404) throw new PublishRefused(`GitHub answered ${found.status} for ${owner}/${name}`);
      const created = await call("POST", "/user/repos", { name, description, private: false, has_wiki: false });
      if (!created.ok) throw new PublishRefused(`GitHub would not create ${owner}/${name} (${created.status})`);
    },
    remote(owner, name) {
      const basic = Buffer.from(`x-access-token:${token()}`).toString("base64");
      return {
        url: `https://github.com/${owner}/${name}.git`,
        env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`, GIT_TERMINAL_PROMPT: "0" }
      };
    }
  };
}

export interface Prepared {
  id: string;
  version: string;
  repository: string;
  commit: string;
  tag: string;
  manifest: Record<string, unknown>;
  /** The id changed from a local one to the publisher's. */
  renamedFrom: string | null;
  report: CheckReport;
}

const git = (dir: string, args: string[], env: Record<string, string> = {}) => run("git", args, { cwd: dir, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });

/**
 * Everything before the store is told: the plugin takes the publisher's id
 * (its namespace stays), passes the check, and its source is committed,
 * tagged and pushed to the publisher's public repository. The package is the
 * check's build of exactly that tree.
 */
export async function prepareRelease(dir: string, publisher: string, github: GitHubAccess, opts: { checkOptions?: Parameters<typeof check>[1] } = {}): Promise<Prepared> {
  const login = await github.login();
  if (login !== publisher.toLowerCase()) throw new PublishRefused(`the GitHub token belongs to ${login}, but this account publishes as ${publisher}`);

  const file = path.join(dir, MANIFEST_FILE);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const before = readManifest(dir);
  const renamedFrom = publisherOf(before.id) === login ? null : before.id;
  const name = nameOf(before.id);
  const repoName = typeof raw.repository === "string" && raw.repository.startsWith(`https://github.com/${login}/`) ? raw.repository.split("/").pop()!.replace(/\.git$/, "") : `tomrade-plugin-${name}`;
  raw.id = `${login}/${name}`;
  raw.namespace = namespaceOf(before);
  raw.repository = `https://github.com/${login}/${repoName}`;
  raw.author ??= { name: login };
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  const report = await check(dir, opts.checkOptions);
  if (report.verdict === "blocked") throw new PublishRefused(`fix these first:\n${report.problems.join("\n")}`, report);
  if (report.publishing.length) throw new PublishRefused(`before publishing:\n${report.publishing.join("\n")}`, report);

  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const version = String(manifest.version);
  const tag = `v${version}`;
  await github.ensureRepo(login, repoName, String(manifest.description ?? ""));
  const remote = github.remote(login, repoName);

  if (!fs.existsSync(path.join(dir, ".git"))) await git(dir, ["init", "-q", "-b", "main"]);
  const ignore = path.join(dir, ".gitignore");
  const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  if (!/^node_modules\/?$/m.test(ignored) || !/^dist\/?$/m.test(ignored)) fs.writeFileSync(ignore, `${ignored.trimEnd()}\nnode_modules/\ndist/\n*.tomrade-plugin\n`.trimStart());
  const tags = (await git(dir, ["tag", "--list", tag])).stdout.trim();
  if (tags) throw new PublishRefused(`${tag} was published already; raise the version in ${MANIFEST_FILE}`);
  await git(dir, ["add", "-A"]);
  const identity = ["-c", `user.name=${login}`, "-c", `user.email=${login}@users.noreply.github.com`];
  const dirty = (await git(dir, ["status", "--porcelain"])).stdout.trim();
  if (dirty || !(await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false))) await git(dir, [...identity, "commit", "-q", "-m", `Release ${tag}`]);
  await git(dir, [...identity, "tag", "-a", tag, "-m", `${manifest.title ?? name} ${version}`]);
  await git(dir, ["push", "-q", remote.url, "HEAD:refs/heads/main", `refs/tags/${tag}`], remote.env);
  const commit = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  return { id: String(manifest.id), version, repository: String(manifest.repository), commit, tag, manifest, renamedFrom, report };
}
