import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, Notification: {} }));
import { NOTIFICATIONS_SECTION, Teller, type AttentionEntry, type AttentionNote, type NotificationPrefs } from "../src/attention.js";

const WORDS = { assistant: "The assistant", permission: "{who} needs your approval", question: "{who} is asking you something", waiting: "{who} is waiting for you", stuck: "{who} stopped", finished: "{who} finished" };

function setup(overrides: Partial<NotificationPrefs> = {}) {
  const told: AttentionNote[] = [];
  const state = { focused: false, prefs: { ...NOTIFICATIONS_SECTION.defaults, ...overrides } };
  const teller = new Teller({ waitingDelayMs: 15_000, finishedAfterMs: 30_000, prefs: () => state.prefs, focused: () => state.focused, words: () => WORDS, tell: (note) => told.push(note) });
  return { teller, told, state };
}

const entry = (key: string, kind: AttentionEntry["kind"], extra: Partial<AttentionEntry> = {}): AttentionEntry => ({
  key, projectId: "p", threadId: key.replace(/^thread:/, ""), itemId: null, itemKey: null, kind, who: "Claude Code", text: "said something", since: 0, ...extra
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("leaves what already waited at launch to the badge", () => {
  const { teller, told } = setup();
  teller.update([entry("thread:a", "permission")]);
  teller.update([entry("thread:a", "permission")]);
  expect(told).toEqual([]);
});

it("tells an approval at once, and once", () => {
  const { teller, told } = setup();
  teller.update([]);
  teller.update([entry("thread:a", "permission", { itemKey: "TOM-1" })]);
  teller.update([entry("thread:a", "permission", { itemKey: "TOM-1" })]);
  expect(told.map((n) => n.title)).toEqual(["TOM-1 · Claude Code needs your approval"]);
});

it("tells a session that waits only once it has waited, and not if it ran again first", () => {
  const { teller, told } = setup();
  teller.update([]);
  teller.update([entry("thread:a", "waiting"), entry("thread:b", "waiting")]);
  vi.advanceTimersByTime(14_000);
  expect(told).toEqual([]);
  // a answered in its terminal; b still waits
  teller.update([entry("thread:b", "waiting")]);
  vi.advanceTimersByTime(2_000);
  expect(told.map((n) => n.entry.key)).toEqual(["thread:b"]);
  vi.advanceTimersByTime(60_000);
  expect(told).toHaveLength(1);
});

it("tells the same conversation again when what it waits on changes", () => {
  const { teller, told } = setup();
  teller.update([]);
  teller.update([entry("thread:a", "question")]);
  teller.update([entry("thread:a", "permission")]);
  expect(told.map((n) => n.entry.kind)).toEqual(["question", "permission"]);
});

it("says nothing while a window has focus, and does not catch up later", () => {
  const { teller, told, state } = setup();
  teller.update([]);
  state.focused = true;
  teller.update([entry("thread:a", "permission")]);
  state.focused = false;
  teller.update([entry("thread:a", "permission")]);
  expect(told).toEqual([]);
});

it("keeps to what the person switched off", () => {
  const off = setup({ approvals: false });
  off.teller.update([]);
  off.teller.update([entry("thread:a", "permission"), entry("thread:b", "stuck")]);
  expect(off.told.map((n) => n.entry.key)).toEqual(["thread:b"]);

  const none = setup({ enabled: false });
  none.teller.update([]);
  none.teller.update([entry("thread:a", "permission"), entry("thread:b", "stuck")]);
  vi.advanceTimersByTime(20_000);
  none.teller.ended(entry("thread:c", "waiting", { itemId: "i" }), { status: "done", startedAt: 0, endedAt: 1, error: null }, "Done.");
  expect(none.told).toEqual([]);
});

it("tells a finished run when it was a ticket's or took a while, with what it said last", () => {
  const { teller, told } = setup();
  teller.update([]);
  const base = { projectId: "p", threadId: "t", itemId: null, itemKey: null, who: null, text: null };
  teller.ended({ ...base, key: "thread:short" }, { status: "done", startedAt: 0, endedAt: 5_000, error: null }, "quick answer");
  teller.ended({ ...base, key: "thread:long" }, { status: "done", startedAt: 0, endedAt: 45_000, error: null }, "Wrote the plan.\n\nThree tickets.");
  teller.ended({ ...base, key: "thread:ticket", itemId: "i", itemKey: "TOM-7", who: "Codex" }, { status: "done", startedAt: 0, endedAt: 2_000, error: null }, "Merged.");
  teller.ended({ ...base, key: "thread:cancelled", itemId: "i" }, { status: "cancelled", startedAt: 0, endedAt: 60_000, error: null }, null);
  expect(told.map((n) => [n.title, n.body])).toEqual([
    ["The assistant finished", "Wrote the plan. Three tickets."],
    ["TOM-7 · Codex finished", "Merged."]
  ]);
});

it("tells a failed run once: by its session's entry when there is one, else on its own", () => {
  const { teller, told } = setup();
  teller.update([]);
  const base = { projectId: "p", itemId: null, itemKey: null, who: null, text: null };
  teller.ended({ ...base, key: "thread:a", threadId: "a" }, { status: "error", startedAt: 0, endedAt: 1, error: "LLM request failed 401" }, null);
  teller.ended({ ...base, key: "thread:b", threadId: "b" }, { status: "error", startedAt: 0, endedAt: 1, error: "exit 1" }, null);
  teller.update([entry("thread:b", "stuck", { text: "stopped: exit 1" })]);
  expect(told.map((n) => [n.entry.key, n.body])).toEqual([
    ["thread:b", "stopped: exit 1"],
    ["thread:a", "LLM request failed 401"]
  ]);
});
