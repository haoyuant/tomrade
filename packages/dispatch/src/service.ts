import { Context, Service } from "cordis";
import { z } from "zod";
import { contract, readJsonOr, writeJsonAtomic } from "@tomradex/contracts";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type { SettingsSection } from "@tomradex/settings";
import { AcceptPolicy, POLICY_DEFAULTS, admit, published, type Admission, type DispatchRequest, type MachineState, type Refusal } from "./policy.js";
import { Queue, type DispatchInput, type DispatchView } from "./queue.js";
import { DISPATCH_WORDS } from "./words.js";

/** One request from another machine, and what this machine said to it. */
export interface DispatchDecision {
  at: number;
  /** The machine that asked. */
  from: string;
  projectId: string;
  key: string;
  accepted: boolean;
  /** Accepted: the permission mode it runs under, when one was settled. */
  permissionMode?: string | null;
  reason?: Refusal;
  detail?: string;
}

declare module "cordis" {
  interface Context {
    dispatch: Dispatch;
  }
  interface Events {
    /** This machine took or turned away a request from another of the account's machines. */
    "dispatch/decided"(decision: DispatchDecision): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The requests this machine took or turned away, newest first. */
    "dispatch.decisions": (limit?: number) => DispatchDecision[];
    /** The account's recent tickets sent between its machines, newest first. */
    "dispatch.list": () => DispatchView[];
    /** Asks another machine to work a ticket. */
    "dispatch.send": (input: DispatchInput) => DispatchView;
    /** Takes a sent ticket back; the machine that runs it stops. */
    "dispatch.cancel": (id: string) => DispatchView[];
  }
  interface Broadcasts {
    "dispatch.changed": () => void;
  }
}

export const DispatchConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** Where the record of requests is kept on this machine; absent keeps it in memory. */
    logFile: z.string().optional(),
    /** From the desktop shell: how long nobody has used the machine, and whether it runs on battery. */
    idleSeconds: z.custom<() => number>((v) => typeof v === "function").optional(),
    onBattery: z.custom<() => boolean>((v) => typeof v === "function").optional(),
    /** How often the account's queue is looked at when nothing says it changed. */
    tickMs: z.number().int().min(50).default(30_000)
  })
);
export type DispatchConfig = z.infer<typeof DispatchConfig>;

const Decision = z.object({
  at: z.number(), from: z.string(), projectId: z.string(), key: z.string(), accepted: z.boolean(),
  permissionMode: z.string().nullable().optional(), reason: z.string().optional(), detail: z.string().optional()
});
const SendInput = z.object({
  projectId: z.string().min(1).max(64), itemId: z.string().min(1).max(64),
  to: z.string().min(1).max(64).optional(), platform: z.string().regex(/^[a-z0-9]{1,16}$/).optional(),
  engine: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(), permissionMode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/).optional()
});
/** How many requests the record keeps. */
const KEPT = 200;

const en = DISPATCH_WORDS("en");
const zh = DISPATCH_WORDS("zh");
const SECTION: SettingsSection<AcceptPolicy> = {
  id: "dispatch",
  title: en("sectionTitle"),
  description: en("sectionDescription"),
  schema: AcceptPolicy,
  defaults: POLICY_DEFAULTS,
  order: 18,
  // A machine's own say: it never follows the account to another machine.
  scope: "machine",
  // Letting another machine run code here is the person's decision alone.
  agent: "none",
  words: { zh: { title: zh("sectionTitle"), description: zh("sectionDescription") } }
};

/**
 * Whether this machine takes work from the account's other machines. Every request is decided here, by this
 * machine's settings and state, whatever the request says of itself; and every decision is kept, with who asked.
 */
export class Dispatch extends Service {
  static provide = "dispatch";
  static inject = ["settings", "hub"];
  static Config = DispatchConfig;

  private readonly home: Context;
  private decisions: DispatchDecision[] = [];
  /** Sessions this machine runs for other machines right now, by whatever names them. */
  private readonly running = new Set<string>();
  /** The account's queue of tickets sent between its machines, as this machine takes part in it. */
  queue!: Queue;

  constructor(ctx: Context, public readonly config: DispatchConfig) {
    super(ctx, "dispatch");
    this.home = ctx;
  }

  [Service.init]() {
    this.home.settings.register(SECTION);
    if (this.config.logFile) {
      const kept = z.array(Decision).safeParse(readJsonOr<unknown>(this.config.logFile, []));
      if (kept.success) this.decisions = kept.data as DispatchDecision[];
    }
    this.queue = new Queue(this.home, {
      peek: (request, modes) => this.peek(request, modes),
      admit: (request, modes) => this.admit(request, modes),
      refuse: (request, reason, detail) => this.keep({ at: Date.now(), from: request.from, projectId: request.projectId, key: request.key, accepted: false, reason, ...(detail ? { detail } : {}) }),
      began: (id) => this.began(id),
      ended: (id) => this.ended(id),
      changed: () => this.home.get("ipc")?.send("dispatch.changed")
    }, this.config.tickMs);
    this.queue.start();
    this.home.effect(() => () => this.queue.stop(), "dispatch queue");
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("dispatch.decisions", (limit) => this.recent(limit));
      ctx.ipc.handle("dispatch.list", () => this.queue.list());
      ctx.ipc.handle("dispatch.send", (input) => this.queue.send(SendInput.parse(input)));
      ctx.ipc.handle("dispatch.cancel", (id) => this.queue.cancel(z.uuid().parse(id)));
    });
    // The account's other machines read whether this one takes work, and within what, before they ask.
    this.home.inject(["cloudHub"], () => contract(this.home, "cloudHub")?.describeDevice?.("accept", () => published(this.policy())));
    this.home.on("settings/changed", (next, previous) => {
      if (JSON.stringify(next.dispatch) !== JSON.stringify(previous.dispatch)) contract(this.home, "cloudHub")?.refreshDevice?.();
    });
  }

  /** What this machine takes, as its settings say now. Settings that do not read mean nothing is taken. */
  policy(): AcceptPolicy {
    const parsed = AcceptPolicy.safeParse((this.home.settings.get() as Record<string, unknown>).dispatch ?? {});
    return parsed.success ? parsed.data : POLICY_DEFAULTS;
  }

  /**
   * Decides one request and keeps the decision. `modes`: the permission modes of the engine that would take the
   * work here, once the caller knows it. Nothing the request says loosens a limit.
   */
  admit(request: DispatchRequest, modes?: readonly string[] | null): Admission {
    const admission = this.peek(request, modes);
    this.keep({
      at: Date.now(), from: request.from, projectId: request.projectId, key: request.key, accepted: admission.ok,
      ...(admission.ok ? { permissionMode: admission.permissionMode } : { reason: admission.reason, ...(admission.detail ? { detail: admission.detail } : {}) })
    });
    return admission;
  }

  /** What `admit` would say, with nothing kept: for looking before a request is taken. */
  peek(request: DispatchRequest, modes?: readonly string[] | null): Admission {
    return admit(this.policy(), request, this.state(modes));
  }

  private state(modes?: readonly string[] | null): MachineState {
    return {
      projects: this.home.hub.catalog.projects().map((p) => p.id),
      running: this.running.size,
      // A shell that cannot say counts as idle and plugged in: the two conditions are then the person's to leave off.
      idleSeconds: this.config.idleSeconds?.() ?? Number.MAX_SAFE_INTEGER,
      onBattery: this.config.onBattery?.() ?? false,
      modes
    };
  }

  /** A session taken for another machine began, or is over: what counts against "sessions at once". */
  began(id: string): void { this.running.add(id); }
  ended(id: string): void { this.running.delete(id); }

  recent(limit = 50): DispatchDecision[] {
    return this.decisions.slice(-Math.max(1, Math.min(limit, KEPT))).reverse();
  }

  private keep(decision: DispatchDecision): void {
    this.decisions = [...this.decisions, decision].slice(-KEPT);
    if (this.config.logFile) writeJsonAtomic(this.config.logFile, this.decisions, { mode: 0o600 });
    this.home.emit("dispatch/decided", decision);
    this.home.get("ipc")?.send("dispatch.changed");
  }
}
