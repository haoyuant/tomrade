import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/code-link";
import { errorMessage } from "@tomradex/contracts";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/hub-cloud";
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
  /** What the asking machine would like; the taking machine decides. */
  wish: { engine?: string; permissionMode?: string };
  state: DispatchState;
  /** Refused: a reason code, then what more there is to say (`permission: …`). Done: why it stopped, when it did not finish. */
  reason: string | null;
  /** The machine that took it. */
  claimedBy: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** What a machine sends: a ticket, and where it should run. */
export interface DispatchInput {
  projectId: string;
  itemId: string;
  /** One machine, by its id; or any machine of a platform (`win32`, `darwin`, `linux`). */
  to?: string;
  platform?: string;
  engine?: string;
  permissionMode?: string;
}

const Row = z.object({
  id: z.string(), from_device: z.string(), to_device: z.string().nullable(), to_platform: z.string().nullable(),
  project_id: z.string(), item_key: z.string(), title: z.string(),
  wish: z.object({ engine: z.string().optional(), permissionMode: z.string().optional() }).catch({}),
  state: z.enum(["queued", "accepted", "running", "done", "refused", "cancelled"]), reason: z.string().nullable(),
  claimed_by: z.string().nullable(), created_at: z.string(), updated_at: z.string(), expires_at: z.string()
});
const view = (r: z.infer<typeof Row>): DispatchView => ({
  id: r.id, fromDevice: r.from_device, toDevice: r.to_device, toPlatform: r.to_platform, projectId: r.project_id, key: r.item_key, title: r.title,
  wish: r.wish, state: r.state, reason: r.reason, claimedBy: r.claimed_by,
  createdAt: Date.parse(r.created_at) || 0, updatedAt: Date.parse(r.updated_at) || 0, expiresAt: Date.parse(r.expires_at) || 0
});

/** The slices of other services a dispatch runs through; each is read when needed, and none is imported. */
interface Cloud {
  client: { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>; from(table: string): any };
  info(): { user: { id: string } | null };
  devicesInfo?(): { state: string };
  signal?(name: string): void;
}
type Started =
  | { ok: true; sessionId: string }
  | { ok: false; gate: string; message: string; remote?: string; repo?: { id: string; name: string }; placed?: unknown };
interface CodeHost {
  start(projectId: string, itemId: string, opts: { mode: "run"; engine?: string; permissionMode?: string; source?: Record<string, string> }): Promise<Started>;
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

/** How long a request stays on offer when the asking machine says nothing else. */
const TTL_SECONDS = 24 * 3600;
/** The signal's name: the account's machines read the queue again when they hear it. */
const SIGNAL = "dispatches";

/**
 * The account's queue of tickets sent between its machines, as this machine takes part in it: it sends and
 * cancels its own, and takes the ones meant for it — by its own limits, starting them as its own Start does.
 */
export class Queue {
  private rows: DispatchView[] = [];
  /** The requests this machine runs now, each with the session it started. */
  private readonly live = new Map<string, { projectId: string; sessionId: string }>();
  /** Requests for any machine of this platform that this one cannot take: left for another, and not looked at again. */
  private readonly passed = new Set<string>();
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
    this.home.on("settings/changed", () => this.soon());
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
    for (const row of rows) {
      const act = async (work: () => Promise<unknown>) => { await work().then(() => { acted = true; }, (e) => this.home.logger.warn(`dispatch ${row.key}: ${errorMessage(e)}`)); };
      // Asked from here and never taken: no longer on offer.
      if (row.fromDevice === this.me && row.state === "queued" && row.expiresAt <= now) await act(() => this.call(cloud, "tomrade_cancel_dispatch", { p_id: row.id, p_reason: "expired" }));
      // Taken here.
      else if (row.claimedBy === this.me && (row.state === "running" || row.state === "accepted")) await act(() => this.follow(cloud, row));
      else if (row.claimedBy === this.me && row.state === "cancelled" && this.live.has(row.id)) await act(() => this.halt(row));
      // On offer to this machine.
      else if (row.state === "queued" && row.fromDevice !== this.me && row.expiresAt > now && (row.toDevice === this.me || (!row.toDevice && row.toPlatform === process.platform && !this.passed.has(row.id)))) await act(() => this.consider(cloud, row));
    }
    if (acted) {
      cloud.signal?.(SIGNAL);
      rows = await this.read(cloud).catch(() => rows);
    }
    this.take(rows);
  }

  /** A request on offer: taken if this machine's limits allow it and it has what the work needs; otherwise told why, or left for another. */
  private async consider(cloud: Cloud, row: DispatchView): Promise<void> {
    const addressed = row.toDevice === this.me;
    const request: DispatchRequest = { from: row.fromDevice, projectId: row.projectId, key: row.key, permissionMode: row.wish.permissionMode ?? null };
    const refuse = async (reason: Refusal, detail?: string) => {
      // One meant for any machine of this platform is another's to take: this one only steps aside.
      if (!addressed) { this.passed.add(row.id); return; }
      this.gate.refuse(request, reason, detail);
      await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "refused", p_reason: detail ? `${reason}: ${detail}` : reason });
    };
    const first = this.gate.peek(request);
    if (!first.ok) return refuse(first.reason, first.detail);
    const code = this.code(), items = this.items(), agent = this.home.get("agent") as AgentHost | undefined;
    if (!code || !items || !agent) return refuse("start", "this build cannot start tickets");
    // The ticket travels with its project: one that has not arrived yet is waited for, until the request runs out.
    const item = items.getByKey(row.projectId, row.key);
    if (!item) return;
    const engine = await this.engine(agent, row.wish.engine);
    if (!engine) return refuse("no-agent", row.wish.engine ? `${row.wish.engine} is not ready here, and no other coding agent is` : "no coding agent is installed and signed in here");
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
    const opts = { mode: "run" as const, engine: engine.id, ...(admission.permissionMode ? { permissionMode: admission.permissionMode } : {}), source: { dispatch: row.id, device: row.fromDevice } };
    let started: Started;
    try {
      started = await code.start(row.projectId, item.id, opts);
      if (!started.ok && started.gate === "checkout" && started.remote && started.repo && !started.placed) {
        await this.clone(row.projectId, started.repo.id, started.remote);
        started = await code.start(row.projectId, item.id, opts);
      }
    } catch (e) {
      return failed("start", errorMessage(e));
    }
    if (!started.ok) return failed("start", `${started.gate} — ${started.message}`);
    this.live.set(row.id, { projectId: row.projectId, sessionId: started.sessionId });
    this.gate.began(row.id);
    await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "running" });
  }

  /** The agent the asking machine named when it is ready here; otherwise the first that is. */
  private async engine(agent: AgentHost, wanted?: string) {
    const engines = agent.codeEngines();
    const ready = async (engine: (typeof engines)[number]) => {
      const state = await engine.available().catch(() => null);
      return !!state?.ok && (!state.capabilities || state.capabilities.includes("code"));
    };
    const named = wanted ? engines.find((e) => e.id === wanted) : undefined;
    if (named && (await ready(named))) return named;
    for (const engine of engines) if (engine !== named && (await ready(engine))) return engine;
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
  private async follow(cloud: Cloud, row: DispatchView): Promise<void> {
    const code = this.code();
    if (!code) return;
    let running = this.live.get(row.id);
    if (!running) {
      // Taken before a restart: the session it started is the ticket's live one, if it still goes.
      const item = this.items()?.getByKey(row.projectId, row.key);
      // The project is not open here yet: nothing can be said of its sessions.
      if (!item) return;
      const session = code.sessionsOf(row.projectId, item.id, { live: true })[0];
      if (row.state === "accepted" || !session) {
        await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: row.state === "accepted" ? "refused" : "done", p_reason: row.state === "accepted" ? "start: Tomrade stopped before the ticket was started" : "the session is no longer there" });
        return;
      }
      running = { projectId: row.projectId, sessionId: session.id };
      this.live.set(row.id, running);
      this.gate.began(row.id);
    }
    const session = code.sessionsOf(running.projectId, undefined, { ids: [running.sessionId] })[0];
    // Working, or waiting on the person: still going.
    if (session && (session.state === "running" || session.state === "waiting")) return;
    this.live.delete(row.id);
    this.gate.ended(row.id);
    await this.call(cloud, "tomrade_update_dispatch", { p_id: row.id, p_device: this.me, p_state: "done", p_reason: session?.state === "error" ? (session.summary ?? "the agent stopped") : null });
  }

  /** Taken back by the machine that asked: the session it started here is stopped. */
  private async halt(row: DispatchView): Promise<void> {
    const running = this.live.get(row.id);
    if (!running) return;
    this.live.delete(row.id);
    this.gate.ended(row.id);
    await this.code()?.stopSession(running.projectId, running.sessionId);
  }

  /** Asks another machine — one by its id, or any of a platform — to work a ticket. */
  async send(input: DispatchInput): Promise<DispatchView> {
    const cloud = this.cloud();
    if (!cloud) throw new Error("[not_signed_in] Sign in to send a ticket to another device.");
    const item = this.items()?.get(input.projectId, input.itemId);
    if (!item) throw new Error(`unknown item ${input.itemId}`);
    if (!input.to && !input.platform) throw new Error("Name the device, or the platform, to send the ticket to.");
    const sent = await this.call(cloud, "tomrade_create_dispatch", {
      p_from: this.me, p_to: input.to ?? null, p_platform: input.to ? null : input.platform ?? null, p_project: input.projectId, p_key: item.key, p_title: item.title,
      p_wish: { ...(input.engine ? { engine: input.engine } : {}), ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}) }, p_ttl_seconds: TTL_SECONDS
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
}
