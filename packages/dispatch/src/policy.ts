import { z } from "zod";

/**
 * How far a session another machine asked for may go without asking anyone, from least to most:
 * `read` changes nothing, `ask` asks before each change, `edits` edits files and asks before commands,
 * `full` runs anything.
 */
export const CEILINGS = ["read", "ask", "edits", "full"] as const;
export type Ceiling = (typeof CEILINGS)[number];

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

/**
 * Each engine names its permission modes its own way. A mode this table does not know counts as `full`:
 * a mode nobody can vouch for is allowed only where everything is.
 */
const MODE_LEVEL: Record<string, Ceiling> = {
  plan: "read", "read-only": "read",
  default: "ask", local: "ask",
  acceptEdits: "edits", workspace: "edits",
  auto: "full", bypassPermissions: "full", "full-access": "full"
};
export const levelOf = (mode: string): Ceiling => MODE_LEVEL[mode] ?? "full";
const rank = (level: Ceiling) => CEILINGS.indexOf(level);

/** The most this machine lets one of an engine's modes do: the highest of them within the ceiling, or null when none is. */
export function modeWithin(ceiling: Ceiling, modes: readonly string[]): string | null {
  const allowed = modes.filter((mode) => rank(levelOf(mode)) <= rank(ceiling));
  return allowed.sort((a, b) => rank(levelOf(b)) - rank(levelOf(a)))[0] ?? null;
}

/** What another machine asks for. Everything in it is a wish: the limits are this machine's own. */
export interface DispatchRequest {
  /** The machine that asks. */
  from: string;
  projectId: string;
  /** The ticket, by its key. */
  key: string;
  /** The permission mode it would like; absent leaves the choice to this machine. */
  permissionMode?: string | null;
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

/** Why a request was turned away. */
export type Refusal = "off" | "project-not-allowed" | "project-missing" | "permission" | "busy" | "not-idle" | "on-battery";

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
  if (asked && rank(levelOf(asked)) > rank(policy.ceiling)) return { ok: false, reason: "permission", detail: `${asked} is above this machine's limit (${policy.ceiling})` };
  if (state.modes && asked && !state.modes.includes(asked)) return { ok: false, reason: "permission", detail: `${asked} is not a mode of the agent here` };
  const permissionMode = asked ?? (state.modes ? modeWithin(policy.ceiling, state.modes) : null);
  if (state.modes && !permissionMode) return { ok: false, reason: "permission", detail: `the agent here has no mode within this machine's limit (${policy.ceiling})` };
  if (state.running >= policy.maxConcurrent) return { ok: false, reason: "busy", detail: `${state.running} of ${policy.maxConcurrent} running` };
  if (policy.onlyWhenIdle && state.idleSeconds < IDLE_SECONDS) return { ok: false, reason: "not-idle" };
  if (policy.onlyOnPower && state.onBattery) return { ok: false, reason: "on-battery" };
  return { ok: true, permissionMode };
}

/** What the account's other machines read of this policy, to know before asking: never more than this. */
export function published(policy: AcceptPolicy): { on: boolean; projects: "all" | string[]; ceiling: Ceiling; concurrent: number } {
  return { on: policy.accept, projects: policy.accept && !policy.allProjects ? [...policy.projects].sort() : "all", ceiling: policy.ceiling, concurrent: policy.maxConcurrent };
}
