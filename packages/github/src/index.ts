// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/settings";
import type { Git } from "@tomradex/storage";
import { GitHub, GitHubError } from "./api.js";
import { githubEnvironment, installGithubCredential, migrateGithubCredential, usesTomradeCredential, withGithubCredential, writeGithubHelper } from "./helper.js";

export { GitHub, GitHubError } from "./api.js";
export type { Repo } from "./api.js";
export { githubHttps } from "./helper.js";

declare module "cordis" {
  interface Context {
    github: GitHubAccount;
  }
}

/**
 * Where the token is kept — per machine, because one account serves every
 * project. It is deliberately NOT a card of its own in Settings: the connection
 * is made where it is needed, in a project's destination or Files block, and
 * the settings dialog skips any section a storage provider claims.
 */
const SECTION = {
  id: "github",
  title: "GitHub",
  description: "The GitHub account Tomrade publishes with. Connected from a project's destination settings.",
  schema: z.object({ token: z.string().meta({ format: "password" }) }),
  defaults: { token: "" },
  order: 20
};

export interface GitHubConnectionState {
  connected: boolean;
  label?: string;
  detail?: string;
}

/** A git credential helper for one URL prefix, used by a single git command rather than written to any config. */
export interface GitCredential {
  url: string;
  helper: string;
}

/**
 * The one GitHub account this machine uses. Everything that talks to GitHub —
 * the backlog's repository, the Files repository, code checkouts, publishing a
 * plugin — asks here, so the token is read in one place and never travels
 * inside a remote URL.
 */
export class GitHubAccount extends Service {
  static inject = ["settings"];

  readonly api: GitHub;
  private readonly home: Context;
  private helper: string | null = null;

  /** What a destination's account panel draws and does; storage and Files both offer it. */
  readonly connection = {
    prompt: {
      label: "Personal access token",
      help: "A token with repo and workflow scopes. Tomrade finds and creates repositories with it, and can push both code and GitHub Actions workflows when your own git credentials cannot reach the remote.",
      url: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Tomrade"
    },
    status: (): Promise<GitHubConnectionState> => this.status(),
    connect: async (secret: string): Promise<GitHubConnectionState> => {
      const trimmed = secret.trim();
      if (!trimmed) return { connected: false, detail: "Paste a token first" };
      // Verified before it is stored: a token that does not work is never saved.
      const login = await new GitHub(() => trimmed).whoami();
      this.home.settings.set({ ...this.home.settings.get(), github: { token: trimmed } });
      return { connected: true, label: `@${login}` };
    },
    disconnect: async (): Promise<void> => {
      this.home.settings.set({ ...this.home.settings.get(), github: { token: "" } });
    }
  };

  constructor(ctx: Context) {
    super(ctx, "github");
    this.home = ctx;
    this.api = new GitHub(() => this.token());
  }

  [Service.init]() {
    this.home.settings.register(SECTION);
    try {
      this.helper = writeGithubHelper(this.settingsFile);
    } catch (error) {
      this.home.logger.warn(`github: credential helper not written — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private get settingsFile(): string {
    return this.home.settings.config.path;
  }

  private personalToken(): string {
    return ((this.home.settings.get().github as { token?: string } | undefined)?.token ?? "").trim();
  }

  /** The token to call GitHub with, or "" when no account is connected. */
  async token(): Promise<string> {
    return this.personalToken();
  }

  async status(): Promise<GitHubConnectionState> {
    if (!this.personalToken()) return { connected: false };
    try {
      return { connected: true, label: `@${await this.api.whoami()}` };
    } catch (error) {
      return { connected: false, detail: error instanceof GitHubError ? error.message : "Could not reach GitHub" };
    }
  }

  /** The login of the connected account, or null. */
  async account(): Promise<string | null> {
    const state = await this.status();
    return state.connected ? (state.label ?? null) : null;
  }

  /**
   * For Tomrade's own git commands against github.com: the helper as the only
   * credential. Null while no account is connected, which leaves the user's own
   * git credentials (SSH keys, keychain) in charge.
   */
  credential(): GitCredential | null {
    return this.helper && this.personalToken() ? { url: "https://github.com", helper: this.helper } : null;
  }

  // ── code checkouts: the helper written into a checkout's own config, for the agents working there ──

  installHelper(git: Git, checkout: string): Promise<void> {
    return installGithubCredential(git, checkout, this.settingsFile);
  }

  migrateHelper(git: Git, checkout: string): Promise<boolean> {
    return migrateGithubCredential(git, checkout, this.settingsFile);
  }

  usesHelper(git: Git, checkout: string): Promise<boolean> {
    return usesTomradeCredential(git, checkout, this.settingsFile);
  }

  /** GH_TOKEN for a subprocess in an opted-in checkout; empty for any other. */
  environment(git: Git, checkout: string): Promise<Record<string, string>> {
    return githubEnvironment(git, checkout, this.settingsFile, () => this.token());
  }

  /** A shell command run with the account's token in GH_TOKEN, without the token appearing in the command. */
  wrap(command: string): string {
    return withGithubCredential(this.settingsFile, command);
  }
}

export default GitHubAccount;
