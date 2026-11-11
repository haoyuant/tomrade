import os from "node:os";
import type { Context } from "cordis";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { contract, errorMessage } from "@tomradex/contracts";
import { equal, type CloudCache, type DeviceRow } from "./cache.js";

/** What a machine says about itself to the account's other machines. No path, no credential. */
export interface DeviceFacts {
  platform: string;
  arch: string;
  version: string;
  git: boolean;
  /** The coding agents installed here; `ready` is false for one that still wants a sign-in or a model. */
  agents: { id: string; title: string; ready: boolean }[];
  /** Remotes of the repositories this machine has a checkout of. */
  repos: string[];
}

export interface DeviceView extends DeviceFacts {
  id: string;
  name: string;
  /** This very machine. */
  self: boolean;
  online: boolean;
  /** When it was last known to be here; for one that is online, now. */
  lastSeenAt: number;
}

export interface DevicesInfo {
  /**
   * `signed-out`: devices need an account. `pending`: this machine has not reached the account yet.
   * `removed`: it was removed from another machine, and stays out until someone signs in here again.
   */
  state: "signed-out" | "pending" | "ready" | "removed";
  devices: DeviceView[];
}

const Facts = z.object({
  platform: z.string().catch(""), arch: z.string().catch(""), version: z.string().catch(""), git: z.boolean().catch(false),
  agents: z.array(z.object({ id: z.string(), title: z.string(), ready: z.boolean() })).catch([]),
  repos: z.array(z.string()).catch([])
});
const Row = z.object({ device_id: z.string(), name: z.string(), facts: z.json(), last_seen_at: z.string(), updated_at: z.string() });
const Registered = z.object({ state: z.enum(["registered", "removed"]) });

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A remote on a server, with no password in it: what the database takes. A folder or a file URL stays here. */
const shareable = (remote: string): boolean =>
  remote.length <= 512 && !/\s/.test(remote) && !/^file:/i.test(remote) && !/:\/\/[^/@]*:[^/@]*@/.test(remote)
  && (/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/.+/i.test(remote) || /^([^@/:\\]+@)?[^/:\\]{2,}:[^/\\].*/.test(remote));

/** How long a git probe is believed. */
const GIT_MS = 600_000;
/** A machine that comes online stamps the account at most this often. */
const SEEN_MS = 600_000;

export interface DevicesHost {
  home: Context;
  client: SupabaseClient;
  cache: CloudCache;
  deviceId: string;
  appVersion: string;
  /** How long after its presence ends a machine still counts as online: a dropped connection usually comes back. */
  offlineAfterMs: number;
  /** The signed-in account, or null. */
  userId(): string | null;
  /** The list, or who is online, changed. */
  changed(): void;
  /** Ask for another pass soon. */
  schedule(): void;
}

/**
 * This machine among the account's machines: it registers what it can do when that changes, reads the
 * others, and keeps a presence so each can tell which are online without anyone writing to the database.
 */
export class Devices {
  private channel: RealtimeChannel | null = null;
  private channelUser: string | null = null;
  private present = new Set<string>();
  /** Machines seen leaving during this run: when, and until when they still count as online. */
  private left = new Map<string, { at: number; until: number }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private git: { at: number; ready: boolean } | null = null;
  private seenAt = 0;
  private warned: string | null = null;

  constructor(private readonly host: DevicesHost) {}

  /** What this machine can do right now. Sorted, so the same facts always read the same. */
  async facts(): Promise<DeviceFacts> {
    const { home } = this.host;
    const agents: DeviceFacts["agents"] = [];
    for (const engine of contract(home, "agent")?.codeEngines?.() ?? []) {
      if (!AGENT_ID.test(engine.id)) continue;
      const state = await engine.available().catch(() => null);
      // Not installed, or installed and broken: not something another machine could send work to.
      if (!state || (!state.ok && (!state.need || state.need === "install" || state.need === "repair"))) continue;
      const ready = state.ok && (!state.capabilities || state.capabilities.includes("code"));
      agents.push({ id: engine.id, title: engine.title.replace(/[/\\]/g, " ").slice(0, 80) || engine.id, ready });
    }
    if (!this.git || Date.now() - this.git.at > GIT_MS) {
      const status = await contract(home, "machineSetup")?.git().catch(() => null);
      this.git = { at: Date.now(), ready: status?.state === "ready" };
    }
    const repos = Object.entries(home.hub.catalog.repos()).filter(([remote, r]) => r.checkout && shareable(remote)).map(([remote]) => remote);
    return {
      platform: process.platform, arch: process.arch, version: /^[0-9A-Za-z.+-]{1,40}$/.test(this.host.appVersion) ? this.host.appVersion : "dev",
      git: this.git.ready, agents: agents.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 32), repos: repos.sort().slice(0, 500)
    };
  }

  /** The name a machine gives itself until the account renames it. */
  private hostname(): string {
    return os.hostname().replace(/\.(local|lan|home)$/i, "").trim().slice(0, 80) || "Computer";
  }

  /**
   * One pass, after the Hub's own: tell the account what changed here, read its machines, hold the presence.
   * `alive`: this pass is still for the account it began for.
   */
  async pass(alive: () => boolean): Promise<void> {
    const { cache } = this.host;
    const facts = await this.facts();
    const print = JSON.stringify(facts);
    if (!alive()) return;
    if (cache.data.device.rejoin || (!cache.data.device.removed && cache.data.device.acked !== print)) await this.register(facts, print);
    let rows = this.registered() ? await this.read() : null;
    if (rows && !rows.some((r) => r.device_id === this.host.deviceId)) {
      // Its row is gone though the account took it before: removed elsewhere, which registering again says.
      cache.data.device = { ...cache.data.device, acked: null };
      await this.register(facts, print);
      rows = this.registered() ? await this.read() : null;
    }
    if (!alive()) return;
    if (!rows) {
      if (!cache.data.device.removed) return;
      this.close();
      if (cache.data.devices.length) { cache.data.devices = []; cache.save(); this.host.changed(); }
      return;
    }
    if (!equal(rows, cache.data.devices)) { cache.data.devices = rows; cache.save(); this.host.changed(); }
    this.connect();
  }

  /** The account has this machine, as far as this machine knows. */
  private registered(): boolean {
    return !this.host.cache.data.device.removed && this.host.cache.data.device.acked !== null;
  }

  private async register(facts: DeviceFacts, print: string): Promise<void> {
    const { cache, client, deviceId } = this.host;
    const { data, error } = await client.rpc("tomrade_register_device", { p_device: deviceId, p_name: this.hostname(), p_facts: facts, p_rejoin: cache.data.device.rejoin });
    // Without a code the request never reached the database: it stays owed, and the next pass sends it.
    if (error && !error.code) throw new Error(error.message);
    if (error) {
      // Refused: an account server older than this build, say. Said once, not every half minute.
      if (this.warned !== error.message) this.host.home.logger.warn(`devices: this machine was not registered — ${error.message}`);
      this.warned = error.message;
      return;
    }
    this.warned = null;
    const removed = Registered.parse(data).state === "removed";
    const before = cache.data.device;
    cache.data.device = { acked: removed ? null : print, rejoin: false, removed };
    cache.save();
    if (!removed) this.seenAt = Date.now();
    if (before.removed !== removed || (before.acked === null) !== (cache.data.device.acked === null)) this.host.changed();
  }

  private async read(): Promise<DeviceRow[]> {
    const { data, error } = await this.host.client.from("tomrade_devices").select("device_id,name,facts,last_seen_at,updated_at").is("removed_at", null).order("device_id").limit(200);
    if (error) throw new Error(error.message);
    return z.array(Row).parse(data);
  }

  info(): DevicesInfo {
    const { cache, deviceId } = this.host;
    if (!this.host.userId()) return { state: "signed-out", devices: [] };
    if (cache.data.device.removed) return { state: "removed", devices: [] };
    const now = Date.now();
    const devices = cache.data.devices.map((row): DeviceView => {
      const self = row.device_id === deviceId;
      const gone = this.left.get(row.device_id);
      const online = self || this.present.has(row.device_id) || (!!gone && gone.until > now);
      return { ...Facts.parse(row.facts ?? {}), id: row.device_id, name: row.name, self, online, lastSeenAt: online ? now : Math.max(Date.parse(row.last_seen_at) || 0, gone?.at ?? 0) };
    });
    // This machine first, then the ones that are on, then by name.
    devices.sort((a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { state: cache.data.device.acked === null ? "pending" : "ready", devices };
  }

  async rename(id: string, name: string): Promise<void> {
    const { error } = await this.host.client.rpc("tomrade_rename_device", { p_device: id, p_name: name });
    if (error) throw this.failure(error);
    await this.refresh();
  }

  /** Out of the account's machines until someone signs in on it again. Removing this one takes it out at once. */
  async remove(id: string): Promise<void> {
    const { cache, client, deviceId } = this.host;
    const { error } = await client.rpc("tomrade_remove_device", { p_device: id });
    if (error) throw this.failure(error);
    if (id === deviceId) {
      cache.data.device = { acked: null, rejoin: false, removed: true };
      cache.data.devices = [];
      cache.save();
      this.close();
      this.host.changed();
      return;
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const rows = await this.read();
    if (equal(rows, this.host.cache.data.devices)) return;
    this.host.cache.data.devices = rows;
    this.host.cache.save();
    this.host.changed();
  }

  private failure(error: { message: string; code?: string }): Error {
    return new Error(error.code ? error.message : `[network] ${error.message}`);
  }

  /** Someone signed in here: a machine that was removed may register again. */
  signedIn(): void {
    this.host.cache.data.device = { ...this.host.cache.data.device, rejoin: true };
    this.host.cache.save();
  }

  private connect(): void {
    const userId = this.host.userId();
    if (!userId || (this.channel && this.channelUser === userId)) return;
    this.close();
    try {
      const channel = this.host.client.channel(`tomrade-devices:${userId}`, { config: { private: true, presence: { key: this.host.deviceId } } });
      channel.on("presence", { event: "sync" }, () => {
        if (this.channel === channel) this.seen(channel.presenceState<{ leaving?: boolean }>());
      });
      channel.subscribe((status) => {
        if (status !== "SUBSCRIBED" || this.channel !== channel) return;
        void Promise.resolve(channel.track({ at: Date.now() })).catch(() => undefined);
        if (Date.now() - this.seenAt > SEEN_MS) this.stamp();
      });
      this.channel = channel;
      this.channelUser = userId;
    } catch (e) {
      // No presence on this build: the list still reads, every other machine as last seen.
      this.host.home.logger.warn(`devices: presence is unavailable — ${errorMessage(e)}`);
    }
  }

  private stamp(): void {
    this.seenAt = Date.now();
    void Promise.resolve(this.host.client.rpc("tomrade_device_seen", { p_device: this.host.deviceId })).catch(() => undefined);
  }

  /** Who the channel says is here. One that left keeps counting as online for a while, unless it said it was leaving. */
  private seen(state: Record<string, { leaving?: boolean }[]>): void {
    const here = new Set(Object.entries(state).filter(([, metas]) => !metas.length || metas.some((m) => !m.leaving)).map(([id]) => id));
    const leaving = new Set(Object.keys(state).filter((id) => !here.has(id)));
    let changed = false;
    const now = Date.now();
    for (const id of this.present) {
      if (here.has(id)) continue;
      const until = leaving.has(id) ? now : now + this.host.offlineAfterMs;
      this.left.set(id, { at: now, until });
      changed = true;
      if (until > now) {
        const timer = setTimeout(() => { this.timers.delete(id); this.host.changed(); }, this.host.offlineAfterMs);
        timer.unref?.();
        this.timers.set(id, timer);
      }
    }
    for (const id of here) {
      if (this.present.has(id)) continue;
      changed = true;
      const timer = this.timers.get(id);
      if (timer) { clearTimeout(timer); this.timers.delete(id); }
      this.left.delete(id);
    }
    this.present = here;
    // A machine the list does not have yet: it registered since the last read.
    if ([...here].some((id) => !this.host.cache.data.devices.some((r) => r.device_id === id))) this.host.schedule();
    if (changed) this.host.changed();
  }

  private disconnect(): RealtimeChannel | null {
    const channel = this.channel;
    this.channel = null;
    this.channelUser = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.present = new Set();
    this.left.clear();
    return channel;
  }

  /**
   * This machine goes offline on purpose — sign-out, quit: the others hear it at once rather than after the
   * wait a dropped connection gets, and the account is told when it was last here.
   */
  async leave(): Promise<void> {
    const channel = this.disconnect();
    if (!channel) return;
    const quietly = (work: () => PromiseLike<unknown>) => Promise.resolve().then(work).catch(() => undefined);
    await quietly(() => channel.track({ leaving: true }));
    await quietly(() => this.host.client.rpc("tomrade_device_seen", { p_device: this.host.deviceId }));
    await quietly(() => channel.untrack());
    await quietly(() => this.host.client.removeChannel(channel));
  }

  /** Out of the channel without a word: the process is ending, or this machine is no longer one of the account's. */
  close(): void {
    const channel = this.disconnect();
    if (channel) void Promise.resolve().then(() => this.host.client.removeChannel(channel)).catch(() => undefined);
  }
}
