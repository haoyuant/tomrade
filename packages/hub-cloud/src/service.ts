import { Context, Service } from "cordis";
import { createClient, type SupabaseClient, type SupportedStorage, type User } from "@supabase/supabase-js";
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
}
declare module "cordis" { interface Context { cloudHub: CloudHub } }
declare module "@tomradex/ipc" {
  interface Channels {
    "account.info": () => AccountInfo;
    "account.signIn": (email: string, password: string) => AccountInfo;
    "account.signUp": (email: string, password: string) => { confirmationRequired: boolean };
    "account.signOut": () => void;
    "account.sync": () => AccountInfo;
    "account.resolve": (id: string, choice: "local" | "cloud") => AccountInfo;
  }
  interface Broadcasts { "account.changed": () => void }
}

export const CloudConfig = z.object({
  url: z.url(), publishableKey: z.string().min(1), cacheFile: z.string().min(1),
  sessionStorage: z.custom<SupportedStorage>(v => !!v && typeof (v as SupportedStorage).getItem === "function"),
  syncMs: z.number().int().min(1000).default(30_000)
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
  private readonly sessionKey: string;

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
    this.cache = new CloudCache(config.cacheFile, endpoint.origin);
    // supabase-js's own default, named so sign-out can forget the session without the server.
    this.sessionKey = `sb-${endpoint.hostname.split(".")[0]}-auth-token`;
    this.client = createClient(endpoint.origin, config.publishableKey, {
      auth: { storage: config.sessionStorage, storageKey: this.sessionKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) }
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
    this.home.inject(["ipc"], ctx => {
      // Account status is a local read. Session renewal must not hold an offline
      // user's project UI behind a network timeout.
      ctx.ipc.handle("account.info", () => this.info());
      ctx.ipc.handle("account.signIn", (email, password) => this.signIn(email, password));
      ctx.ipc.handle("account.signUp", (email, password) => this.signUp(email, password));
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
    this.ready = this.client.auth.getSession().then(async ({ data, error }) => {
      if (error) this.error = error.message;
      this.user = data.session?.user ?? null;
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
    this.cache.save();
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
  async signIn(email: string, password: string): Promise<AccountInfo> {
    const credentials = Credentials.parse({ email, password });
    const { data, error } = await this.client.auth.signInWithPassword(credentials);
    if (error) throw new Error(error.message);
    if (this.cache.data.userId && data.user.id !== this.cache.data.userId) {
      await this.client.auth.signOut({ scope: "local" });
      this.user = null;
      throw new Error("This local Hub belongs to another account. Use a separate TOMRADE_USER_DATA directory.");
    }
    this.user = data.user;
    await this.sync(); this.notify();
    return this.info();
  }
  async signUp(email: string, password: string): Promise<{ confirmationRequired: boolean }> {
    const credentials = Credentials.extend({ password: z.string().min(8).max(1024) }).parse({ email, password });
    if (this.cache.data.userId) throw new Error("This local Hub already belongs to an account. Sign in to that account.");
    const { data, error } = await this.client.auth.signUp(credentials);
    if (error) throw new Error(error.message);
    this.user = data.session?.user ?? null;
    if (this.user) await this.sync();
    this.notify();
    return { confirmationRequired: !data.session };
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
