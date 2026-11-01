import { describe, expect, it } from "vitest";
import { MAX_RESUMES, MERGE_WAIT_MS, OVERTIME_MS, STALL_MS, START_GRACE_MS, advance, failTicket, type NightShift, type SessionFacts, type ShiftSettings, type ShiftTicket, type TicketFacts } from "../src/rules.js";

const T0 = 1_000_000;
const ticket = (key: string, over: Partial<ShiftTicket> = {}): ShiftTicket => ({ itemId: key, key, title: key, state: "queued", why: null, threadId: null, branch: null, startedAt: null, nudgedAt: null, resumes: 0, limitedUntil: null, merge: "none", mergeAt: null, mergeWaits: 0, conflictRetried: false, ...over });
const shiftOf = (tickets: ShiftTicket[], settings: Partial<ShiftSettings> = {}, over: Partial<NightShift> = {}): NightShift => ({
  id: "s", projectId: "p", tickets, status: "running", halt: null, startedAt: T0, deadlineAt: T0 + 3_600_000, endedAt: null, failStreak: 0, spentUsd: 0, briefPath: null,
  settings: { mode: "run", concurrency: 2, maxMinutes: 60, maxUsd: null, maxFailures: 3, autoMerge: false, keepAwake: true, judge: true, ...settings }, ...over
});
const facts = (over: Partial<TicketFacts> = {}): TicketFacts => ({ status: "todo", blockers: [], session: null, parkedUntil: null, interrupted: false, ...over });
const session = (state: SessionFacts["state"], over: Partial<SessionFacts> = {}): SessionFacts => ({ state, headless: true, blocked: false, asks: false, summary: null, lastEventAt: null, ...over });
const world = (map: Record<string, Partial<TicketFacts>>) => (id: string) => facts(map[id]);
const started = (key: string, over: Partial<ShiftTicket> = {}) => ticket(key, { state: "running", startedAt: T0, nudgedAt: T0, ...over });

describe("starting tickets", () => {
  it("starts no more than the concurrency allows, in the order given", () => {
    const { shift, actions } = advance(shiftOf([ticket("A"), ticket("B"), ticket("C")]), world({}), T0);
    expect(actions).toEqual([{ kind: "start", itemId: "A" }, { kind: "start", itemId: "B" }]);
    expect(shift.tickets.map((t) => t.state)).toEqual(["running", "running", "queued"]);
  });

  it("a ticket that went to asking frees its place for the next", () => {
    const { actions } = advance(shiftOf([started("A"), ticket("B")], { concurrency: 1 }), world({ A: { status: "doing", session: session("waiting", { asks: true }) } }), T0 + 1000);
    expect(actions).toEqual([{ kind: "start", itemId: "B" }]);
  });

  it("holds new tickets while a usage limit is on: they would only hit it too", () => {
    const { shift, actions } = advance(shiftOf([started("A"), ticket("B")]), world({ A: { status: "doing", parkedUntil: T0 + 60_000, session: session("idle") } }), T0 + 1000);
    expect(actions).toEqual([]);
    expect(shift.tickets[0]).toMatchObject({ state: "limited", limitedUntil: T0 + 60_000 });
    expect(shift.status).toBe("running");
  });
});

describe("dependencies", () => {
  const chain = () => [ticket("A"), ticket("B")];
  const onA = { blockers: [{ itemId: "A", key: "A" }] };

  it("with automatic merging, a dependant starts once its upstream lands", () => {
    const first = advance(shiftOf(chain(), { autoMerge: true }), world({ B: onA }), T0);
    expect(first.actions).toEqual([{ kind: "start", itemId: "A" }]);
    expect(first.shift.tickets[1]).toMatchObject({ state: "queued", why: { kind: "waits-upstream", keys: ["A"] } });
    const merged = advance(first.shift, world({ A: { status: "done" } }), T0 + 1000);
    expect(merged.actions).toEqual([{ kind: "start", itemId: "B" }]);
  });

  it("without it, the shift ends with the dependant waiting for the merge, which is no failure", () => {
    const first = advance(shiftOf(chain()), world({ B: onA }), T0);
    const { shift } = advance(first.shift, world({ A: { status: "verifying", session: session("idle") }, B: onA }), T0 + 1000);
    expect(shift.status).toBe("ended");
    expect(shift.halt).toBeNull();
    expect(shift.tickets[1]).toMatchObject({ state: "skipped", why: { kind: "waits-merge", keys: ["A"] } });
    expect(shift.failStreak).toBe(0);
  });

  it("an agent that merges its own work is waited for", () => {
    const first = advance(shiftOf(chain()), world({ B: onA }), T0);
    const { shift } = advance(first.shift, world({ A: { status: "verifying", session: session("running") }, B: onA }), T0 + 1000);
    expect(shift.status).toBe("running");
  });

  it("leaves a dependant of a failed ticket unstarted and says who stopped it", () => {
    const first = advance(shiftOf(chain(), { autoMerge: true }), world({ B: onA }), T0);
    const { shift } = advance(first.shift, world({ A: { status: "doing", session: session("error", { summary: "boom" }) }, B: onA }), T0 + 1000);
    expect(shift.tickets[0]).toMatchObject({ state: "failed", why: { kind: "error", text: "boom" } });
    expect(shift.tickets[1]).toMatchObject({ state: "skipped", why: { kind: "upstream-stuck", keys: ["A"] } });
    expect(shift.status).toBe("ended");
  });

  it("says when the wait is on a ticket outside the shift", () => {
    const { shift } = advance(shiftOf([ticket("B")]), world({ B: { blockers: [{ itemId: "Z", key: "Z" }] } }), T0);
    expect(shift.tickets[0]).toMatchObject({ state: "skipped", why: { kind: "waits-outside", keys: ["Z"] } });
    expect(shift.status).toBe("ended");
  });

  it("a cycle ends the shift rather than waiting forever", () => {
    const { shift } = advance(shiftOf(chain(), { autoMerge: true }), world({ A: { blockers: [{ itemId: "B", key: "B" }] }, B: onA }), T0);
    expect(shift.status).toBe("ended");
  });
});

describe("what a session says", () => {
  const after = (f: Partial<TicketFacts>, mode: ShiftSettings["mode"] = "run", at = T0 + START_GRACE_MS + 1) => advance(shiftOf([started("A")], { mode }), world({ A: { status: "doing", ...f } }), at).shift.tickets[0]!;

  it("a question is the person's", () => expect(after({ session: session("waiting", { asks: true, summary: "Which?" }) })).toMatchObject({ state: "needs-you", why: { kind: "asked", text: "Which?" } }));
  it("a credentials stop is the person's", () => expect(after({ session: session("error", { blocked: true, summary: "no access" }) }).state).toBe("needs-you"));
  it("a session that ended undelivered failed", () => expect(after({ session: session("ended") })).toMatchObject({ state: "failed", why: { kind: "ended" } }));
  it("a background session at rest without delivering stopped short", () => expect(after({ session: session("idle") })).toMatchObject({ state: "needs-you", why: { kind: "stopped" } }));
  it("a background session is not judged in its first minute", () => expect(after({ session: session("idle") }, "run", T0 + 1000).state).toBe("running"));
  it("a terminal session that only went quiet is still at work", () => expect(after({ session: session("idle", { headless: false }) }, "terminal").state).toBe("running"));
  it("a terminal agent that stopped its turn without delivering is the person's", () => expect(after({ session: session("waiting", { headless: false }) }, "terminal")).toMatchObject({ state: "needs-you", why: { kind: "stopped" } }));

  it("a ticket stopped at a gate stays failed: it has no session to speak for it", () => {
    const { shift } = advance(shiftOf([started("A", { state: "failed", why: { kind: "gate", text: "no agent" } }), started("B")]), world({ A: { status: "todo" }, B: { status: "doing", session: session("running") } }), T0 + 1000);
    expect(shift.tickets[0]).toMatchObject({ state: "failed", why: { kind: "gate" } });
    expect(shift.failStreak).toBe(0);
  });

  it("a session that never showed up is a failure, in time", () => {
    const quiet = advance(shiftOf([started("A")]), world({ A: { status: "doing" } }), T0 + 1000);
    expect(quiet.shift.tickets[0]!.state).toBe("running");
    const gone = advance(shiftOf([started("A")]), world({ A: { status: "doing" } }), T0 + 6 * 60_000);
    expect(gone.shift.tickets[0]).toMatchObject({ state: "failed", why: { kind: "never-started" } });
  });

  it("a failed ticket that delivers after all counts as delivered", () => {
    const { shift } = advance(shiftOf([started("A", { state: "failed" }), started("B")]), world({ A: { status: "verifying" }, B: { status: "doing", session: session("running") } }), T0 + 1000);
    expect(shift.tickets[0]!.state).toBe("delivered");
  });
});

describe("limits", () => {
  it("stops starting at the deadline and lets what is at work finish", () => {
    const { shift, actions } = advance(shiftOf([started("A"), ticket("B")]), world({ A: { status: "doing", session: session("running") } }), T0 + 3_600_000);
    expect(shift).toMatchObject({ halt: "deadline", status: "running" });
    expect(actions).toEqual([]);
    const done = advance(shift, world({ A: { status: "verifying", session: session("idle") } }), T0 + 3_700_000).shift;
    expect(done).toMatchObject({ status: "ended", halt: "deadline" });
    expect(done.tickets[1]).toMatchObject({ state: "skipped", why: { kind: "halted", halt: "deadline" } });
  });

  it("stops starting past the spending limit", () => {
    const { shift, actions } = advance(shiftOf([started("A"), ticket("B")], { maxUsd: 5 }, { spentUsd: 5 }), world({ A: { status: "doing", session: session("running") } }), T0 + 1000);
    expect(shift.halt).toBe("budget");
    expect(actions).toEqual([]);
  });

  it("stops after failures in a row, and a delivery in between clears the count", () => {
    const failing = { status: "doing" as const, session: session("error") };
    const two = advance(shiftOf([started("A"), started("B"), ticket("C")], { concurrency: 1, maxFailures: 2 }), world({ A: failing, B: failing }), T0 + 1000).shift;
    expect(two.halt).toBe("failures");
    const cleared = advance(shiftOf([started("A"), started("B"), ticket("C")], { maxFailures: 2 }, { failStreak: 1 }), world({ A: { status: "verifying" }, B: failing }), T0 + 1000).shift;
    expect(cleared.halt).toBeNull();
  });

  it("failTicket counts against the shift", () => {
    expect(failTicket(shiftOf([started("A")]), "A", { kind: "gate", text: "no agent" })).toMatchObject({ failStreak: 1, tickets: [{ state: "failed", why: { kind: "gate" } }] });
  });

  it("stopped: nothing new, nothing merged", () => {
    const { actions } = advance(shiftOf([ticket("A", { state: "delivered" }), ticket("B")], { autoMerge: true }, { halt: "stopped" }), world({ A: { status: "verifying" } }), T0);
    expect(actions).toEqual([]);
  });
});

describe("agents that never finish", () => {
  it("a terminal agent gone quiet gives up its place, and counts again if it speaks up", () => {
    const at = T0 + STALL_MS + 1000;
    const quiet = advance(shiftOf([started("A"), ticket("B")], { mode: "terminal", concurrency: 1 }), world({ A: { status: "doing", session: session("idle", { headless: false, lastEventAt: T0 }) } }), at);
    expect(quiet.shift.tickets[0]).toMatchObject({ state: "needs-you", why: { kind: "stalled" } });
    expect(quiet.actions).toEqual([{ kind: "start", itemId: "B" }]);
    expect(advance(quiet.shift, world({ A: { status: "doing", session: session("running", { headless: false }) }, B: { status: "doing", session: session("running") } }), at + 1000).shift.tickets[0]!.state).toBe("running");
  });

  it("a shift stops watching an hour past its deadline, so it cannot stay open for good", () => {
    const hung = { A: { status: "doing" as const, session: session("running") } };
    const late = advance(shiftOf([started("A"), ticket("B")]), world(hung), T0 + 3_600_000 + OVERTIME_MS - 1000).shift;
    expect(late.status).toBe("running");
    const over = advance(late, world(hung), T0 + 3_600_000 + OVERTIME_MS).shift;
    expect(over).toMatchObject({ status: "ended", halt: "deadline" });
    expect(over.tickets.map((t) => [t.state, t.why?.kind])).toEqual([["needs-you", "overtime"], ["skipped", "halted"]]);
  });
});

describe("going on", () => {
  it("a terminal agent is told to go on once its limit lifts; a background one goes on by itself", () => {
    const limited = started("A", { state: "limited", limitedUntil: T0 + 1000 });
    const terminal = advance(shiftOf([limited], { mode: "terminal" }), world({ A: { status: "doing", session: session("error", { headless: false }) } }), T0 + 2000);
    expect(terminal.actions).toEqual([{ kind: "continue", itemId: "A" }]);
    expect(terminal.shift.tickets[0]).toMatchObject({ state: "running", resumes: 1, limitedUntil: null });
    const run = advance(shiftOf([limited]), world({ A: { status: "doing", session: session("running") } }), T0 + 2000);
    expect(run.actions).toEqual([]);
    expect(run.shift.tickets[0]!.state).toBe("running");
  });

  it("gives up on a ticket that keeps stopping", () => {
    const { shift, actions } = advance(shiftOf([started("A", { state: "limited", limitedUntil: T0, resumes: MAX_RESUMES })], { mode: "terminal" }), world({ A: { status: "doing", session: session("error") } }), T0 + 1000);
    expect(actions).toEqual([]);
    expect(shift.tickets[0]).toMatchObject({ state: "failed", why: { kind: "resumes-spent" } });
  });

  it("takes up a run the app's closing interrupted, not a second one", () => {
    const { actions, shift } = advance(shiftOf([started("A", { threadId: "th" })]), world({ A: { status: "doing", interrupted: true, session: session("running") } }), T0 + START_GRACE_MS + 1);
    expect(actions).toEqual([{ kind: "continue", itemId: "A" }]);
    expect(shift.tickets[0]!.startedAt).toBe(T0);
  });
});

describe("merging", () => {
  const delivered = (over: Partial<ShiftTicket> = {}) => started("A", { state: "delivered", ...over });

  it("asks for a merge once the agent has let go", () => {
    expect(advance(shiftOf([delivered()], { autoMerge: true }), world({ A: { status: "verifying", session: session("idle") } }), T0).actions).toEqual([{ kind: "merge", itemId: "A" }]);
    expect(advance(shiftOf([delivered()], { autoMerge: true }), world({ A: { status: "verifying", session: session("running") } }), T0).actions).toEqual([]);
  });

  it("waits out the checks, and stays open while it does", () => {
    const waiting = delivered({ merge: "waiting", mergeAt: T0 + MERGE_WAIT_MS });
    const early = advance(shiftOf([waiting], { autoMerge: true }), world({ A: { status: "verifying" } }), T0 + 1000);
    expect(early.actions).toEqual([]);
    expect(early.shift.status).toBe("running");
    expect(advance(shiftOf([waiting], { autoMerge: true }), world({ A: { status: "verifying" } }), T0 + MERGE_WAIT_MS).actions).toEqual([{ kind: "merge", itemId: "A" }]);
  });

  it("a conflict its agent could not resolve is the person's, counts as a failure, and holds what depends on it", () => {
    const back = started("A", { conflictRetried: true });
    const { shift } = advance(shiftOf([back, ticket("B")], { autoMerge: true }), world({ A: { status: "doing", session: session("ended") }, B: { blockers: [{ itemId: "A", key: "A" }] } }), T0 + 1000);
    expect(shift.tickets[0]).toMatchObject({ state: "needs-you", why: { kind: "conflict-unresolved" } });
    expect(shift.failStreak).toBe(1);
    expect(shift.tickets[1]).toMatchObject({ state: "skipped", why: { kind: "upstream-stuck", keys: ["A"] } });
  });

  it("a ticket sent back delivers again and goes round to the merge", () => {
    const { actions, shift } = advance(shiftOf([started("A", { conflictRetried: true })], { autoMerge: true }), world({ A: { status: "verifying", session: session("idle") } }), T0 + 1000);
    expect(shift.tickets[0]!.state).toBe("delivered");
    expect(actions).toEqual([{ kind: "merge", itemId: "A" }]);
  });

  it("a conflict left with the person stays with them while the ticket sits in Verifying", () => {
    const left = started("A", { state: "needs-you", merge: "refused", conflictRetried: true, why: { kind: "conflict-unresolved" } });
    const { shift, actions } = advance(shiftOf([left], { autoMerge: true }), world({ A: { status: "verifying" } }), T0 + 1000);
    expect(shift.tickets[0]).toMatchObject({ state: "needs-you", why: { kind: "conflict-unresolved" } });
    expect(actions).toEqual([]);
    expect(shift.failStreak).toBe(0);
  });

  it("a refused merge ends the wait and stops what depends on it", () => {
    const { shift } = advance(shiftOf([delivered({ merge: "refused", why: { kind: "checks-failed" } }), ticket("B")], { autoMerge: true }), world({ A: { status: "verifying" }, B: { blockers: [{ itemId: "A", key: "A" }] } }), T0);
    expect(shift.status).toBe("ended");
    expect(shift.tickets[0]!.why).toEqual({ kind: "checks-failed" });
    expect(shift.tickets[1]).toMatchObject({ state: "skipped", why: { kind: "upstream-stuck", keys: ["A"] } });
  });
});

