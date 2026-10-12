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
  constructor(private readonly token: () => string | Promise<string>) {}

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const token = await this.token();
    if (!token) throw new GitHubError(401, "No GitHub token configured — add one in Settings → GitHub.");
    const res = await fetch(`${BASE}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tomrade",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
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
      throw new GitHubError(res.status, parsed ?? `GitHub returned ${res.status}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
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

  /** Private by default: a backlog is not public unless someone says so. */
  async create(owner: string, repo: string, opts: { private?: boolean; autoInit?: boolean; description?: string } = {}): Promise<Repo> {
    const me = await this.login();
    const body = { name: repo, private: opts.private ?? true, auto_init: opts.autoInit ?? true, description: opts.description ?? "Tomrade backlog" };
    return owner.toLowerCase() === me.login.toLowerCase()
      ? this.call<Repo>("POST", "/user/repos", body)
      : this.call<Repo>("POST", `/orgs/${owner}/repos`, body);
  }

  async mine(): Promise<Repo[]> {
    return this.call<Repo[]>("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,organization_member");
  }
}
