import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { summaryState, tellDeviceSessions } from "../src/device-activity.js";
import type { SessionView } from "../src/store.js";

/** As much of a session as a summary reads, with what it must never read. */
const session = (over: Partial<SessionView>): SessionView => ({
  id: "s1", projectId: "p1", itemIds: ["i1"], agent: "claude-code", state: "running", blocked: null, branch: "tom-1/work", startedAt: 1_700_000_000_000,
  cwd: "/Users/alice/code/app", worktree: "/Users/alice/wt", transcript: "/Users/alice/.claude/t.jsonl", title: "the first thing it was asked", summary: "what it said", activity: "Bash: cat ~/.ssh/id_rsa",
  ...over
} as SessionView);

function fake(sessions: Record<string, SessionView[]>) {
  const heard: Record<string, (() => void)[]> = {};
  const told: unknown[][] = [];
  const cloud = { reportActivity: (part: string, entries: unknown[]) => { if (part === "sessions") told.push(entries); } };
  const services: Record<string, unknown> = { cloudHub: cloud };
  let dispose = () => {};
  const ctx = {
    db: { openIds: () => Object.keys(sessions) },
    items: { get: (projectId: string, id: string) => (id === "gone" ? null : { key: `${projectId.toUpperCase()}-${id.slice(1)}`, title: `Ticket ${id}` }) },
    get: (name: string) => services[name],
    on: (event: string, fn: () => void) => { (heard[event] ??= []).push(fn); },
    inject: (_deps: string[], fn: () => void) => { fn(); },
    effect: (make: () => () => void) => { dispose = make(); }
  } as unknown as Context;
  return { ctx, told, services, emit: (event: string) => heard[event]?.forEach((fn) => fn()), dispose: () => dispose() };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("reads a session's state as someone at another machine would", () => {
  expect(summaryState({ state: "running", blocked: null })).toBe("working");
  expect(summaryState({ state: "waiting", blocked: null })).toBe("waiting");
  expect(summaryState({ state: "idle", blocked: null })).toBe("waiting");
  expect(summaryState({ state: "error", blocked: null })).toBe("blocked");
  expect(summaryState({ state: "running", blocked: "credentials" })).toBe("blocked");
});

it("tells the tickets live sessions hold, one reading for a burst of changes, and nothing else about them", () => {
  const sessions = {
    p1: [
      session({}),
      session({ id: "s2", itemIds: ["i2", "i3"], agent: "codex", state: "waiting", branch: "" }),
      session({ id: "s3", itemIds: ["i4"], state: "ended" }),
      session({ id: "s4", itemIds: ["i5"], state: "lost" }),
      session({ id: "s5", itemIds: [] }),
      session({ id: "s6", itemIds: ["gone"] })
    ],
    p2: [session({ id: "s7", projectId: "p2", itemIds: ["i9"], blocked: "merge" })]
  };
  const f = fake(sessions);
  tellDeviceSessions(f.ctx, (projectId) => sessions[projectId as "p1" | "p2"]);
  expect(f.told).toEqual([]);
  for (let i = 0; i < 20; i++) f.emit("codeLink/changed");
  vi.advanceTimersByTime(300);
  expect(f.told).toEqual([[
    { projectId: "p1", key: "P1-1", title: "Ticket i1", agent: "claude-code", state: "working", startedAt: 1_700_000_000_000, branch: "tom-1/work" },
    { projectId: "p1", key: "P1-2", title: "Ticket i2", agent: "codex", state: "waiting", startedAt: 1_700_000_000_000, branch: null },
    { projectId: "p1", key: "P1-3", title: "Ticket i3", agent: "codex", state: "waiting", startedAt: 1_700_000_000_000, branch: null },
    { projectId: "p2", key: "P2-9", title: "Ticket i9", agent: "claude-code", state: "blocked", startedAt: 1_700_000_000_000, branch: "tom-1/work" }
  ]]);
  expect(JSON.stringify(f.told)).not.toMatch(/Users|alice|ssh|asked|said/);

  // The sessions end: the next reading says none.
  sessions.p1 = [];
  sessions.p2 = [];
  f.emit("codeLink/changed");
  vi.advanceTimersByTime(300);
  expect(f.told.at(-1)).toEqual([]);
});

it("tells nobody where there is no account service, and stops with the plugin", () => {
  const f = fake({ p1: [session({})] });
  delete f.services.cloudHub;
  tellDeviceSessions(f.ctx, () => [session({})]);
  vi.advanceTimersByTime(300);
  expect(f.told).toEqual([]);
  f.emit("codeLink/changed");
  f.dispose();
  vi.advanceTimersByTime(300);
  expect(f.told).toEqual([]);
});
