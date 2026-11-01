import type { ItemStatus } from "@tomradex/domain";

/** Where a shift's agents work: a terminal pane the person can watch, or a background session in the assistant panel. */
export type ShiftMode = "terminal" | "run";

export interface ShiftSettings {
  mode: ShiftMode;
  engine?: string;
  options?: Record<string, unknown>;
  /** Background sessions only: a terminal agent runs as its own command says. */
  permissionMode?: string;
  concurrency: number;
  maxMinutes: number;
  /** Null sets no limit. Counts only what engines report, which terminal agents do not. */
  maxUsd: number | null;
  /** Failures in a row, with nothing delivered between them, before no new ticket starts. */
  maxFailures: number;
  autoMerge: boolean;
  /** The computer stays awake while the shift goes. */
  keepAwake: boolean;
  /** The morning report asks the worker model about each delivery; off, it says only what git says. */
  judge: boolean;
  /** Absent on a run from before there was a choice. */
  notify?: ShiftNotify;
  /** How many tickets found along the way may join the run; 0 or absent takes none. */
  maxInserts?: number;
  /** Absent on a run from before there was a choice: it waits. */
  whenLimited?: WhenLimited;
}

/** When an agent runs out of quota: go on with the next agent that can, or wait for this one. */
export type WhenLimited = "switch" | "wait";

/** What stopped an agent: a limit a clock lifts, or an account nothing is left in. */
export type LimitCause = "limit" | "balance";

/** One move of a ticket from one agent to another. */
export interface EngineSwitch {
  from: string;
  to: string;
  cause: LimitCause;
  at: number;
}

/** Every step, or only what stops a ticket; the end is always told. */
export type ShiftNotify = "steps" | "stuck";

/** What one node of the plan does differently from the run; a field left out goes as the run goes. */
export interface NodeConfig {
  mode?: ShiftMode;
  engine?: string;
  options?: Record<string, unknown>;
  permissionMode?: string;
  autoMerge?: boolean;
  whenLimited?: WhenLimited;
}

export type TicketState = "queued" | "running" | "limited" | "needs-you" | "delivered" | "done" | "failed" | "skipped";
export type Halt = "stopped" | "deadline" | "budget" | "failures";

export type Why =
  | { kind: "waits-merge" | "waits-upstream" | "upstream-stuck" | "waits-outside"; keys: string[] }
  | { kind: "halted"; halt: Halt }
  | { kind: "asked" | "error" | "gate" | "merge-refused" | "merge-conflict" | "blocked"; text: string }
  | { kind: "found"; fromKey: string; text: string }
  | { kind: "switched"; from: string; to: string; cause: LimitCause }
  | { kind: "no-engine"; engine: string }
  | { kind: "stopped" | "ended" | "never-started" | "checks-failed" | "checks-unknown" | "checks-timeout" | "resumes-spent" | "stalled" | "overtime" | "conflict-unresolved" };

export interface ShiftTicket {
  itemId: string;
  key: string;
  title: string;
  state: TicketState;
  why: Why | null;
  threadId: string | null;
  branch: string | null;
  startedAt: number | null;
  /** The last time Tomrade set its agent going: a session that has not spoken since is not yet judged. */
  nudgedAt: number | null;
  resumes: number;
  limitedUntil: number | null;
  merge: "none" | "waiting" | "merged" | "refused";
  mergeAt: number | null;
  mergeWaits: number;
  /** Its agent has been sent back once to resolve a conflict with the default branch. */
  conflictRetried: boolean;
  config?: NodeConfig;
  /** Where `config` came from: the person's hand on this node, or a work rule by name. */
  configFrom?: { kind: "manual" } | { kind: "rule"; name: string };
  /** The agent its config named could not run, so it went as the run goes. */
  engineLost?: string;
  /** It was not on the plan: an agent found it, and the worker model said to do it now. */
  origin?: { fromId: string; fromKey: string; why: string };
  /** What stopped it, while it is limited. `noEngine`: no other agent could take it, so it waits this one out. */
  limit?: { cause: LimitCause; noEngine?: boolean };
  /** Oldest first; the last `to` is the agent it goes on with. */
  switches?: EngineSwitch[];
  /** Its agent's last word while it worked, for whoever takes over: a stop writes over the session's own. */
  said?: string;
}

/** A problem an agent reported that did not join the run. */
export interface ShiftFinding {
  itemId: string;
  key: string;
  title: string;
  fromKey: string;
  why: string;
  /** It was already on the backlog, so nothing new was filed. */
  duplicate: boolean;
}

/** One thing that happened on the plan, kept with the run. */
export interface ShiftStep {
  at: number;
  kind: StepKind;
  itemId: string;
  key: string;
  title: string;
  why: Why | null;
}

export type StepKind = "started" | "limited" | "delivered" | "merged" | "refused" | "needs-you" | "failed" | "skipped" | "inserted" | "found" | "duplicate" | "switched";

export interface NightShift {
  id: string;
  projectId: string;
  settings: ShiftSettings;
  tickets: ShiftTicket[];
  status: "running" | "ended";
  /** Why no new ticket starts; null while it goes on, and for a shift that simply finished. */
  halt: Halt | null;
  startedAt: number;
  deadlineAt: number;
  endedAt: number | null;
  failStreak: number;
  spentUsd: number;
  /** The morning report, in the project's Files, once it is written. */
  briefPath: string | null;
  /** Oldest first; absent on a run from before there were any. */
  steps?: ShiftStep[];
  found?: ShiftFinding[];
}

export interface SessionFacts {
  state: "running" | "waiting" | "idle" | "error" | "ended" | "lost";
  engine: string;
  headless: boolean;
  blocked: boolean;
  asks: boolean;
  summary: string | null;
  lastEventAt: number | null;
}

export interface TicketFacts {
  status: ItemStatus | null;
  /** Tickets that must land first, still open. */
  blockers: { itemId: string; key: string }[];
  session: SessionFacts | null;
  parkedUntil: number | null;
  interrupted: boolean;
  /** Its session stopped because the agent's account has nothing left. */
  outOfBalance: boolean;
}

export type Action = { kind: "start" | "continue" | "merge" | "switch"; itemId: string };

export type TicketSettings = Pick<ShiftSettings, "mode" | "engine" | "options" | "permissionMode" | "autoMerge" | "whenLimited">;

/** How one ticket goes: its own config over the run's, and the agent it moved to over both. Options and permissions belong to an engine, so another engine does not inherit them. */
export function settingsFor(settings: ShiftSettings, ticket: Pick<ShiftTicket, "config" | "switches">): TicketSettings {
  const moved = ticket.switches?.at(-1)?.to;
  const own: NodeConfig = moved ? { ...ticket.config, engine: moved, options: undefined, permissionMode: undefined } : (ticket.config ?? {});
  const mode = own.mode ?? settings.mode;
  const engine = own.engine ?? settings.engine;
  const sameEngine = engine === settings.engine;
  const options = own.options ?? (sameEngine ? settings.options : undefined);
  const permissionMode = mode === "run" ? (own.permissionMode ?? (sameEngine ? settings.permissionMode : undefined)) : undefined;
  const whenLimited = own.whenLimited ?? settings.whenLimited;
  return { mode, ...(engine ? { engine } : {}), ...(options ? { options } : {}), ...(permissionMode ? { permissionMode } : {}), autoMerge: own.autoMerge ?? settings.autoMerge, ...(whenLimited ? { whenLimited } : {}) };
}

/** Every agent this ticket has stopped on, so that it never goes round them again. */
export const triedEngines = (t: Pick<ShiftTicket, "switches">, current: string): string[] => [...new Set([...(t.switches ?? []).map((s) => s.from), current])];

/** No agent is left to take it: a limit can still be waited out, a spent balance is the person's. */
export function outOfEngines(t: ShiftTicket, engine: string): ShiftTicket {
  if (t.limit?.cause === "balance") return { ...t, state: "needs-you", why: { kind: "no-engine", engine }, limitedUntil: null };
  return { ...t, limit: { cause: "limit", noEngine: true } };
}

/** What the agent taking over is told, in both modes: a terminal one has seen nothing of the ticket. */
export const takeOverLine = (from: string, cause: LimitCause, said: string | undefined): string =>
  [
    `${from} stopped on this ticket: ${cause === "balance" ? "its account has no balance left" : "it hit a usage limit"}. You take over on the same branch, in the same worktree.`,
    said ? `Its last note: ${said}` : "",
    "Its commits and any uncommitted changes are here and are part of the work: read git log and git status first, keep them, and go on from where it stopped."
  ].filter(Boolean).join("\n");

export const MAX_RESUMES = 5;
/** Two minutes between looks at a pull request's checks, for an hour and a half. */
export const MERGE_WAIT_MS = 2 * 60_000;
export const MERGE_WAITS = 45;
export const START_GRACE_MS = 60_000;
export const NEVER_STARTED_MS = 5 * 60_000;
/** A terminal agent this long without a word holds a place the next ticket could use; it may yet speak up and count again. */
export const STALL_MS = 30 * 60_000;
/** How long past its deadline a shift waits for what is still at work before it stops watching. */
export const OVERTIME_MS = 60 * 60_000;

const WORKING = new Set<TicketState>(["running", "limited"]);

function read(t: ShiftTicket, f: TicketFacts, now: number, switching: boolean): ShiftTicket {
  if (t.state === "skipped" || t.state === "done") return t;
  if (f.status === null || f.status === "cancelled") return { ...t, state: "skipped", why: null };
  if (f.status === "done") return { ...t, state: "done", why: null, limitedUntil: null };
  if (f.status === "verifying" && t.state === "needs-you" && t.merge === "refused") return t;
  if (f.status === "verifying") return { ...t, state: "delivered", why: t.state === "delivered" ? t.why : null, limitedUntil: null };
  if (t.state === "queued") return t;

  if (f.parkedUntil !== null) return { ...t, state: "limited", limitedUntil: f.parkedUntil, why: null, limit: t.limit ?? { cause: "limit" } };
  const s = f.session;
  // The limit has lifted, and a terminal agent waits for a word from Tomrade to go on.
  if (t.state === "limited" && (!s || s.state === "error")) return t;
  const since = t.nudgedAt ?? t.startedAt ?? now;
  if (!s) {
    // Stopped at a gate, it has no session and never will.
    if (t.state !== "running") return t;
    return now - since > NEVER_STARTED_MS ? { ...t, state: "failed", why: { kind: "never-started" } } : t;
  }
  if (s.blocked) return { ...t, state: "needs-you", why: { kind: "blocked", text: s.summary ?? "" } };
  // No clock lifts this, so it is no failure while another agent may take the ticket.
  if (s.state === "error" && f.outOfBalance && switching) return t.why?.kind === "no-engine" ? t : { ...t, state: "limited", limitedUntil: null, why: null, limit: { cause: "balance" } };
  if (s.state === "error") return { ...t, state: "failed", why: { kind: "error", text: s.summary ?? "" } };
  if (s.state === "ended" || s.state === "lost") return { ...t, state: "failed", why: { kind: "ended" } };
  if (s.state === "waiting") return { ...t, state: "needs-you", why: s.asks ? { kind: "asked", text: s.summary ?? "" } : { kind: "stopped" } };
  // A background session rests idle once its run ended; a terminal one only went quiet.
  if (s.headless && s.state === "idle" && now - since > START_GRACE_MS) return { ...t, state: "needs-you", why: { kind: "stopped" } };
  if (s.state === "idle" && now - Math.max(s.lastEventAt ?? 0, since) > STALL_MS) return { ...t, state: "needs-you", why: { kind: "stalled" } };
  return { ...t, state: "running", why: null, ...(s.summary ? { said: s.summary } : {}) };
}

/** A conflict its agent could not get past is the person's, however the agent stopped. */
function settle(t: ShiftTicket, f: TicketFacts, now: number, switching: boolean): ShiftTicket {
  const next = read(t, f, now, switching);
  if (t.conflictRetried && next.state === "failed") return { ...next, state: "needs-you", why: { kind: "conflict-unresolved" } };
  if (next.state === "limited" || !next.limit) return next;
  const { limit: _over, ...rest } = next;
  return rest;
}

const isFailure = (t: ShiftTicket) => t.state === "failed" || t.why?.kind === "conflict-unresolved" || t.why?.kind === "no-engine";

/** The whole of a shift's judgement: what the world now says of each ticket, and what to do next. */
export function advance(shift: NightShift, factsOf: (itemId: string) => TicketFacts, now: number): { shift: NightShift; actions: Action[] } {
  if (shift.status === "ended") return { shift, actions: [] };
  const { settings } = shift;
  const switches = (t: ShiftTicket) => settingsFor(settings, t).whenLimited === "switch";
  let failStreak = shift.failStreak;
  let tickets = shift.tickets.map((t) => {
    const next = settle(t, factsOf(t.itemId), now, switches(t));
    if (isFailure(next) && !isFailure(t)) failStreak += 1;
    else if ((next.state === "delivered" || next.state === "done") && t.state !== "delivered" && t.state !== "done") failStreak = 0;
    return next;
  });

  let halt = shift.halt;
  if (!halt && now >= shift.deadlineAt) halt = "deadline";
  if (!halt && failStreak >= settings.maxFailures) halt = "failures";
  if (!halt && settings.maxUsd !== null && shift.spentUsd >= settings.maxUsd) halt = "budget";

  const actions: Action[] = [];
  const merging = (t: ShiftTicket) => settingsFor(settings, t).autoMerge && halt !== "stopped";
  tickets = tickets.map((t) => {
    const f = factsOf(t.itemId);
    if (t.state === "delivered" && merging(t) && (t.merge === "none" || t.merge === "waiting") && (t.mergeAt ?? 0) <= now && f.session?.state !== "running") {
      actions.push({ kind: "merge", itemId: t.itemId });
      return t;
    }
    if (t.state === "limited" && t.limit && !t.limit.noEngine && switches(t)) {
      if (!halt) {
        actions.push({ kind: "switch", itemId: t.itemId });
        return t;
      }
      // A run past its limits brings in no other agent; a limit is still waited out as it always was.
      if (t.limit.cause === "balance") {
        failStreak += 1;
        return outOfEngines(t, f.session?.engine ?? "");
      }
    }
    const due = t.state === "limited" ? settingsFor(settings, t).mode === "terminal" && (t.limitedUntil ?? 0) <= now : t.state === "running" && f.interrupted && now - (t.nudgedAt ?? 0) > START_GRACE_MS;
    if (!due || halt === "stopped") return t;
    if (t.resumes >= MAX_RESUMES) {
      failStreak += 1;
      return { ...t, state: "failed" as const, why: { kind: "resumes-spent" as const }, limitedUntil: null };
    }
    actions.push({ kind: "continue", itemId: t.itemId });
    const { limit: _lifted, ...going } = t;
    return { ...going, state: "running" as const, resumes: t.resumes + 1, limitedUntil: null, nudgedAt: now };
  });

  const byId = new Map(tickets.map((t) => [t.itemId, t]));
  const willLand = (t: ShiftTicket, seen: Set<string>): boolean => {
    if (seen.has(t.itemId)) return false;
    const on = new Set(seen).add(t.itemId);
    if (WORKING.has(t.state)) return true;
    if (t.state === "delivered") return merging(t) ? t.merge !== "refused" && (t.merge !== "merged" || !halt) : factsOf(t.itemId).session?.state === "running";
    return t.state === "queued" && canStart(t, on);
  };
  const canStart = (t: ShiftTicket, seen: Set<string>): boolean =>
    !halt &&
    factsOf(t.itemId).blockers.every((b) => {
      const upstream = byId.get(b.itemId);
      return !!upstream && willLand(upstream, seen);
    });
  const whyWaiting = (t: ShiftTicket): Why | null => {
    const blockers = factsOf(t.itemId).blockers;
    const keys = (test: (upstream: ShiftTicket | undefined) => boolean) => blockers.filter((b) => test(byId.get(b.itemId))).map((b) => b.key);
    const outside = keys((u) => !u);
    if (outside.length) return { kind: "waits-outside", keys: outside };
    const unmerged = keys((u) => u?.state === "delivered" && !merging(u));
    if (unmerged.length) return { kind: "waits-merge", keys: unmerged };
    const stuck = keys((u) => !!u && (u.state === "failed" || u.state === "needs-you" || u.state === "skipped" || (u.state === "delivered" && u.merge === "refused")));
    if (stuck.length) return { kind: "upstream-stuck", keys: stuck };
    return blockers.length ? { kind: "waits-upstream", keys: blockers.map((b) => b.key) } : null;
  };

  let busy = tickets.filter((t) => WORKING.has(t.state)).length;
  const held = tickets.some((t) => t.state === "limited" && (t.limitedUntil ?? 0) > now);
  tickets = tickets.map((t) => {
    if (t.state !== "queued") return t;
    if (halt || held || busy >= settings.concurrency || factsOf(t.itemId).blockers.length) return { ...t, why: whyWaiting(t) };
    busy += 1;
    actions.push({ kind: "start", itemId: t.itemId });
    return { ...t, state: "running" as const, why: null, startedAt: now, nudgedAt: now };
  });

  for (const t of tickets) byId.set(t.itemId, t);
  // Agents go on past this; only the shift stops waiting for them, so it cannot stay open for good.
  if (now >= shift.deadlineAt + OVERTIME_MS) {
    const closed = tickets.map((t): ShiftTicket => (WORKING.has(t.state) || (t.state === "delivered" && t.merge === "waiting") ? { ...t, state: "needs-you", why: { kind: "overtime" }, limitedUntil: null } : t.state === "queued" ? { ...t, state: "skipped", why: t.why ?? { kind: "halted", halt: "deadline" } } : t));
    return { shift: { ...shift, tickets: closed, halt: halt ?? "deadline", failStreak, status: "ended", endedAt: now }, actions: [] };
  }
  const active = actions.length > 0 || tickets.some((t) => WORKING.has(t.state) || (t.state === "delivered" && willLand(t, new Set())) || (t.state === "queued" && canStart(t, new Set())));
  const next: NightShift = { ...shift, tickets, halt, failStreak };
  if (active) return { shift: next, actions };
  const closed = tickets.map((t) => (t.state === "queued" ? { ...t, state: "skipped" as const, why: t.why ?? (halt ? { kind: "halted" as const, halt } : null) } : t));
  return { shift: { ...next, tickets: closed, status: "ended", endedAt: now }, actions };
}

/** A run keeps its last steps: enough to read back, and no more than its row should carry. */
export const MAX_STEPS = 300;

export const isStuck = (kind: StepKind): boolean => kind === "needs-you" || kind === "failed" || kind === "refused";

const STEP_OF: Partial<Record<TicketState, StepKind>> = { limited: "limited", delivered: "delivered", done: "merged", "needs-you": "needs-you", failed: "failed", skipped: "skipped" };

/** What changed between two looks at a run, once each: a state a ticket stays in says nothing new. */
export function stepsBetween(before: NightShift, after: NightShift, at: number): ShiftStep[] {
  const was = new Map(before.tickets.map((t) => [t.itemId, t]));
  return after.tickets.flatMap((t): ShiftStep[] => {
    const prior = was.get(t.itemId);
    const step = (kind: StepKind): ShiftStep => ({ at, kind, itemId: t.itemId, key: t.key, title: t.title, why: t.why });
    const moved = t.switches?.at(-1);
    if (moved && t.switches!.length > (prior?.switches?.length ?? 0)) return [{ ...step("switched"), why: { kind: "switched", from: moved.from, to: moved.to, cause: moved.cause } }];
    if (t.merge === "refused" && prior?.merge !== "refused") return [step("refused")];
    if (prior?.state === t.state) return [];
    if (t.state === "running") return prior?.state === "queued" ? [step("started")] : [];
    const kind = STEP_OF[t.state];
    return kind ? [step(kind)] : [];
  });
}

/** What Tomrade tried for a ticket did not take: it counts against the shift like any other failure. */
export function failTicket(shift: NightShift, itemId: string, why: Why): NightShift {
  return { ...shift, failStreak: shift.failStreak + 1, tickets: shift.tickets.map((t) => (t.itemId === itemId ? { ...t, state: "failed", why } : t)) };
}
