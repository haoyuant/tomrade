import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => [] as string[]);
vi.mock("electron", () => ({
  app: { on: () => {}, off: () => {}, setBadgeCount: () => {} },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Notification: class {
    static isSupported = () => true;
    constructor(private readonly options: { title: string }) {}
    on() {}
    show() {
      shown.push(this.options.title);
    }
  }
}));
vi.mock("../src/main-window.js", () => ({ showMainWindow: () => null, whenLoaded: () => {} }));
import { allowOf, announceAway, attention, NOTIFICATIONS_SECTION, phonePushRequest, pushTargets, remindAway, Teller, tomradeTells, type AttentionEntry, type AttentionNote, type NotificationPrefs } from "../src/attention.js";
import { DESKTOP_WORDS } from "../src/words.js";

const WORDS = DESKTOP_WORDS("en");

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

it("tells a conversation the app's closing interrupted even when it was there at launch and a window has focus, once, unless stops are switched off", () => {
  const { teller, told, state } = setup();
  state.focused = true;
  const cut = entry("thread:a", "stuck", { interrupted: true, who: null, text: "Interrupted." });
  teller.update([entry("thread:b", "permission"), cut]);
  teller.update([entry("thread:b", "permission"), cut]);
  expect(told.map((n) => [n.title, n.body])).toEqual([["The assistant stopped", "Interrupted."]]);
  // any other stop still keeps quiet while a window has focus
  teller.update([cut, entry("thread:c", "stuck")]);
  expect(told).toHaveLength(1);

  const off = setup({ stopped: false });
  off.teller.update([cut]);
  expect(off.told).toEqual([]);
});

it("tells an approval at once, and once", () => {
  const { teller, told } = setup();
  teller.update([]);
  teller.update([entry("thread:a", "permission", { itemKey: "TOM-1" })]);
  teller.update([entry("thread:a", "permission", { itemKey: "TOM-1" })]);
  expect(told.map((n) => n.title)).toEqual(["TOM-1 · Claude Code needs your approval"]);
});

it("carries where the person was already told, so the toast can stay away while the count and the IM reminder stay", () => {
  const { teller, told } = setup();
  teller.update([]);
  teller.update([entry("session:s", "waiting", { itemKey: "TOM-2", toldIn: "herdr" })]);
  vi.advanceTimersByTime(15_000);
  expect(told.map((n) => n.entry.toldIn)).toEqual(["herdr"]);
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

it("says a conversation can go on once its usage limit lifts, unless waits are switched off", () => {
  const { teller, told, state } = setup();
  const entry = { key: "thread:t", projectId: "p", threadId: "t", itemId: "i", itemKey: "TOM-9", who: "Claude Code", text: null };
  teller.lifted(entry);
  state.prefs = { ...state.prefs, waiting: false };
  teller.lifted(entry);
  expect(told.map((n) => [n.title, n.body])).toEqual([["TOM-9 · Claude Code can go on", "The usage limit has lifted."]]);
});

it("puts the ticket and how long it waited on a phone, and the agent's words only when asked", () => {
  const note: AttentionNote = { title: "TOM-12 · Claude Code needs your approval", body: "Run the deploy?", entry: entry("thread:t1", "permission", { itemKey: "TOM-12" }) };
  const prefs: NotificationPrefs = { ...NOTIFICATIONS_SECTION.defaults, away: "push", pushNtfyCredential: "https://ntfy.sh/x" };
  expect(phonePushRequest(prefs, note, "Fix the login redirect", 3 * 60_000, WORDS)).toEqual({
    title: "TOM-12 · Claude Code needs your approval",
    body: "Fix the login redirect\nWaited 3 min"
  });
  // The message passes through a service Tomrade does not run: what the agent said is opt-in.
  expect(phonePushRequest(prefs, note, null, 40_000, WORDS)?.body).toBe("Waited 40s");
  expect(phonePushRequest({ ...prefs, pushSummary: true }, note, null, 40_000, WORDS)?.body).toContain("Run the deploy?");
  // A run that finished did not wait: nothing to say about a duration.
  expect(phonePushRequest(prefs, { ...note, event: "finished" }, "Fix it", 1_000, WORDS)?.body).toBe("Fix it");
});

it("pushes only where the person chose that, and only to the addresses they gave", () => {
  const note: AttentionNote = { title: "TOM-12 · Claude Code needs your approval", body: "Run the deploy?", entry: entry("thread:t1", "permission") };
  const im: NotificationPrefs = { ...NOTIFICATIONS_SECTION.defaults, away: "im", pushBarkCredential: "https://api.day.app/key" };
  expect(phonePushRequest(im, note, "Fix it", 60_000, WORDS)).toBeNull();
  expect(phonePushRequest({ ...im, away: "push", pushBarkCredential: "" }, note, "Fix it", 60_000, WORDS)).toBeNull();
  expect(pushTargets({ ...im, away: "push", pushBarkCredential: "https://api.day.app/key", pushFeishuCredential: "https://open.feishu.cn/hook" })).toEqual([
    { channel: "bark", url: "https://api.day.app/key" },
    { channel: "feishu", url: "https://open.feishu.cn/hook" }
  ]);
});

it("reminds in IM only when that is where the person chose to be reminded", () => {
  const reminded: unknown[] = [];
  const im = { remind: (n: unknown) => (reminded.push(n), true) };
  const note: AttentionNote = { title: "AL-1 · Claude Code needs your approval", body: "Run the deploy?", entry: entry("thread:t1", "permission") };
  remindAway({ ...NOTIFICATIONS_SECTION.defaults }, note, im);
  expect(reminded).toEqual([{ projectId: "p", threadId: "t1", kind: "permission", title: note.title, body: "Run the deploy?" }]);
  remindAway({ ...NOTIFICATIONS_SECTION.defaults, away: "none" }, note, im);
  expect(reminded).toHaveLength(1);
  // No IM running: nothing to do, and nothing breaks.
  expect(() => remindAway({ ...NOTIFICATIONS_SECTION.defaults }, note, undefined)).not.toThrow();
});

it("sends news that belongs to no conversation to IM only for someone who chose IM", () => {
  const told: unknown[] = [];
  const im = { announce: (n: unknown) => (told.push(n), true) };
  const notice = { title: "Your night shift is done", body: "2 to review, 1 merged, 0 need you" };
  announceAway({ ...NOTIFICATIONS_SECTION.defaults, away: "im" }, "night-shift:s1", notice, im);
  expect(told).toEqual([{ key: "night-shift:s1", ...notice }]);
  announceAway({ ...NOTIFICATIONS_SECTION.defaults, away: "push" }, "night-shift:s2", notice, im);
  announceAway({ ...NOTIFICATIONS_SECTION.defaults, away: "none" }, "night-shift:s3", notice, im);
  expect(told).toHaveLength(1);
  // No IM running: nothing to do, and nothing breaks.
  expect(() => announceAway({ ...NOTIFICATIONS_SECTION.defaults, away: "im" }, "night-shift:s4", notice, undefined)).not.toThrow();
});

describe("the attention row", () => {
  type Listener = (...args: unknown[]) => unknown;
  const disposers: (() => void)[] = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    shown.length = 0;
  });
  const start = () => {
    const state = { sessions: [] as unknown[], client: false, cells: undefined as Record<string, number> | undefined, interrupted: [] as { id: string; itemId: string | null; engine: string; error: string }[] };
    const listeners = new Map<string, Listener>();
    const sent: unknown[][] = [];
    const revealed: unknown[][] = [];
    const services: Record<string, unknown> = {
      codeLink: { sessionsOf: () => state.sessions, showSession: async (...args: unknown[]) => (revealed.push(args), true) },
      db: { openIds: () => ["p"] },
      terminals: { kind: "herdr" },
      herdr: { clientAttached: async () => state.client }
    };
    const ctx = {
      settings: { register: () => {}, locale: () => "en", get: () => ({}) },
      agent: {
        codeEngines: () => [{ id: "claude", title: "Claude Code" }], activities: () => [],
        store: {
          thread: () => null, messages: () => [],
          interruptedThreads: () => state.interrupted,
          interruptedRun: (_projectId: string, threadId: string) => ({ error: state.interrupted.find((th) => th.id === threadId)?.error ?? null })
        }
      },
      get: (name: string) => services[name],
      bail: (name: string) => (name === "codeLink/session-cells" ? state.cells : undefined),
      ipc: { handle: () => {}, send: (...args: unknown[]) => void sent.push(args) },
      emit: () => {},
      on: (name: string, fn: Listener) => void listeners.set(name, fn),
      effect: (fn: () => () => void) => void disposers.push(fn()),
      logger: { warn: () => {} }
    };
    attention.apply(ctx as never, { waitingDelayMs: 0 });
    return { state, listeners, sent, revealed };
  };
  const waitingIn = (id: string, pane: string | null) => ({ id, state: "waiting", threadId: null, itemIds: [], agent: "claude", activity: "Allow command?", summary: null, herdrPane: pane });

  it("leaves a herdr pane's session to herdr while a client of its own shows it, and tells it otherwise", async () => {
    const { state, listeners } = start();
    await vi.advanceTimersByTimeAsync(300);
    state.client = true;
    state.sessions = [waitingIn("s1", "w1:p1")];
    listeners.get("codeLink/changed")!("p");
    await vi.advanceTimersByTimeAsync(300);
    expect(shown).toEqual([]);
    // only Tomrade's Terminal window shows the panes: nobody else tells the person
    state.client = false;
    state.sessions = [waitingIn("s1", "w1:p1"), waitingIn("s2", "w1:p2")];
    listeners.get("codeLink/changed")!("p");
    await vi.advanceTimersByTimeAsync(300);
    expect(shown).toEqual(["Claude Code is waiting for you"]);
  });

  it("lists a conversation the app's closing interrupted as stopped, in what its note said, until it is no longer", async () => {
    const { state, listeners, sent } = start();
    const listed = () => (sent.filter(([channel]) => channel === "attention.changed").at(-1)?.[1] ?? []) as AttentionEntry[];
    state.interrupted = [{ id: "t", itemId: null, engine: "loop", error: "Interrupted — the app closed while this run was in progress." }];
    await vi.advanceTimersByTimeAsync(300);
    expect(listed()).toEqual([expect.objectContaining({ key: "thread:t", threadId: "t", kind: "stuck", who: null, text: "Interrupted — the app closed while this run was in progress.", interrupted: true })]);
    // there at launch, and told all the same
    expect(shown).toEqual(["The assistant stopped"]);
    state.interrupted = [];
    listeners.get("agent/interrupted-changed")!("p", "t");
    await vi.advanceTimersByTimeAsync(300);
    expect(listed()).toEqual([]);
  });

  it("opens a terminal session in its cell while its Terminal window is open, and in the main window's panel otherwise", async () => {
    const { state, listeners, sent, revealed } = start();
    const target = { projectId: "p", threadId: null, itemId: "i", sessionId: "s1" };
    state.cells = {};
    listeners.get("attention/open")!(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(revealed).toEqual([["p", "s1"]]);
    expect(sent.filter(([channel]) => channel === "attention.open")).toEqual([]);
    state.cells = undefined;
    listeners.get("attention/open")!(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(revealed).toHaveLength(1);
    expect(sent.filter(([channel]) => channel === "attention.open")).toEqual([["attention.open", target]]);
    // the assistant's conversation always opens in the panel
    listeners.get("attention/open")!({ projectId: "p", threadId: "t", itemId: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(revealed).toHaveLength(1);
  });
});

it("shows Tomrade's notification unless herdr shows it to an attached client", async () => {
  expect(await tomradeTells({}, async () => true)).toBe(true);
  expect(await tomradeTells({ toldIn: "herdr" }, async () => true)).toBe(false);
  expect(await tomradeTells({ toldIn: "herdr" }, async () => false)).toBe(true);
  // a client that cannot be read leaves the telling to Tomrade
  expect(await tomradeTells({ toldIn: "herdr" }, async () => Promise.reject(new Error("ps failed")))).toBe(true);
});

it("offers the tray's Allow on a terminal session's prompt whether its wait is listed as a permission or as waiting", async () => {
  const answered: string[] = [];
  const codeLink = {
    sessionPanel: () => ({ input: "ok", approval: true }),
    sessionTail: async () => "Do you want to proceed?\n❯ 1. Yes\n  2. No",
    sessionAnswer: async (_p: string, id: string) => (answered.push(id), "answered")
  };
  const ctx = { get: (name: string) => (name === "codeLink" ? codeLink : name === "agent" ? { activities: () => [] } : undefined) };
  for (const kind of ["permission", "waiting"] as const) {
    const allow = await allowOf(ctx as never, entry(`session:${kind}`, kind, { threadId: "t", sessionId: kind }), WORDS);
    expect(allow?.label).toBe(WORDS("trayAllow"));
    expect(await allow?.allow()).toBe(true);
  }
  expect(answered).toEqual(["permission", "waiting"]);
  // a question is not a prompt the tray answers
  expect(await allowOf(ctx as never, entry("session:q", "question", { sessionId: "q" }), WORDS)).toBeNull();
});
