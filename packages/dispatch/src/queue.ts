import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/code-link";
import { errorMessage } from "@tomradex/contracts";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/hub-cloud";
import { CEILINGS, rankOf, type Ceiling, type Role } from "@tomradex/roles";
import type { Admission, DispatchRequest, Refusal } from "./policy.js";

/** How a request stands. `done`: the session it started is over, however it went; `reason` says when it went badly. */
export type DispatchState = "queued" | "accepted" | "running" | "done" | "refused" | "cancelled";

/** A ticket one of the account's machines asked another to work on. */
export interface DispatchView {
  id: string;
  fromDevice: string;
  /** The machine it is for; null when any machine of `toPlatform` may take it. */
  toDevice: string | null;
  toPlatform: string | null;
  projectId: string;
  key: string;
  title: string;
  /** What the asking machine would like; the taking machine decides. `role`: the project's role to work the ticket as, by its id. */
  wish: { engine?: string; permissionMode?: string; role?: string };
  state: DispatchState;
  /** Refused: a reason code, then what more there is to say (`permission: …`). Done: why it stopped, when it did not finish. */
  reason: string | null;
  /** The machine that took it. */
  claimedBy: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** From another account, to a machine its owner shared with that person: their address. Null between an account's own machines. */
  fromEmail: string | null;
  /** It was made to wait for the owner's yes on the machine it is for. */
  needsYes: boolean;
  /** The owner has said yes, or none was needed. */
  approved: boolean;
  /** The most the owner lets that person's tickets do there; null between an account's own machines. */
  ceiling: Ceiling | null;
}

/** A machine another person shares with this account, as much as choosing one reads of it. */
export interface SharedDevice {
  /** What a ticket is sent to. */
  share: string;
  /** Its owner, by the address of their account. */
  owner: string;
  deviceId: string;
  name: string;
  platform: string;
  agents: { id: string; title: string; ready: boolean }[];
  /** Whether it takes work sent to it unasked, and for which projects; null on a machine that does not say. */
  accept: { on: boolean; projects: "all" | string[]; ceiling: Ceiling } | null;
  /** The most a ticket of this account's may do there. */
  ceiling: Ceiling;
  /** False: each ticket waits for the owner's yes on that machine. */
  auto: boolean;
  lastSeenAt: number;
}

/** A person this machine is shared with. */
export interface DeviceShare {
  email: string;
  ceiling: Ceiling;
  auto: boolean;
}

/** What a machine sends: a ticket, and where it should run. */
export interface DispatchInput {
  projectId: string;
  itemId: string;
  /** One machine, by its id; or any machine of a platform (`win32`, `darwin`, `linux`); or a machine another person shares, by its share. */
  to?: string;
  platform?: string;
  share?: string;
  engine?: string;
  permissionMode?: string;
  /** The project's role to work the ticket as (a role's id). With no machine or platform named, the role's own requirement names one. */
  role?: string;
}

const Row = z.object({
  id: z.string(), from_device: z.string(), to_device: z.string().nullable(), to_platform: z.string().nullable(),
  project_id: z.string(), item_key: z.string(), title: z.string(),
  wish: z.object({ engine: z.string().optional(), permissionMode: z.string().optional(), role: z.string().optional() }).catch({}),
  state: z.enum(["queued", "accepted", "running", "done", "refused", "cancelled"]), reason: z.string().nullable(),
  claimed_by: z.string().nullable(), created_at: z.string(), updated_at: z.string(), expires_at: z.string(),
  // Absent on an account server from before machines could be shared.
  from_email: z.string().nullable().optional(), needs_yes: z.boolean().optional(), approved: z.boolean().optional(), ceiling: z.enum(CEILINGS).nullable().optional()
});
const view = (r: z.infer<typeof Row>): DispatchView => ({
  id: r.id, fromDevice: r.from_device, toDevice: r.to_device, toPlatform: r.to_platform, projectId: r.project_id, key: r.item_key, title: r.title,
  wish: r.wish, state: r.state, reason: r.reason, claimedBy: r.claimed_by,
  createdAt: Date.parse(r.created_at) || 0, updatedAt: Date.parse(r.updated_at) || 0, expiresAt: Date.parse(r.expires_at) || 0,
  fromEmail: r.from_email ?? null, needsYes: r.needs_yes ?? false, approved: r.approved ?? true, ceiling: r.ceiling ?? null
});
const Shared = z.object({
  share: z.string(), owner: z.string().nullable().transform((owner) => owner ?? ""), device_id: z.string(), name: z.string(), platform: z.string().nullable().transform((p) => p ?? ""),
  agents: z.array(z.object({ id: z.string(), title: z.string(), ready: z.boolean() })).catch([]),
  accept: z.object({ on: z.boolean(), projects: z.union([z.literal("all"), z.array(z.string())]), ceiling: z.enum(CEILINGS) }).nullable().catch(null),
  ceiling: z.enum(CEILINGS), auto: z.boolean(), last_seen_at: z.string()
});
const Share = z.object({ email: z.string(), ceiling: z.enum(CEILINGS), auto: z.boolean() });
const lower = (a: Ceiling | null | undefined, b: Ceiling | null | undefined): Ceiling | null => (a && b ? (rankOf(a) <= rankOf(b) ? a : b) : (a ?? b ?? null));

/** The slices of other services a dispatch runs through; each is read when needed, and none is imported. */
interface Cloud {
  client: { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>; from(table: string): any };
  info(): { user: { id: string } | null };
  devicesInfo?(): { state: string; devices?: { id: string; name: string; self: boolean }[] };
  signal?(name: string): void;
}
type Started =
  | { ok: true; sessionId: string }
  | { ok: false; gate: string; message: string; remote?: string; repo?: { id: string; name: string }; placed?: unknown };
interface CodeHost {
  start(projectId: string, itemId: string, opts: { mode: "run"; engine?: string; permissionMode?: string; role?: string; source?: Record<string, string> }): Promise<Started>;
  stopSession(projectId: string, sessionId: string): Promise<boolean>;
  sessionsOf(projectId: string, itemId?: string, filter?: { ids?: string[]; live?: boolean }): { id: string; state: string; summary: string | null }[];
}
interface ItemsHost { get(projectId: string, id: string): { id: string; key: string; title: string } | null; getByKey(projectId: string, key: string): { id: string; key: string; title: string } | null }
interface AgentHost {
  codeEngines(): { id: string; title: string; permissionModes?: { choices: { value: string }[] }; available(): Promise<{ ok: boolean; capabilities?: readonly string[] }> }[];
}
interface ReposHost { get(projectId: string, id: string): { defaultBranch: string } | null; cloneInto(remote: string, branch: string, parent: string): Promise<unknown> }

/** What the queue asks of the service that owns this machine's limits. */
export interface Gate {
  peek(request: DispatchRequest, modes?: readonly string[] | null): Admission;
  admit(request: DispatchRequest, modes?: readonly string[] | null): Admission;
  /** Turned away for a reason beyond the settings: no agent, a Start that would not go. */
  refuse(request: DispatchRequest, reason: Refusal, detail?: string): void;
  began(id: string): void;
  ended(id: string): void;
  changed(): void;
}

interface RolesHost { get(projectId: string, id: string): Role | null }

/** How long a request stays on offer when the asking machine says nothing else. */
const TTL_SECONDS = 24 * 3600;
/** How often a machine getting a taken request going says it is still at it; the account lets a claim lapse after five minutes of silence. */
const KEEP_MS = 60_000;
/** A claim this old with no word from its machine is taken to have lapsed. A little past the account's own five minutes: the clocks need not agree. */
const LAPSED_MS = 5.5 * 60_000;
/** The signal's name: the account's machines read the queue again when they hear it. */
const SIGNAL = "dispatches";
/** How long a request this machine stepped aside from waits before this machine looks at it again. */
const AGAIN_MS = 60_000;

/**
 * The account's queue of tickets sent between its machines, as this machine takes part in it: it sends and
 * cancels its own, and takes the ones meant for it — by its own limits, starting them as its own Start does.
 */
export class Queue {
  private rows: DispatchView[] = [];
  /** The requests this machine runs now, each with the session it started. */
  private readonly live = new Map<string, { projectId: string; sessionId: string }>();
  /**
   * Requests for any machine of this platform that this one could not take, each with when it last looked: left for
   * another, and looked at again after a while — or at once when this machine's settings change or a ticket it ran is over.
   */
  private readonly passed = new Map<string, number>();
  private working: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly home: Context, private readonly gate: Gate, private readonly tickMs: number) {}

  start(): void {
    this.interval = setInterval(() => void this.tick(), this.tickMs);
    this.interval.unref?.();
    this.home.on("cloudHub/signal", (name) => { if (name === SIGNAL) this.soon(); });
    // A session this machine runs for another ended, or accepting was turned off with requests waiting.
    this.home.on("codeLink/changed", () => { if (this.live.size) this.soon(); });
    this.home.on("settings/changed", () => { this.passed.clear(); this.soon(); });
    this.home.inject(["cloudHub"], () => this.soon());
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
  }

  private get me(): string { return this.home.hub.deviceId; }
  private cloud(): Cloud | null {
    const cloud = this.home.get("cloudHub") as Cloud | undefined;
    return cloud?.info().user ? cloud : null;
  }
  private code() { return this.home.get("codeLink") as CodeHost | undefined; }
  private items() { return this.home.get("items") as ItemsHost | undefined; }

  /** The account's recent requests, newest first. */
  list(): DispatchView[] {
    return [...this.rows].sort((a, b) => b.createdAt - a.createdAt);
  }

  private soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, 200);
    this.timer.unref?.();
  }

  /** One look at the queue; a look asked for while one runs follows it. */
  tick(): Promise<void> {
    if (this.working) { this.again = true; return this.working; }
    this.working = this.look().catch((e) => this.home.logger.warn(`dispatch: ${errorMessage(e)}`)).finally(() => {
      this.working = null;
      if (this.again) { this.again = false; this.soon(); }
    });
    return this.working;
  }

  private async call(cloud: Cloud, name: string, args: Record<string, unknown>): Promise<DispatchView | null> {
    const { data, error } = await cloud.client.rpc(name, args);
    if (error) throw new Error(error.code ? error.message : `[network] ${error.message}`);
    return data ? view(Row.parse(data)) : null;
  }

  private async read(cloud: Cloud): Promise<DispatchView[]> {
    const { data, error } = await cloud.client.from("tomrade_dispatches").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return z.array(Row).parse(data).map(view);
  }

  private take(rows: DispatchView[]): void {
    if (JSON.stringify(rows) === JSON.stringify(this.rows)) return;
    this.rows = rows;
    this.gate.changed();
  }

  private async look(): Promise<void> {
    const cloud = this.cloud();
    if (!cloud) return;
    let rows: DispatchView[];
    try { rows = await this.read(cloud); } catch (e) {
      // An account server without the queue, or no connection: nothing to do until there is one.
      this.home.logger.debug(`dispatch: the queue could not be read — ${errorMessage(e)}`);
      return;
    }
    let acted = false;
    const now = Date.now();
    for (const id of this.passed.keys()) if (!rows.some((row) => row.id === id && (row.state === "queued" || row.state === "accepted"))) this.passed.delete(id);
    for (const row of rows) {
      // False: looked and left as it was, so the other machines have nothing new to read.
      const act = async (work: () => Promise<unknown>) => { await work().then((did) => { if (did !== false) acted = true; }, (e) => this.home.logger.warn(`dispatch ${row.key}: ${errorMessage(e)}`)); };
      // Asked from here and never taken: no longer on offer.
      if (row.fromDevice === this.me && row.state === "queued" && row.expiresAt <= now) await act(() => this.call(cloud, "tomrade_cancel_dispatch", { p_id: row.id, p_reason: "expired" }));
      // Taken here.
      else if (row.claimedBy === this.me && (row.state === "running" || row.state === "accepted")) await act(() => this.follow(cloud, row));
      else if (row.claimedBy === this.me && row.state === "cancelled" && this.live.has(row.id)) await act(() => this.halt(row));
      // On offer to this machine: waiting with the owner's yes where it needs one, or taken by a machine that went quiet before the work started.
      else if (row.approved && (row.state === "queued" || (row.state === "accepted" && row.claimedBy !== this.me && row.updatedAt < now - LAPSED_MS)) && row.fromDevice !== this.me && row.expiresAt > now && (row.toDevice === this.me || (!row.toDevice && row.toPlatform === process.platform && (this.passed.get(row.id) ?? 0) <= now - AGAIN_MS))) await act(() => this.consider(cloud, row));
    }
    if (acted) {
      cloud.signal?.(SIGNAL);
      rows = await this.read(cloud).catch(() => rows);
    }
    this.take(rows);
  }

  /** A request on offer: taken if this machine's limits allow it and it has what the work needs; otherwise told why, or left for another. */
  private async consider(cloud: Cloud, row: DispatchView): Promise<false | void> {
    const addressed = row.toDevice === this.me;
    // The role as this machine's own copy of the project has it. One that has not arrived with the project yet is
    // waited for like the ticket itself, until the request runs out; one that works no ticket is none.
    const roles = this.home.get("roles") as RolesHost | undefined;
    const role = row.wish.role ? (roles?.get(row.projectId, row.wish.role) ?? null) : null;
    // From another account: the lower of what the role allows and what the owner lets that person's tickets do; and a
    // request the owner said yes to by hand is let in whatever the switch for the account's own machines says.
    const request: DispatchRequest = { from: row.fromEmail ?? row.fromDevice, projectId: row.projectId, key: row.key, permissionMode: row.wish.permissionMode ?? null, limit: lower(role?.permission, row.ceiling), ...(row.needsYes && row.approved ? { byHand: true } : {}) };
    const refuse = async (reason: Refusal, detail?: string) => {
      // One meant for any machine of this platform is another's to take: this one only steps aside.
      if (!addressed) { this.passed.set(row.id, Date.now()); return false; }
      this.gate.refuse(request, reason, detail);
      await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "refused", p_reason: detail ? `${reason}: ${detail}` : reason });
    };
    const first = this.gate.peek(request);
    if (!first.ok) return refuse(first.reason, first.detail);
    const code = this.code(), items = this.items(), agent = this.home.get("agent") as AgentHost | undefined;
    if (!code || !items || !agent) return refuse("start", "this build cannot start tickets");
    // The ticket travels with its project: one that has not arrived yet is waited for, until the request runs out.
    const item = items.getByKey(row.projectId, row.key);
    if (!item) return false;
    if (row.wish.role && !roles) return refuse("start", "this build knows no roles");
    if (row.wish.role && !role) return false;
    if (role && role.stage !== "implement") return refuse("start", `the role ${role.title} reviews changes, it works no ticket`);
    const engine = await this.engine(agent, row.wish.engine, role?.engines);
    if (!engine) return refuse("no-agent", role?.engines.length ? `none of the agents of the role ${role.title} is ready here (${role.engines.join(", ")})` : row.wish.engine ? `${row.wish.engine} is not ready here, and no other coding agent is` : "no coding agent is installed and signed in here");
    const modes = engine.permissionModes?.choices.map((c) => c.value) ?? null;
    const second = this.gate.peek(request, modes);
    if (!second.ok) return refuse(second.reason, second.detail);
    // From here it is this machine's: only one machine's claim lands.
    const claimed = await this.call(cloud, "tomrade_claim_dispatch", { p_id: row.id, p_device: this.me });
    if (!claimed) return;
    const failed = async (reason: Refusal, detail: string) => {
      this.gate.refuse(request, reason, detail);
      await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "refused", p_reason: `${reason}: ${detail}` });
    };
    // Decided again now that it is taken, and kept: the limits may have changed while it waited.
    const admission = this.gate.admit(request, modes);
    if (!admission.ok) {
      await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "refused", p_reason: admission.detail ? `${admission.reason}: ${admission.detail}` : admission.reason });
      return;
    }
    const opts = { mode: "run" as const, engine: engine.id, ...(admission.permissionMode ? { permissionMode: admission.permissionMode } : {}), ...(role ? { role: role.id } : {}), source: { dispatch: row.id, device: row.fromDevice, ...(row.fromEmail ? { from: row.fromEmail } : {}) } };
    let started: Started;
    // Getting the work going can take a while (a repository to clone): the claim is kept alive meanwhile.
    const keep = setInterval(() => void this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "accepted" }).catch(() => {}), KEEP_MS);
    keep.unref?.();
    try {
      started = await code.start(row.projectId, item.id, opts);
      if (!started.ok && started.gate === "checkout" && started.remote && started.repo && !started.placed) {
        await this.clone(row.projectId, started.repo.id, started.remote);
        started = await code.start(row.projectId, item.id, opts);
      }
    } catch (e) {
      return failed("start", errorMessage(e));
    } finally {
      clearInterval(keep);
    }
    if (!started.ok) return failed("start", `${started.gate} — ${started.message}`);
    this.live.set(row.id, { projectId: row.projectId, sessionId: started.sessionId });
    this.gate.began(row.id);
    await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "running" });
  }

  /**
   * The agent the asking machine named when it is ready here; otherwise the first of the role's agents that is, in the
   * role's order and no other; with no role naming any, the first that is ready.
   */
  private async engine(agent: AgentHost, wanted?: string, ofRole: readonly string[] = []) {
    const engines = agent.codeEngines();
    const ready = async (engine: (typeof engines)[number]) => {
      const state = await engine.available().catch(() => null);
      return !!state?.ok && (!state.capabilities || state.capabilities.includes("code"));
    };
    const named = wanted ? engines.find((e) => e.id === wanted) : undefined;
    if (named && (await ready(named))) return named;
    const order = ofRole.length ? ofRole.flatMap((id) => engines.find((e) => e.id === id) ?? []) : engines;
    for (const engine of order) if (engine !== named && (await ready(engine))) return engine;
    return null;
  }

  /** The repository has no checkout here: one is cloned into the Hub's own folder for cloned code. */
  private async clone(projectId: string, repoId: string, remote: string): Promise<void> {
    const repos = this.home.get("repos") as ReposHost | undefined;
    const dir = this.home.hub.dir;
    if (!repos || !dir) throw new Error("this machine has nowhere to clone the repository");
    const parent = path.join(dir, "repos");
    fs.mkdirSync(parent, { recursive: true });
    await repos.cloneInto(remote, repos.get(projectId, repoId)?.defaultBranch ?? "main", parent);
  }

  /** A request this machine took: done once its session is over, and found again after a restart. */
  private async follow(cloud: Cloud, row: DispatchView): Promise<false | void> {
    const code = this.code();
    if (!code) return false;
    let running = this.live.get(row.id);
    if (!running) {
      // Taken before a restart: the session it started is the ticket's live one, if it still goes.
      const item = this.items()?.getByKey(row.projectId, row.key);
      // The project is not open here yet: nothing can be said of its sessions.
      if (!item) return false;
      const session = code.sessionsOf(row.projectId, item.id, { live: true })[0];
      // Tomrade stopped before the ticket was started: the request goes back on offer, to this machine or the next it is for.
      if (row.state === "accepted") {
        try {
          await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "queued" });
        } catch {
          // An account server from before a request could be put back: it is given back the way it then was, so it does not hang.
          await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "refused", p_reason: "start: Tomrade stopped before the ticket was started" });
        }
        return;
      }
      if (!session) {
        await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "done", p_reason: "the session is no longer there" });
        return;
      }
      running = { projectId: row.projectId, sessionId: session.id };
      this.live.set(row.id, running);
      this.gate.began(row.id);
    }
    const session = code.sessionsOf(running.projectId, undefined, { ids: [running.sessionId] })[0];
    // Working, or waiting on the person: still going.
    if (session && (session.state === "running" || session.state === "waiting")) return false;
    this.free(row.id);
    await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "done", p_reason: session?.state === "error" ? (session.summary ?? "the agent stopped") : null });
  }

  /** Taken back by the machine that asked: the session it started here is stopped. */
  private async halt(row: DispatchView): Promise<void> {
    const running = this.live.get(row.id);
    if (!running) return;
    this.free(row.id);
    await this.code()?.stopSession(running.projectId, running.sessionId);
  }

  /** A ticket this machine ran is over: there is room for one it stepped aside from while it was busy. */
  private free(id: string): void {
    this.live.delete(id);
    this.gate.ended(id);
    if (this.passed.size) { this.passed.clear(); this.soon(); }
  }

  /** Asks another machine — one by its id, or any of a platform — to work a ticket. */
  async send(input: DispatchInput): Promise<DispatchView> {
    const cloud = this.cloud();
    if (!cloud) throw new Error("[not_signed_in] Sign in to send a ticket to another device.");
    const item = this.items()?.get(input.projectId, input.itemId);
    if (!item) throw new Error(`unknown item ${input.itemId}`);
    const wish = (role: Role | null) => ({ ...(input.engine ? { engine: input.engine } : {}), ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}), ...(role ? { role: role.id } : {}) });
    const role = input.role ? ((this.home.get("roles") as RolesHost | undefined)?.get(input.projectId, input.role) ?? null) : null;
    if (input.role && role?.stage !== "implement") throw new Error(`This project has no role ${input.role} that works tickets.`);
    // To a machine another person shares: it joins that person's queue, and waits for their yes unless they said it need not.
    if (input.share) {
      const sent = await this.call(cloud, "tomrade_create_shared_dispatch", { p_share: input.share, p_from: this.me, p_project: input.projectId, p_key: item.key, p_title: item.title, p_wish: wish(role), p_ttl_seconds: TTL_SECONDS });
      this.take([sent!, ...this.rows.filter((r) => r.id !== sent!.id)]);
      return sent!;
    }
    // Where the caller names nothing, the role's own requirement does: one machine by its name, or any of a platform.
    let to = input.to, platform = input.platform;
    if (!to && !platform && role?.needs.device) {
      const wanted = role.needs.device.trim().toLowerCase();
      to = cloud.devicesInfo?.().devices?.find((device) => !device.self && device.name.trim().toLowerCase() === wanted)?.id;
      if (!to) throw new Error(`The role ${role.title} asks for the device ${role.needs.device}, and the account has no other device of that name.`);
    }
    if (!to && !platform && role?.needs.platform) platform = role.needs.platform;
    if (!to && !platform) throw new Error("Name the device, or the platform, to send the ticket to.");
    const sent = await this.call(cloud, "tomrade_create_dispatch", {
      p_from: this.me, p_to: to ?? null, p_platform: to ? null : platform ?? null, p_project: input.projectId, p_key: item.key, p_title: item.title,
      p_wish: wish(role), p_ttl_seconds: TTL_SECONDS
    });
    cloud.signal?.(SIGNAL);
    this.take([sent!, ...this.rows.filter((r) => r.id !== sent!.id)]);
    return sent!;
  }

  /** Takes a request back; the machine that runs it stops its session when it hears. */
  async cancel(id: string): Promise<DispatchView[]> {
    const cloud = this.cloud();
    if (!cloud) throw new Error("[not_signed_in] Sign in to cancel a ticket sent to another device.");
    const cancelled = await this.call(cloud, "tomrade_cancel_dispatch", { p_id: id, p_reason: null });
    cloud.signal?.(SIGNAL);
    if (cancelled) this.take(this.rows.map((r) => (r.id === id ? cancelled : r)));
    return this.list();
  }

  /** Requests from other people for this machine that wait on its owner's yes, oldest first. */
  asks(): DispatchView[] {
    const now = Date.now();
    return this.rows.filter((row) => row.toDevice === this.me && row.state === "queued" && row.needsYes && !row.approved && row.expiresAt > now).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The owner says yes here: the request is then taken like any other, at once. */
  async approve(id: string): Promise<void> {
    const cloud = this.cloud();
    if (!cloud) throw new Error("[not_signed_in] Sign in to answer a request for this device.");
    const approved = await this.call(cloud, "tomrade_approve_dispatch", { p_id: id, p_device: this.me });
    if (approved) this.take(this.rows.map((r) => (r.id === id ? approved : r)));
    await this.tick();
  }

  /** The owner says no: the person who asked reads that it was turned away. */
  async decline(id: string): Promise<void> {
    const cloud = this.cloud();
    if (!cloud) throw new Error("[not_signed_in] Sign in to answer a request for this device.");
    const refused = await this.call(cloud, "tomrade_update_dispatch", { p_id: id, p_device: this.me, p_state: "refused", p_reason: "declined" });
    if (refused) this.take(this.rows.map((r) => (r.id === id ? refused : r)));
  }

  private async ask<T>(name: string, args: Record<string, unknown>, shape: z.ZodType<T>): Promise<T> {
    const cloud = this.cloud();
    if (!cloud) throw new Error("[not_signed_in] Sign in to share a device.");
    const { data, error } = await cloud.client.rpc(name, args);
    if (error) throw new Error(error.code ? error.message : `[network] ${error.message}`);
    return shape.parse(data);
  }

  /** The people this machine is shared with. Empty where nobody is signed in. */
  async shares(): Promise<DeviceShare[]> {
    if (!this.cloud()) return [];
    return this.ask("tomrade_device_shares", { p_device: this.me }, z.array(Share));
  }

  /** Lets one person send tickets to this machine, or changes how far theirs may go and whether each needs a yes. */
  async share(input: DeviceShare): Promise<DeviceShare[]> {
    await this.ask("tomrade_share_device", { p_device: this.me, p_email: input.email, p_ceiling: input.ceiling, p_auto: input.auto }, Share);
    return this.shares();
  }

  /** Takes a share back. What that person still has going here is cancelled, and the session it runs is stopped. */
  async unshare(email: string): Promise<DeviceShare[]> {
    await this.ask("tomrade_unshare_device", { p_device: this.me, p_email: email }, z.number());
    await this.tick();
    return this.shares();
  }

  /** The machines other people share with this account. Asked for when someone chooses where a ticket runs: nothing reads it on a timer. */
  async shared(): Promise<SharedDevice[]> {
    if (!this.cloud()) return [];
    const rows = await this.ask("tomrade_shared_devices", {}, z.array(Shared));
    return rows.map((r) => ({ share: r.share, owner: r.owner, deviceId: r.device_id, name: r.name, platform: r.platform, agents: r.agents, accept: r.accept, ceiling: r.ceiling, auto: r.auto, lastSeenAt: Date.parse(r.last_seen_at) || 0 }));
  }
}
