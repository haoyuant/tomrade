import os from "node:os";
import type { Context } from "cordis";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { contract, errorMessage } from "@tomradex/contracts";
import { equal, type CloudCache, type DevicePlan, type DeviceRow } from "./cache.js";
import { FREE_DEVICE_LIMIT, FREE_PLAN } from "./plans.js";

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
   * `over-limit`: the account's plan has no room for this machine. `devices` then lists the machines that
   * hold the places, so one can be removed; none of them reads as online, since this machine is not among them.
   */
  state: "signed-out" | "pending" | "ready" | "removed" | "over-limit";
  devices: DeviceView[];
  /**
   * How many machines the account may have (null: no limit) under which plan, and where to subscribe for
   * more. Until the account has answered, the free plan's.
   */
  plan: { id: string; limit: number | null; subscribeUrl: string };
}

const Facts = z.object({
  platform: z.string().catch(""), arch: z.string().catch(""), version: z.string().catch(""), git: z.boolean().catch(false),
  agents: z.array(z.object({ id: z.string(), title: z.string(), ready: z.boolean() })).catch([]),
  repos: z.array(z.string()).catch([])
});
const Row = z.object({ device_id: z.string(), name: z.string(), facts: z.json(), last_seen_at: z.string(), updated_at: z.string() });
const Registered = z.object({ state: z.enum(["registered", "removed", "over_limit"]), limit: z.number().int().nonnegative().optional(), plan: z.string().optional() });
const Plan = z.object({ plan: z.string(), limit: z.number().int().nonnegative().nullable() });

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A remote on a server, with no password in it: what the database takes. A folder or a file URL stays here. */
const shareable = (remote: string): boolean =>
  remote.length <= 512 && !/\s/.test(remote) && !/^file:/i.test(remote) && !/:\/\/[^/@]*:[^/@]*@/.test(remote)
  && (/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/.+/i.test(remote) || /^([^@/:\\]+@)?[^/:\\]{2,}:[^/\\].*/.test(remote));

/** How long a git probe is believed. */
const GIT_MS = 600_000;
/** A machine that comes online stamps the account at most this often. */
const SEEN_MS = 600_000;
/** How often the plan is asked for again, and how often a machine the account had no room for asks again. */
const PLAN_MS = 600_000;

export interface DevicesHost {
  home: Context;
  client: SupabaseClient;
  cache: CloudCache;
  deviceId: string;
  appVersion: string;
  /** How long after its presence ends a machine still counts as online: a dropped connection usually comes back. */
  offlineAfterMs: number;
  /** Where a person subscribes for more machines. */
  subscribeUrl: string;
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
  /** When the plan was last read, how many machines the account had then, and when this machine last asked for a place. */
  private planAt = 0;
  private planFor = -1;
  private askedAt = 0;

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
    const mark = cache.data.device;
    // A machine the account had no room for asks again now and then, not on every pass; sooner when a place opens.
    const waiting = !!mark.over && Date.now() - this.askedAt < PLAN_MS;
    if (!waiting && (mark.rejoin || (!mark.removed && mark.acked !== print))) await this.register(facts, print);
    if (cache.data.device.removed) {
      if (!alive()) return;
      this.close();
      if (cache.data.devices.length) { cache.data.devices = []; cache.save(); this.host.changed(); }
      return;
    }
    if (!this.registered() && !cache.data.device.over) return;
    let rows = await this.read();
    if (this.registered() && !rows.some((r) => r.device_id === this.host.deviceId)) {
      // Its row is gone though the account took it before: removed elsewhere, which registering again says.
      cache.data.device = { ...cache.data.device, acked: null };
      await this.register(facts, print);
      if (cache.data.device.removed) return this.pass(alive);
      rows = await this.read();
    }
    const over = cache.data.device.over;
    if (over && rows.length < over.limit) {
      // A place opened: one of the others was removed.
      await this.register(facts, print);
      rows = await this.read();
    }
    await this.readPlan(rows.length);
    if (!alive()) return;
    if (!equal(rows, cache.data.devices)) { cache.data.devices = rows; cache.save(); this.host.changed(); }
    if (this.registered()) this.connect();
    else this.close();
  }

  /** The account's plan, read when the run begins, when the number of machines changes, and now and then. */
  private async readPlan(machines: number): Promise<void> {
    const { cache } = this.host;
    if (cache.data.plan && this.planFor === machines && Date.now() - this.planAt < PLAN_MS) return;
    const { data, error } = await this.host.client.rpc("tomrade_device_plan");
    if (error && !error.code) throw new Error(error.message);
    this.planAt = Date.now();
    this.planFor = machines;
    // An account server without plans: nothing to show beyond the free plan's numbers.
    const parsed = error ? null : Plan.safeParse(data);
    if (!parsed?.success) return;
    const plan: DevicePlan = { id: parsed.data.plan, limit: parsed.data.limit };
    if (equal(plan, cache.data.plan)) return;
    cache.data.plan = plan;
    cache.save();
    this.host.changed();
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
    this.askedAt = Date.now();
    const result = Registered.parse(data);
    const before = cache.data.device;
    if (result.state === "over_limit") {
      // Still owed, and still allowed back if it was removed: a place may open.
      cache.data.device = { ...before, acked: null, removed: false, over: { limit: result.limit ?? FREE_DEVICE_LIMIT } };
      if (result.plan) cache.data.plan = { id: result.plan, limit: result.limit ?? FREE_DEVICE_LIMIT };
    } else {
      const removed = result.state === "removed";
      cache.data.device = { acked: removed ? null : print, rejoin: false, removed, over: null };
      if (!removed) this.seenAt = Date.now();
    }
    cache.save();
    if (!equal(before, cache.data.device) && !(before.acked !== null && cache.data.device.acked !== null)) this.host.changed();
  }

  private async read(): Promise<DeviceRow[]> {
    const { data, error } = await this.host.client.from("tomrade_devices").select("device_id,name,facts,last_seen_at,updated_at").is("removed_at", null).order("device_id").limit(200);
    if (error) throw new Error(error.message);
    return z.array(Row).parse(data);
  }

  info(): DevicesInfo {
    const { cache, deviceId } = this.host;
    const held = cache.data.plan ?? { id: FREE_PLAN, limit: FREE_DEVICE_LIMIT };
    const plan = { ...held, subscribeUrl: this.host.subscribeUrl };
    if (!this.host.userId()) return { state: "signed-out", devices: [], plan };
    if (cache.data.device.removed) return { state: "removed", devices: [], plan };
    const out = !!cache.data.device.over;
    const now = Date.now();
    const devices = cache.data.devices.map((row): DeviceView => {
      const self = row.device_id === deviceId;
      const gone = this.left.get(row.device_id);
      const online = !out && (self || this.present.has(row.device_id) || (!!gone && gone.until > now));
      return { ...Facts.parse(row.facts ?? {}), id: row.device_id, name: row.name, self, online, lastSeenAt: online ? now : Math.max(Date.parse(row.last_seen_at) || 0, gone?.at ?? 0) };
    });
    // This machine first, then the ones that are on, then by name.
    devices.sort((a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { state: out ? "over-limit" : cache.data.device.acked === null ? "pending" : "ready", devices, plan };
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
      cache.data.device = { acked: null, rejoin: false, removed: true, over: null };
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
    // A place may have opened for this machine, or the plan may read differently now.
    if (this.host.cache.data.device.over) { this.askedAt = 0; this.host.schedule(); }
    if (equal(rows, this.host.cache.data.devices)) return;
    this.host.cache.data.devices = rows;
    this.host.cache.save();
    this.host.changed();
  }

  private failure(error: { message: string; code?: string }): Error {
    return new Error(error.code ? error.message : `[network] ${error.message}`);
  }

  /** The person asks again, having subscribed or removed a machine elsewhere: the next pass asks for a place and the plan at once. */
  recheck(): void {
    this.askedAt = 0;
    this.planAt = 0;
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
