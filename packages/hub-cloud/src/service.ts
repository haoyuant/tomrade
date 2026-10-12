import { Context, Service } from "cordis";
import { createClient, type Session, type SupabaseClient, type SupportedStorage, type User } from "@supabase/supabase-js";
import { z } from "zod";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/projects";
import { emptyHub, type HubManifest, type HubProject, type StorageStatus } from "@tomradex/storage";
import type { UserSettingsFile } from "@tomradex/settings";
import { CloudCache, RecordSchema, recordKey, equal, type CloudRecord } from "./cache.js";

export interface AccountInfo {
  user: { id: string; email: string } | null;
  hubId: string | null;
  status: StorageStatus;
  pending: number;
  offlineAccess: boolean;
  conflicts: { id: string; local: unknown; cloud: unknown }[];
  /** Whose projects this local Hub holds, when one account already owns it. */
  owner: { email: string | null } | null;
  /** Set while another account's sign-in restarts Tomrade into that account's own local Hub. */
  switchingTo: string | null;
  /** Which dated Terms of Service and Privacy Policy this account agreed to, against the ones this build asks for. */
  terms: { current: string; accepted: string | null };
}

/**
 * The `updated` date of the Terms of Service and Privacy Policy on tomrade.com that this build
 * asks people to agree to. A material change to either gets a new date there and here.
 */
export const TERMS_VERSION = "2026-10-12";
const termsRecord = (version: string) => ({ terms_version: version, terms_accepted_at: new Date().toISOString() });

/**
 * The machine's local Hubs, one per account. The desktop shell supplies it;
 * without it, this local Hub refuses every account but its owner.
 */
export interface LocalAccounts {
  /** True when `userId` keeps a local Hub on this machine other than this one. */
  elsewhere(userId: string): boolean;
  /** This local Hub belongs to `user`. */
  claim(user: { id: string; email: string }): void;
  /** Store the session in the user's own local Hub, made if new, and restart into it. */
  open(user: { id: string; email: string }, session: { key: string; value: string }): Promise<void>;
}
declare module "cordis" { interface Context { cloudHub: CloudHub } }
declare module "@tomradex/ipc" {
  interface Channels {
    "account.info": () => AccountInfo;
    "account.signIn": (email: string, password: string, agreed?: boolean) => AccountInfo;
    "account.signUp": (email: string, password: string, lang?: string, agreed?: boolean) => { confirmationRequired: boolean };
    "account.acceptTerms": () => AccountInfo;
    "account.resendConfirmation": (email: string, lang?: string) => void;
    "account.resetPassword": (email: string, lang?: string) => void;
    "account.signOut": () => void;
    "account.sync": () => AccountInfo;
    "account.resolve": (id: string, choice: "local" | "cloud") => AccountInfo;
  }
  interface Broadcasts { "account.changed": () => void }
}

export const CloudConfig = z.object({
  url: z.url(), publishableKey: z.string().min(1), cacheFile: z.string().min(1),
  sessionStorage: z.custom<SupportedStorage>(v => !!v && typeof (v as SupportedStorage).getItem === "function"),
  syncMs: z.number().int().min(1000).default(30_000),
  accounts: z.custom<LocalAccounts>(v => !!v && typeof (v as LocalAccounts).open === "function").optional(),
  /** Where email links land: `/auth/confirmed/` and `/auth/reset/` on this site, under `/zh/` in Chinese. */
  site: z.url().default("https://tomrade.com")
});
type Config = z.infer<typeof CloudConfig>;
const Credentials = z.object({ email: z.email(), password: z.string().min(1).max(1024) });
const Result = z.object({ ok: z.boolean(), record: RecordSchema });
const UserSettings = z.object({
  v: z.literal(1),
  sections: z.record(z.string(), z.object({ value: z.json(), updatedAt: z.number() }))
});
const SETTINGS_KEY = "settings";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
// Failures carry a leading [code] the renderer translates; the rest is the fallback text.
const failure = (e: { message: string; code?: string; name?: string }) =>
  new Error(e.code ? `[${e.code}] ${e.message}` : e.name === "AuthRetryableFetchError" ? `[network] ${e.message}` : e.message);
function credentials(email: string, password: string, min = 1) {
  const parsed = Credentials.extend({ password: z.string().min(min).max(1024) }).safeParse({ email, password });
  if (parsed.success) return parsed.data;
  if (parsed.error.issues[0].path[0] === "email") throw new Error("[email_address_invalid] Enter a valid email address.");
  throw new Error(`[weak_password] Use a password of ${min} to 1024 characters.`);
}
const address = (email: string) => credentials(email, "-").email;

/** Supabase owns Hub metadata. The immutable outbox survives failed requests and process exits. */
export class CloudHub extends Service {
  static provide = "cloudHub";
  static inject = ["hub", "storage", "settings"];
  static Config = CloudConfig;
  readonly cache: CloudCache;
  readonly client: SupabaseClient;
  ready: Promise<void> = Promise.resolve();
  private user: User | null = null;
  private error: string | null = null;
  private active: Promise<void> | null = null;
  private closed = false;
  private home: Context;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private signingOut = false;
  private switchingTo: string | null = null;
  private sessionRead: Promise<void> = Promise.resolve();
  private readonly sessionKey: string;
  private readonly origin: string;
  private readonly fetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });

  constructor(ctx: Context, public config: Config) {
    super(ctx, "cloudHub");
    this.home = ctx;
    // An admin key in a desktop build defeats RLS. Accept publishable and legacy anon keys only.
    if (!config.publishableKey.startsWith("sb_publishable_")) {
      let role: unknown;
      try { role = JSON.parse(Buffer.from(config.publishableKey.split(".")[1], "base64url").toString()).role; } catch { /* refused below */ }
      if (role !== "anon") throw new Error("Use a Supabase publishable key or legacy anon key, never a secret/service-role key.");
    }
    const endpoint = new URL(config.url);
    if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("Supabase requires HTTPS outside localhost.");
    this.origin = endpoint.origin;
    this.cache = new CloudCache(config.cacheFile, endpoint.origin);
    // supabase-js's own default, named so sign-out can forget the session without the server.
    this.sessionKey = `sb-${endpoint.hostname.split(".")[0]}-auth-token`;
    this.client = createClient(endpoint.origin, config.publishableKey, {
      auth: { storage: config.sessionStorage, storageKey: this.sessionKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: this.fetch }
    });
  }

  [Service.init]() {
    const settings = this.ctx.settings;
    const disableCloud = this.ctx.hub.enableCloud();
    const offStorage = this.ctx.storage.useHubBackend({
      read: () => this.manifest(), observe: m => this.observe(m),
      removeProject: id => { this.cache.observe("project", id, null); this.schedule(); },
      sync: async () => { await this.sync(); return this.status(); }, status: () => this.status()
    });
    const offSettings = settings.useUserStore({
      read: () => this.preferences(),
      write: file => {
        this.cache.observe("preference", SETTINGS_KEY, JSON.parse(JSON.stringify(file)));
        this.schedule();
      }
    });
    if (!this.cache.data.migrated) {
      // The machine catalog is observed by storage.writeHub below. Local Hub
      // manifest/settings files are deliberately not migration inputs; the live
      // user-scope settings are, so the account starts with what this machine has.
      this.cache.observe("preference", SETTINGS_KEY, JSON.parse(JSON.stringify(settings.exportUser())));
      this.cache.data.migrated = true;
      this.cache.save();
    }
    settings.refreshUserStore();
    if (this.cache.data.userId) this.config.accounts?.claim({ id: this.cache.data.userId, email: this.cache.data.email ?? "" });
    this.home.inject(["ipc"], ctx => {
      // Account status is a local read. Session renewal must not hold an offline
      // user's project UI behind a network timeout; a locked one waits for the
      // stored session rather than flash the sign-in form.
      ctx.ipc.handle("account.info", async () => {
        if (!this.cache.data.offlineAccess) await this.sessionRead;
        return this.info();
      });
      ctx.ipc.handle("account.signIn", (email, password, agreed) => this.signIn(email, password, agreed));
      ctx.ipc.handle("account.signUp", (email, password, lang, agreed) => this.signUp(email, password, lang, agreed));
      ctx.ipc.handle("account.acceptTerms", () => this.acceptTerms());
      ctx.ipc.handle("account.resendConfirmation", (email, lang) => this.resendConfirmation(email, lang));
      ctx.ipc.handle("account.resetPassword", (email, lang) => this.resetPassword(email, lang));
      ctx.ipc.handle("account.signOut", () => this.signOut());
      ctx.ipc.handle("account.sync", async () => { await this.ctx.storage.writeHub(); await this.sync(); return this.info(); });
      ctx.ipc.handle("account.resolve", async (id, choice) => {
        z.enum(["local", "cloud"]).parse(choice);
        if (this.active) throw new Error("Wait for the current synchronization to finish.");
        this.cache.resolve(id, choice);
        settings.refreshUserStore();
        await this.sync();
        return this.info();
      });
    });
    const { data: { subscription } } = this.client.auth.onAuthStateChange((event, session) => {
      // Do not await another Supabase operation while its auth callback holds the session lock.
      this.user = session?.user ?? null;
      if (event === "SIGNED_OUT" && !this.signingOut) {
        // Expiry/revocation blocks new cloud requests. Offline project files are
        // still the user's; only an explicit local sign-out locks this UI.
        this.error = "Sign in again to synchronize your Hub. Local projects remain available.";
      }
      this.schedule();
      this.notify();
    });
    const session = this.client.auth.getSession().then(({ data, error }) => {
      if (error) this.error = error.message;
      this.user = data.session?.user ?? null;
    });
    this.sessionRead = session.catch(() => {});
    this.ready = session.then(async () => {
      await this.ctx.storage.ready;
      for (const project of this.ctx.hub.catalog.projects()) {
        if (!project.dir) await this.ctx.storage.materialize(project.id);
      }
      await this.ctx.storage.writeHub();
      this.schedule();
    }).catch(e => { this.error = message(e); });
    const interval = setInterval(() => this.schedule(), this.config.syncMs);
    interval.unref?.();
    this.home.on("projects/created", () => this.schedule());
    this.home.on("projects/removed", () => this.schedule());
    return () => {
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      clearInterval(interval);
      subscription.unsubscribe();
      this.client.auth.stopAutoRefresh();
      offStorage(); offSettings();
      disableCloud();
    };
  }

  manifest(): HubManifest {
    const manifest = emptyHub();
    for (const r of this.cache.view()) {
      if (r.kind === "project") {
        if (r.value === null) manifest.removed.push({ id: r.key, at: 0 });
        else manifest.projects.push(r.value as unknown as HubProject);
      } else if (r.kind === "repo" && r.value) manifest.repos.push(r.value as unknown as HubManifest["repos"][number]);
    }
    return manifest;
  }
  private preferences(): UserSettingsFile {
    const value = this.cache.view().find(r => r.kind === "preference" && r.key === SETTINGS_KEY)?.value;
    const parsed = UserSettings.safeParse(value);
    return parsed.success ? parsed.data : { v: 1, sections: {} };
  }
  private observe(manifest: HubManifest): void {
    const pending = this.cache.data.outbox.length;
    const removed = new Set(manifest.removed.map(r => r.id));
    for (const p of manifest.projects) {
      if (removed.has(p.id)) continue;
      // updatedAt is a legacy transport stamp, not a local fact. Keep it stable when comparing.
      this.cache.observe("project", p.id, JSON.parse(JSON.stringify({ id: p.id, name: p.name, keyPrefix: p.keyPrefix, remote: p.remote, hint: p.hint, updatedAt: 0 })));
    }
    for (const r of manifest.repos) this.cache.observe("repo", r.remote, { remote: r.remote, name: r.name });
    for (const r of manifest.removed) this.cache.observe("project", r.id, null);
    if (this.cache.data.outbox.length !== pending) this.schedule();
  }
  status(): StorageStatus {
    return {
      state: this.active ? "syncing" : this.error ? "error" : this.cache.data.conflicts.length ? "diverged" : !this.user ? "unavailable" : this.cache.data.outbox.length ? "ahead" : this.cache.data.lastSyncAt ? "synced" : "local",
      location: this.user?.email ?? null, lastSyncAt: this.cache.data.lastSyncAt,
      detail: this.error ?? (!this.user ? "Sign in to synchronize your Hub." : undefined)
    };
  }
  info(): AccountInfo {
    return { user: this.user ? { id: this.user.id, email: this.user.email ?? "" } : null,
      hubId: this.cache.data.hubId, status: this.status(), pending: this.cache.data.outbox.length,
      offlineAccess: this.cache.data.offlineAccess && !!this.cache.data.userId,
      owner: this.cache.data.userId ? { email: this.cache.data.email } : null, switchingTo: this.switchingTo,
      terms: { current: TERMS_VERSION, accepted: this.termsAccepted() },
      conflicts: this.cache.data.conflicts.map(r => ({ id: recordKey(r), cloud: r.value, local: this.cache.view().find(v => recordKey(v) === recordKey(r))?.value })) };
  }
  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, 1000);
    this.timer.unref?.();
  }
  sync(): Promise<void> {
    if (this.active) return this.active;
    if (this.closed || this.signingOut || !this.user) return Promise.resolve();
    this.active = this.performSync().then(() => {
      // The catalog may name projects this machine has never had; bring them here.
      if (!this.closed) void this.ctx.storage.restoreMissing().catch(e => this.home.logger.warn(`restore: ${message(e)}`));
    }).catch(e => { this.error = message(e); }).finally(() => {
      this.active = null;
      if (!this.closed) { this.ctx.settings.refreshUserStore(); this.notify(); }
    });
    return this.active;
  }
  private async performSync(): Promise<void> {
    const userId = this.user!.id;
    if (this.cache.data.userId && this.cache.data.userId !== userId) throw new Error("Sign in with the account that owns this local Hub, or use a separate TOMRADE_USER_DATA directory.");
    await this.ctx.storage.writeHub();
    const { data: hubId, error } = await this.client.rpc("tomrade_ensure_hub");
    if (error) throw new Error(error.message);
    if (this.closed || this.user?.id !== userId) return;
    this.cache.bind(userId, z.uuid().parse(hubId));
    this.cache.data.offlineAccess = true;
    this.cache.data.email = this.user?.email ?? this.cache.data.email;
    this.cache.save();
    this.config.accounts?.claim({ id: userId, email: this.cache.data.email ?? "" });
    // Never over a newer version agreed on another computer. A failure here retries next time, without holding up sync.
    const agreed = this.cache.data.terms, recorded = this.user?.user_metadata?.terms_version;
    if (agreed && !(typeof recorded === "string" && recorded >= agreed)) {
      const { data, error: unrecorded } = await this.client.auth.updateUser({ data: termsRecord(agreed) });
      if (this.closed || this.user?.id !== userId) return;
      if (unrecorded) this.home.logger.warn(`terms: ${unrecorded.message}`);
      else this.user = data.user;
    }
    for (const op of [...this.cache.data.outbox]) {
      if (this.closed || this.user?.id !== userId) return;
      if (!this.cache.data.outbox.some(p => p.id === op.id)) continue;
      if (this.cache.data.conflicts.some(r => recordKey(r) === recordKey(op))) continue;
      const { data, error: failure } = await this.client.rpc("tomrade_mutate_hub", { p_hub: hubId, p_mutation: op });
      if (failure) throw new Error(failure.message);
      const result = Result.parse(data);
      if (result.ok || equal(op.value, result.record.value)) this.cache.accept(op, result.record);
      else this.cache.conflict(result.record);
    }
    // Explicit pagination: the API's row limit must not silently truncate a larger Hub.
    const rows: CloudRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error: failure } = await this.client.from("tomrade_hub_records")
        .select("kind,key,value,version").eq("hub_id", hubId).order("kind").order("key").range(offset, offset + 499);
      if (failure) throw new Error(failure.message);
      rows.push(...z.array(RecordSchema).parse(data));
      if (data.length < 500) break;
    }
    if (this.closed || this.user?.id !== userId) return;
    this.cache.ingest(rows);
    this.cache.data.lastSyncAt = Date.now(); this.cache.save(); this.error = null;
  }
  /**
   * A client that keeps no session. Until the user is known, nobody knows whose
   * local Hub the session belongs in, so this one's storage is not touched.
   */
  private scratch(): SupabaseClient {
    return createClient(this.origin, this.config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: this.fetch }
    });
  }
  /** Another account's session goes to that account's own local Hub; this one stays as it is. */
  private async handOff(user: User, session: Session): Promise<boolean> {
    const owner = this.cache.data.userId;
    const accounts = this.config.accounts;
    if (owner === user.id || (!owner && !accounts?.elsewhere(user.id))) return false;
    if (!accounts) throw this.refusal();
    this.switchingTo = user.email ?? "";
    this.notify();
    try {
      await accounts.open({ id: user.id, email: user.email ?? "" }, { key: this.sessionKey, value: JSON.stringify(session) });
    } catch (e) {
      this.switchingTo = null;
      this.notify();
      throw e;
    }
    return true;
  }
  private refusal(): Error {
    return new Error(`[other_account] This computer's projects belong to ${this.cache.data.email ?? "another account"}. Sign in with that account.`);
  }
  /** `agreed`: the person ticked the terms on the sign-in form; the account records it on the next sync. */
  async signIn(email: string, password: string, agreed = false): Promise<AccountInfo> {
    const { data, error } = await this.scratch().auth.signInWithPassword(credentials(email, password));
    if (error) throw failure(error);
    if (await this.handOff(data.user, data.session)) return this.info();
    const { error: adopted } = await this.client.auth.setSession(data.session);
    if (adopted) throw failure(adopted);
    this.user = data.user;
    if (agreed) this.agree();
    await this.sync(); this.notify();
    return this.info();
  }
  async signUp(email: string, password: string, lang?: string, agreed = false): Promise<{ confirmationRequired: boolean }> {
    const owned = !!this.cache.data.userId;
    // Refuse before the account exists, not after.
    if (owned && !this.config.accounts) throw this.refusal();
    const parsed = credentials(email, password, 8);
    if (!agreed) throw new Error("[terms_required] Agree to the Terms of Service and Privacy Policy to create an account.");
    const { data, error } = await (owned ? this.scratch() : this.client).auth.signUp({
      ...parsed, options: { emailRedirectTo: this.page("confirmed", lang), data: termsRecord(TERMS_VERSION) }
    });
    if (error) throw failure(error);
    if (!data.session) {
      // With confirmation on, Supabase answers a taken address with an identity-less user and sends nothing.
      if (data.user?.identities?.length === 0) throw new Error("[user_already_exists] An account with this email already exists.");
      return { confirmationRequired: true };
    }
    if (await this.handOff(data.session.user, data.session)) return { confirmationRequired: false };
    this.user = data.session.user;
    await this.sync();
    this.notify();
    return { confirmationRequired: false };
  }
  /** Agreed from the prompt an already signed-in account sees. Offline, it waits in the cache for the next sync. */
  async acceptTerms(): Promise<AccountInfo> {
    this.agree();
    await this.sync();
    this.notify();
    return this.info();
  }
  private agree(): void {
    this.cache.data.terms = TERMS_VERSION;
    this.cache.save();
  }
  /** The newer of what the account carries and what was agreed here; the dated versions sort as text. */
  private termsAccepted(): string | null {
    const recorded = this.user?.user_metadata?.terms_version;
    const versions = [typeof recorded === "string" ? recorded : null, this.cache.data.terms].filter((v): v is string => !!v).sort();
    return versions.at(-1) ?? null;
  }
  async resendConfirmation(email: string, lang?: string): Promise<void> {
    const { error } = await this.scratch().auth.resend({ type: "signup", email: address(email), options: { emailRedirectTo: this.page("confirmed", lang) } });
    if (error) throw failure(error);
  }
  /** The link opens a page on the site that sets the new password; the person then signs in here. */
  async resetPassword(email: string, lang?: string): Promise<void> {
    const { error } = await this.scratch().auth.resetPasswordForEmail(address(email), { redirectTo: this.page("reset", lang) });
    if (error) throw failure(error);
  }
  private page(name: "confirmed" | "reset", lang?: string): string {
    return new URL(`${lang === "zh" ? "/zh" : ""}/auth/${name}/`, this.config.site).href;
  }
  async signOut(): Promise<void> {
    // Complete any in-flight commit before ending the session; unsent edits stay in the durable outbox.
    this.signingOut = true;
    try {
      if (this.active) await this.active;
      // Revoking the refresh token is best effort: an unreachable server must not keep this device signed in.
      const { error } = await this.client.auth.signOut({ scope: "local" });
      if (error) await this.config.sessionStorage.removeItem(this.sessionKey);
      this.user = null;
      this.cache.data.offlineAccess = false;
      this.cache.save();
      this.notify();
    } finally { this.signingOut = false; }
  }
  private notify(): void {
    this.home.get("ipc")?.send("account.changed");
    this.home.get("ipc")?.send("hub.changed");
  }
}
