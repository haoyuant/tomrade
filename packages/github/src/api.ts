const BASE = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface Repo {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  pushed_at: string | null;
}

/** Thin REST client. Used only for discovery and creation; moving bytes is git's job. */
export class GitHub {
  constructor(
    private readonly token: () => string | Promise<string>,
    private readonly base = BASE
  ) {}

  private async send(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
    const token = await this.token();
    if (!token) throw new GitHubError(401, "No GitHub token configured — add one in Settings → GitHub.");
    return fetch(`${this.base}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tomrade",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    return this.answer<T>(await this.send(method, route, body), route);
  }

  private async answer<T>(res: Response, route: string): Promise<T> {
    if (res.status === 404) throw new GitHubError(404, `${route} not found`);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const parsed = (() => {
        try {
          return (JSON.parse(detail) as { message?: string }).message;
        } catch {
          return undefined;
        }
      })();
      // A signed-in App reaches only what it was given; say so rather than GitHub's terse words.
      if (res.status === 403 && parsed === "Resource not accessible by integration") {
        throw new GitHubError(403, "Tomrade's GitHub App has no access to this — give it the repository on GitHub (Choose repositories), or use a personal access token");
      }
      throw new GitHubError(res.status, parsed ?? `GitHub returned ${res.status}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Any other REST call, for the plugins that talk to GitHub through this account. */
  request<T>(method: string, route: string, body?: unknown): Promise<T> {
    return this.call<T>(method, route, body);
  }

  /** A GET that spends no rate limit when nothing changed: null when GitHub says the `etag` of the last answer still holds. */
  async conditional<T>(route: string, etag: string | null): Promise<{ etag: string | null; body: T } | null> {
    const res = await this.send("GET", route, undefined, etag ? { "If-None-Match": etag } : undefined);
    if (res.status === 304) return null;
    return { etag: res.headers.get("etag"), body: await this.answer<T>(res, route) };
  }

  login(): Promise<{ login: string }> {
    return this.call("GET", "/user");
  }

  /** A token's account never changes, so ask once per token. */
  private known = new Map<string, string>();

  async whoami(): Promise<string> {
    const token = await this.token();
    const hit = this.known.get(token);
    if (hit) return hit;
    const { login } = await this.login();
    this.known.set(token, login);
    return login;
  }

  async exists(owner: string, repo: string): Promise<Repo | null> {
    try {
      return await this.call<Repo>("GET", `/repos/${owner}/${repo}`);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Who can read a repository. With access, GitHub says; without it — no
   * token, or an App not given this repository — only a public one can be
   * read anonymously.
   */
  async visibility(owner: string, repo: string): Promise<"public" | "private" | "unknown"> {
    if (await this.token()) {
      const found = await this.exists(owner, repo).catch((error) => {
        if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) return null;
        throw error;
      });
      if (found) return found.private ? "private" : "public";
    }
    const res = await fetch(`${this.base}/repos/${owner}/${repo}`, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tomrade" } });
    if (res.status === 404) return "private";
    if (!res.ok) throw new GitHubError(res.status, `GitHub returned ${res.status}`);
    return ((await res.json()) as Repo).private ? "private" : "public";
  }

  /** Private by default: a backlog is not public unless someone says so. */
  async create(owner: string, repo: string, opts: { private?: boolean; autoInit?: boolean; description?: string } = {}): Promise<Repo> {
    const me = await this.login();
    const body = { name: repo, private: opts.private ?? true, auto_init: opts.autoInit ?? true, description: opts.description ?? "Tomrade backlog" };
    return owner.toLowerCase() === me.login.toLowerCase()
      ? this.call<Repo>("POST", "/user/repos", body)
      : this.call<Repo>("POST", `/orgs/${owner}/repos`, body);
  }

  /** How many installations of the signed-in App this account can use; only for a sign-in, not a personal token. */
  async installations(): Promise<number> {
    return (await this.call<{ total_count: number }>("GET", "/user/installations?per_page=1")).total_count;
  }

  /**
   * The repositories a signed-in App's token reaches — those of every
   * installation the person can use — newest push first. `mine()` would list
   * everything the account sees, App or not.
   */
  async installed(): Promise<Repo[]> {
    const { installations } = await this.call<{ installations: { id: number }[] }>("GET", "/user/installations?per_page=100");
    const repos: Repo[] = [];
    for (const { id } of installations) {
      for (let page = 1; ; page++) {
        const { repositories } = await this.call<{ repositories: Repo[] }>("GET", `/user/installations/${id}/repositories?per_page=100&page=${page}`);
        repos.push(...repositories);
        if (repositories.length < 100) break;
      }
    }
    return repos.sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));
  }

  async mine(): Promise<Repo[]> {
    return this.call<Repo[]>("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,organization_member");
  }
}
