import { Context, Service } from "cordis";
import { z } from "zod";
import { contract, readJsonOr, writeJsonAtomic } from "@tomradex/contracts";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type { SettingsSection } from "@tomradex/settings";
import { AcceptPolicy, POLICY_DEFAULTS, admit, published, type Admission, type DispatchRequest, type Refusal } from "./policy.js";
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
    onBattery: z.custom<() => boolean>((v) => typeof v === "function").optional()
  })
);
export type DispatchConfig = z.infer<typeof DispatchConfig>;

const Decision = z.object({
  at: z.number(), from: z.string(), projectId: z.string(), key: z.string(), accepted: z.boolean(),
  permissionMode: z.string().nullable().optional(), reason: z.string().optional(), detail: z.string().optional()
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
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("dispatch.decisions", (limit) => this.recent(limit));
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
    const admission = admit(this.policy(), request, {
      projects: this.home.hub.catalog.projects().map((p) => p.id),
      running: this.running.size,
      // A shell that cannot say counts as idle and plugged in: the two conditions are then the person's to leave off.
      idleSeconds: this.config.idleSeconds?.() ?? Number.MAX_SAFE_INTEGER,
      onBattery: this.config.onBattery?.() ?? false,
      modes
    });
    this.keep({
      at: Date.now(), from: request.from, projectId: request.projectId, key: request.key, accepted: admission.ok,
      ...(admission.ok ? { permissionMode: admission.permissionMode } : { reason: admission.reason, ...(admission.detail ? { detail: admission.detail } : {}) })
    });
    return admission;
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
