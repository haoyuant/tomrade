import { z } from "zod";
import { CEILINGS, levelOf, modeWithin, rankOf as rank, type Ceiling } from "@tomradex/roles";

export { CEILINGS, levelOf, modeWithin, type Ceiling };

/** What this machine takes from the account's other machines. Off until the person says so. */
export const AcceptPolicy = z.object({
  accept: z.boolean().default(false),
  /** False: only the projects named in `projects`. */
  allProjects: z.boolean().default(true),
  projects: z.array(z.string().min(1).max(64)).max(200).default([]),
  ceiling: z.enum(CEILINGS).default("edits"),
  maxConcurrent: z.number().int().min(1).max(8).default(1),
  /** Only while nobody has used this machine for a few minutes. */
  onlyWhenIdle: z.boolean().default(false),
  /** Only while it is plugged in. */
  onlyOnPower: z.boolean().default(false)
});
export type AcceptPolicy = z.infer<typeof AcceptPolicy>;
export const POLICY_DEFAULTS: AcceptPolicy = AcceptPolicy.parse({});

/** Nobody has touched the machine for this long: it counts as idle. */
export const IDLE_SECONDS = 180;

/** What another machine asks for. Everything in it is a wish: the limits are this machine's own. */
export interface DispatchRequest {
  /** The machine that asks. */
  from: string;
  projectId: string;
  /** The ticket, by its key. */
  key: string;
  /** The permission mode it would like; absent leaves the choice to this machine. */
  permissionMode?: string | null;
  /** The most the ticket's role lets a session do, as this machine's own copy of the role says; the lower of it and this machine's limit holds. */
  limit?: Ceiling | null;
}

/** How this machine stands right now. */
export interface MachineState {
  /** The projects it has. */
  projects: readonly string[];
  /** Sessions it runs for other machines at this moment. */
  running: number;
  idleSeconds: number;
  onBattery: boolean;
  /** The permission modes of the engine that would take the work; null when that is not known yet. */
  modes?: readonly string[] | null;
}

/**
 * Why a request was turned away. The first seven are this machine's settings and state; `no-agent` and `start`
 * are what the work itself lacked: no coding agent ready here, or a Start that would not go.
 */
export type Refusal = "off" | "project-not-allowed" | "project-missing" | "permission" | "busy" | "not-idle" | "on-battery" | "no-agent" | "start";

export type Admission = { ok: true; permissionMode: string | null } | { ok: false; reason: Refusal; detail?: string };

/**
 * Whether this machine takes a request, by its own settings and state alone. A permission mode above the
 * ceiling is refused, not lowered: the machine that asked is told, and can ask for less.
 */
export function admit(policy: AcceptPolicy, request: DispatchRequest, state: MachineState): Admission {
  if (!policy.accept) return { ok: false, reason: "off" };
  if (!policy.allProjects && !policy.projects.includes(request.projectId)) return { ok: false, reason: "project-not-allowed" };
  if (!state.projects.includes(request.projectId)) return { ok: false, reason: "project-missing" };
  const asked = request.permissionMode ?? null;
  const byRole = !!request.limit && rank(request.limit) < rank(policy.ceiling);
  const ceiling = byRole ? request.limit! : policy.ceiling;
  if (asked && rank(levelOf(asked)) > rank(ceiling)) return { ok: false, reason: "permission", detail: byRole ? `${asked} is above the role's limit (${ceiling})` : `${asked} is above this machine's limit (${ceiling})` };
  if (state.modes && asked && !state.modes.includes(asked)) return { ok: false, reason: "permission", detail: `${asked} is not a mode of the agent here` };
  const permissionMode = asked ?? (state.modes ? modeWithin(ceiling, state.modes) : null);
  if (state.modes && !permissionMode) return { ok: false, reason: "permission", detail: byRole ? `the agent here has no mode within the role's limit (${ceiling})` : `the agent here has no mode within this machine's limit (${ceiling})` };
  if (state.running >= policy.maxConcurrent) return { ok: false, reason: "busy", detail: `${state.running} of ${policy.maxConcurrent} running` };
  if (policy.onlyWhenIdle && state.idleSeconds < IDLE_SECONDS) return { ok: false, reason: "not-idle" };
  if (policy.onlyOnPower && state.onBattery) return { ok: false, reason: "on-battery" };
  return { ok: true, permissionMode };
}

/** What the account's other machines read of this policy, to know before asking: never more than this. */
export function published(policy: AcceptPolicy): { on: boolean; projects: "all" | string[]; ceiling: Ceiling; concurrent: number } {
  return { on: policy.accept, projects: policy.accept && !policy.allProjects ? [...policy.projects].sort() : "all", ceiling: policy.ceiling, concurrent: policy.maxConcurrent };
}
