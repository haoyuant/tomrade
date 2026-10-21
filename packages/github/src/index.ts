// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import { Context, Service } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/settings";
import type { Git, GitCredential } from "@tomradex/git";
import type { ConnectionState, ProviderConnection } from "@tomradex/storage";
import { GitHub, GitHubError, type Repo } from "./api.js";
import { DeviceFlow, OAuthError, type DeviceCode } from "./device.js";
import { githubEnvironment, installGithubCredential, migrateGithubCredential, usesTomradeCredential, withGithubCredential, writeGithubHelper, writeHelperToken } from "./helper.js";
import { SessionStore, type Cipher, type Session } from "./session.js";
import { errorMessage } from "@tomradex/contracts";

export { GitHub, GitHubError } from "./api.js";
export type { Repo } from "./api.js";
export { DeviceFlow, OAuthError, type DeviceCode, type Grant } from "./device.js";
export { githubHttps } from "./helper.js";
export type { Cipher, Session } from "./session.js";

declare module "cordis" {
  interface Context {
    github: GitHubAccount;
  }
}

/**
 * Where the personal access token is kept — per machine, because one account
 * serves every project. It is deliberately NOT a card of its own in Settings:
 * the connection is made where it is needed, in a project's destination or
 * Files block, and the settings dialog skips any section a provider claims.
 */
const SECTION = {
  id: "github",
  title: "GitHub",
  description: "The GitHub account Tomrade publishes with. Connected from a project's destination settings.",
  schema: z.object({ token: z.string().meta({ format: "password" }) }),
  defaults: { token: "" },
  order: 20
};

export interface GitHubConfig {
  /** The Tomrade GitHub App's client ID. Signing in is offered only when it is set; a token always works. */
  clientId?: string;
  /** The App's name in its URL, for the page where the person chooses which repositories it may use. */
  appSlug?: string;
  /** Where the signed-in session is kept, encrypted with `cipher`. Without both it lasts until quit. */
  sessionFile?: string;
  cipher?: Cipher;
  /** Stand-ins for github.com and api.github.com, for tests. */
  webUrl?: string;
  apiUrl?: string;
  /** The device flow's poll interval unit in ms, for tests. */
  pollUnitMs?: number;
  /** The binary git's credential helper runs as Node; defaults to the running one. */
  nodeBinary?: string;
}

/** A session renews this long before it runs out, so git never meets an expired token while the app runs. */
const RENEW_AHEAD_MS = 15 * 60_000;
const RENEW_CHECK_MS = 5 * 60_000;

/**
 * The one GitHub account this machine uses. Everything that talks to GitHub —
 * the backlog's repository, the Files repository, code checkouts, publishing a
 * plugin — asks here, so the token is read in one place and never travels
 * inside a remote URL.
 *
 * Two ways in: signing in to the Tomrade GitHub App (short-lived tokens,
 * renewed here, only the repositories the person chose), or a personal access
 * token, kept as the fallback for when signing in is not possible. While both
 * are there the sign-in is used; if it stops working the token takes over.
 */
export class GitHubAccount extends Service {
  static inject = ["settings"];

  readonly api: GitHub;
  private readonly home: Context;
  private readonly flow: DeviceFlow | null;
  private readonly store: SessionStore;
  private helper: string | null = null;
  private session: Session | null | undefined;
  private renewing: Promise<Session | null> | null = null;
  private signingIn: { code: DeviceCode; abort: AbortController } | null = null;
  /** Why the last sign-in or renewal failed, until the next attempt. */
  private problem: string | null = null;
  /** Moves on every sign-out, so a renewal that was under way then cannot bring the session back. */
  private epoch = 0;
  private installed = new Map<string, { at: number; count: number }>();

  /** What a destination's account panel draws and does; storage and Files both offer it. */
  readonly connection: ProviderConnection;

  constructor(
    ctx: Context,
    public readonly config: GitHubConfig = {}
  ) {
    super(ctx, "github");
    this.home = ctx;
    this.api = new GitHub(() => this.token(), config.apiUrl);
    this.flow = config.clientId ? new DeviceFlow(config.clientId, config.webUrl, config.pollUnitMs) : null;
    this.store = new SessionStore(config.sessionFile, config.cipher);
    this.connection = {
      prompt: {
        label: "Personal access token",
        help: "A token with repo and workflow scopes. Tomrade finds and creates repositories with it, and can push both code and GitHub Actions workflows when your own git credentials cannot reach the remote.",
        url: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Tomrade",
        ...(this.flow ? { signIn: { name: "GitHub" } } : {})
      },
      status: () => this.status(),
      connect: (secret: string) => this.connectToken(secret),
      ...(this.flow ? { signIn: () => this.signIn() } : {}),
      disconnect: () => this.disconnect()
    };
  }

  [Service.init]() {
    this.home.settings.register(SECTION);
    try {
      this.helper = writeGithubHelper(this.settingsFile, this.config.nodeBinary);
    } catch (error) {
      this.home.logger.warn(`github: credential helper not written — ${errorMessage(error)}`);
    }
    this.publishToken();
    this.home.on("settings/changed", (next, previous) => {
      if ((next.github as { token?: string } | undefined)?.token !== (previous.github as { token?: string } | undefined)?.token) this.publishToken();
    });
    // Renewed ahead of time, and the helper's copy rewritten, so it is fresh whenever git asks.
    void this.liveSession().then((session) => session && this.keep(session));
    this.home.effect(() => {
      const timer = setInterval(() => void this.liveSession(), RENEW_CHECK_MS);
      return () => {
        clearInterval(timer);
        this.signingIn?.abort.abort();
      };
    }, "github renewal");
  }

  private get settingsFile(): string {
    return this.home.settings.config.path;
  }

  private personalToken(): string {
    return ((this.home.settings.get().github as { token?: string } | undefined)?.token ?? "").trim();
  }

  private loaded(): Session | null {
    if (this.session === undefined) this.session = this.store.load();
    return this.session;
  }

  private keep(session: Session | null): void {
    this.session = session;
    try {
      this.store.save(session);
    } catch (error) {
      this.home.logger.warn(`github: sign-in not saved — ${errorMessage(error)}`);
    }
    this.publishToken();
  }

  /** What the helper hands git: the session's token, else the personal one, which git can't read sealed in settings. */
  private publishToken(): void {
    const session = this.loaded();
    const personal = this.personalToken();
    try {
      writeHelperToken(this.settingsFile, session ? { token: session.accessToken, expiresAt: session.accessExpiresAt } : personal ? { token: personal, expiresAt: null } : null);
    } catch (error) {
      this.home.logger.warn(`github: token for git not written — ${errorMessage(error)}`);
    }
  }

  /** The signed-in session with time left on it, renewing it first if it is about to run out; null when there is none. */
  private async liveSession(): Promise<Session | null> {
    const session = this.loaded();
    if (!session) return null;
    if (session.accessExpiresAt === null || session.accessExpiresAt - Date.now() > RENEW_AHEAD_MS) return session;
    this.renewing ??= this.renew(session).finally(() => (this.renewing = null));
    return this.renewing;
  }

  private async renew(session: Session): Promise<Session | null> {
    const usable = session.accessExpiresAt !== null && session.accessExpiresAt > Date.now();
    if (!this.flow || !session.refreshToken || (session.refreshExpiresAt !== null && session.refreshExpiresAt <= Date.now())) {
      if (usable) return session;
      return this.lose("The GitHub sign-in ran out — sign in again");
    }
    const epoch = this.epoch;
    try {
      const grant = await this.flow.refresh(session.refreshToken);
      if (epoch !== this.epoch) return null;
      const next = { ...grant, login: session.login };
      this.problem = null;
      this.keep(next);
      return next;
    } catch (error) {
      if (epoch !== this.epoch) return null;
      // Offline: keep the session for when GitHub can be reached, and use what is left of it.
      if (error instanceof OAuthError && error.code === "http") return usable ? session : null;
      return this.lose("GitHub would not renew the sign-in — sign in again");
    }
  }

  private lose(why: string): null {
    this.problem = why;
    this.keep(null);
    return null;
  }

  /** The token to call GitHub with: the sign-in's, else the personal access token, else "". */
  async token(): Promise<string> {
    return (await this.liveSession())?.accessToken ?? this.personalToken();
  }

  async status(): Promise<ConnectionState> {
    if (this.signingIn) {
      const { code } = this.signingIn;
      return { connected: false, pending: { code: code.userCode, url: code.verificationUri, expiresAt: code.expiresAt } };
    }
    const session = await this.liveSession();
    if (session) {
      try {
        const login = await this.api.whoami();
        return { connected: true, label: `@${login}`, action: await this.access(session.accessToken) };
      } catch (error) {
        // Revoked on GitHub: the sign-in is gone, and a token, if there is one, takes over.
        if (error instanceof GitHubError && error.status === 401) this.lose("The GitHub sign-in was revoked — sign in again");
        else return { connected: false, detail: error instanceof GitHubError ? error.message : "Could not reach GitHub" };
      }
    }
    if (!this.personalToken()) return { connected: false, ...(this.problem ? { detail: this.problem } : {}) };
    try {
      return { connected: true, label: `@${await this.api.whoami()}` };
    } catch (error) {
      return { connected: false, detail: error instanceof GitHubError ? error.message : "Could not reach GitHub" };
    }
  }

  /**
   * The App reaches only the repositories it was installed on. Until there is
   * one the step is needed; after, the same page changes the choice.
   */
  private async access(token: string): Promise<ConnectionState["action"]> {
    if (!this.config.appSlug) return undefined;
    const url = `${this.config.webUrl ?? "https://github.com"}/apps/${this.config.appSlug}/installations/new`;
    let known = this.installed.get(token);
    if (!known || Date.now() - known.at > 60_000) {
      const count = await new GitHub(() => token, this.config.apiUrl).installations().catch(() => null);
      if (count === null) return { label: "Choose repositories", url, needed: false };
      known = { at: Date.now(), count };
      this.installed.set(token, known);
    }
    return known.count ? { label: "Choose repositories", url, needed: false } : { label: "Give Tomrade access to your repositories", url, needed: true };
  }

  /** The repositories Tomrade can use: a signed-in App's installed ones, else every one the token's account reaches. */
  async repositories(): Promise<Repo[]> {
    return (await this.liveSession()) ? this.api.installed() : this.api.mine();
  }

  /** The login of the connected account, as "@login", or null. */
  async account(): Promise<string | null> {
    const state = await this.status();
    return state.connected ? (state.label ?? null) : null;
  }

  /** Start signing in; the person enters the returned code on GitHub, and `status()` reports when it lands. */
  async signIn(): Promise<ConnectionState> {
    if (!this.flow) throw new Error("Signing in with GitHub is not set up in this build; use a personal access token");
    this.signingIn?.abort.abort();
    this.problem = null;
    const code = await this.flow.start();
    const abort = new AbortController();
    const attempt = { code, abort };
    this.signingIn = attempt;
    void this.flow
      .poll(code, abort.signal)
      .then(async (grant) => {
        const login = await new GitHub(() => grant.accessToken, this.config.apiUrl).whoami();
        if (this.signingIn !== attempt) return;
        this.keep({ ...grant, login });
      })
      .catch((error) => {
        if (this.signingIn === attempt && !abort.signal.aborted) this.problem = errorMessage(error);
      })
      .finally(() => {
        if (this.signingIn === attempt) this.signingIn = null;
      });
    return this.status();
  }

  private async connectToken(secret: string): Promise<ConnectionState> {
    const trimmed = secret.trim();
    if (!trimmed) return { connected: false, detail: "Paste a token first" };
    // Verified before it is stored: a token that does not work is never saved.
    const login = await new GitHub(() => trimmed, this.config.apiUrl).whoami();
    this.home.settings.set({ ...this.home.settings.get(), github: { token: trimmed } });
    this.problem = null;
    return { connected: true, label: `@${login}` };
  }

  /** Signs out, forgets the token, and calls off a sign-in under way. */
  async disconnect(): Promise<void> {
    this.epoch++;
    this.signingIn?.abort.abort();
    this.signingIn = null;
    this.problem = null;
    this.keep(null);
    this.home.settings.set({ ...this.home.settings.get(), github: { token: "" } });
  }

  /**
   * For Tomrade's own git commands against github.com: the helper as the only
   * credential. Null while no account is connected, which leaves the user's own
   * git credentials (SSH keys, keychain) in charge.
   */
  credential(): GitCredential | null {
    return this.helper && (this.loaded() || this.personalToken()) ? { url: "https://github.com", helper: this.helper } : null;
  }

  // ── code checkouts: the helper written into a checkout's own config, for the agents working there ──

  installHelper(git: Git, checkout: string): Promise<void> {
    return installGithubCredential(git, checkout, this.settingsFile, this.config.nodeBinary);
  }

  migrateHelper(git: Git, checkout: string): Promise<boolean> {
    return migrateGithubCredential(git, checkout, this.settingsFile, this.config.nodeBinary);
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
