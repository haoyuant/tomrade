import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service, type Context } from "cordis";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@tomradex/agent";
import { Settings } from "@tomradex/settings";
import { fresh } from "@tomradex/testkit";
import { Watchdog } from "@tomradex/watchdog";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Going {
  run: { id: string; startedAt: number };
  thread: { id: string; projectId: string; itemId: string | null; engine: string; title: string; surface: string };
}

/** Stands for the agent, and has no way in: anything the watchdog did to a run would throw. */
class FakeAgent extends Service {
  static provide = "agent";
  going: Going[] = [];
  constructor(ctx: Context) {
    super(ctx, "agent");
  }
  activeRuns() {
    return this.going;
  }
}

class FakeLlm extends Service {
  static provide = "llm";
  answer: () => unknown = () => ({ verdict: "working", reason: "fine" });
  ready = true;
  asked = vi.fn<(request: { user: string; system: string; purpose?: string }) => void>();
  constructor(ctx: Context) {
    super(ctx, "llm");
  }
  async worker() {
    return this.ready ? { ok: true } : { ok: false, reason: "none" };
  }
  async completeJson(_schema: unknown, request: { user: string; system: string; purpose?: string }) {
    this.asked(request);
    return this.answer();
  }
}

async function boot(prefs: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-watchdog-"));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ watchdog: prefs }));
  const f = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings.json") }], FakeAgent, FakeLlm, [Watchdog, { intervalMs: 3_600_000 }]] });
  const ctx = f.ctx as Context;
  const agent = ctx.agent as unknown as FakeAgent;
  const llm = ctx.llm as unknown as FakeLlm;
  const s = ctx.watchdog;
  const changed = vi.fn();
  ctx.on("watchdog/changed", changed);
  const start = (threadId = "t1", over: Partial<Going["thread"]> = {}, startedAt = Date.now()) => {
    agent.going = [...agent.going, { run: { id: `run-${threadId}`, startedAt }, thread: { id: threadId, projectId: f.project.id, itemId: null, engine: "claude-code", title: "A conversation", surface: "assistant", ...over } }];
  };
  const emit = (threadId: string, event: AgentEvent) => ctx.emit("agent/event", threadId, event);
  const trace = (threadId: string, tool: string, args: unknown) =>
    emit(threadId, { type: "message", message: { id: "m", threadId, seq: 1, role: "agent", block: { type: "trace", tool, args, ok: true, summary: "did it", ms: 1 }, runId: `run-${threadId}`, at: 0 } });
  const end = (threadId: string) => {
    const going = agent.going.find((g) => g.thread.id === threadId)!;
    agent.going = agent.going.filter((g) => g !== going);
    ctx.emit("agent/run-ended", going.run as never, going.thread as never);
  };
  const judged = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { ...f, ctx, s, agent, llm, changed, start, emit, trace, end, judged };
}

it("tells of a quiet run, saying how long and what it last did, and stops once it moves", async () => {
  const { s, start, emit, changed } = await boot();
  start();
  s.look();
  emit("t1", { type: "progress", runId: "run-t1", activity: "Bash · pnpm test" });
  const now = Date.now();
  s.look(now + 14 * MINUTE);
  expect(s.notices(now + 14 * MINUTE)).toEqual([]);
  s.look(now + 15 * MINUTE);
  const [notice] = s.notices(now + 16 * MINUTE);
  expect(notice).toMatchObject({ threadId: "t1", engine: "claude-code", itemId: null });
  expect(notice!.text).toBe("No activity for 16 min. Last step: Bash · pnpm test");
  expect(changed).toHaveBeenCalledTimes(1);
  emit("t1", { type: "delta", runId: "run-t1", text: "back" });
  expect(s.notices()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("says nothing of a run that waits on the person, however long", async () => {
  const { s, start, emit, changed } = await boot();
  start();
  emit("t1", { type: "pending", pending: { threadId: "t1", kind: "permission", workflow: null, accepts: "options", question: { id: "q", text: "?" } } });
  s.look(Date.now() + 9 * HOUR);
  expect(s.notices()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
});

it("drops what it told when the run ends", async () => {
  const { s, start, end, changed } = await boot();
  start();
  s.look();
  s.look(Date.now() + 20 * MINUTE);
  expect(s.notices()).toHaveLength(1);
  end("t1");
  expect(s.notices()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("drops a run that left without saying so", async () => {
  const { s, agent, start, changed } = await boot();
  start();
  s.look();
  s.look(Date.now() + 20 * MINUTE);
  agent.going = [];
  s.look(Date.now() + 21 * MINUTE);
  expect(s.notices()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("tells of the same call five times in a row, not of the same tool", async () => {
  const { s, start, trace, emit, changed } = await boot();
  start();
  for (let i = 0; i < 9; i++) trace("t1", "Bash", { command: `step ${i}` });
  expect(s.notices()).toEqual([]);
  for (let i = 0; i < 4; i++) trace("t1", "Bash", { command: "gh run view" });
  expect(s.notices()).toEqual([]);
  trace("t1", "Bash", { command: "gh run view" });
  expect(s.notices()[0]!.text).toBe("Called Bash 5 times in a row with the same arguments.");
  expect(changed).toHaveBeenCalledTimes(1);
  trace("t1", "Bash", { command: "gh run view" });
  expect(s.notices()[0]!.text).toContain("6 times");
  emit("t1", { type: "delta", runId: "run-t1", text: "x" });
  expect(s.notices()).toHaveLength(1);
  trace("t1", "Read", { path: "a" });
  expect(s.notices()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("does not count a machine's sleep as a run's silence", async () => {
  const { s, start, emit } = await boot({ silentMinutes: 15 });
  start();
  const now = Date.now();
  s.look(now);
  emit("t1", { type: "delta", runId: "run-t1", text: "x" });
  s.look(now + 5 * HOUR);
  expect(s.notices(now + 5 * HOUR)).toEqual([]);
  // awake again, the clock starts from the waking
  s.look(now + 5 * HOUR + 16 * MINUTE);
  expect(s.notices(now + 5 * HOUR + 16 * MINUTE)).toHaveLength(1);
});

it("leaves the troubleshooter's test turn alone", async () => {
  const { s, start, emit } = await boot();
  start("t1", { surface: "probe" });
  emit("t1", { type: "delta", runId: "run-t1", text: "x" });
  s.look();
  s.look(Date.now() + 9 * HOUR);
  expect(s.notices()).toEqual([]);
});

it("watches a ticket's background run too", async () => {
  const { s, start } = await boot();
  start("t1", { surface: "code" });
  s.look();
  s.look(Date.now() + 20 * MINUTE);
  expect(s.notices()).toHaveLength(1);
});

it("does nothing while off, and forgets what it told when turned off", async () => {
  const { s, start, llm } = await boot({ enabled: false });
  start("t1", {}, Date.now() - 2 * HOUR);
  s.look();
  s.look(Date.now() + 20 * MINUTE);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.notices()).toEqual([]);
  expect(llm.asked).not.toHaveBeenCalled();
  const on = await boot();
  on.start();
  on.s.look();
  on.s.look(Date.now() + 20 * MINUTE);
  expect(on.s.notices()).toHaveLength(1);
  on.ctx.settings.set({ ...on.ctx.settings.get(), watchdog: { enabled: false } });
  expect(on.s.notices()).toEqual([]);
  expect(on.changed).toHaveBeenCalledTimes(2);
});

it("asks about a long run with its ticket and steps, and tells only of a run going nowhere", async () => {
  const { s, start, trace, emit, llm, judged, items, project, board } = await boot();
  const item = items.create({ projectId: project.id, boardId: board.id, title: "Fix login", body: "The form fails", status: "doing", workType: "coding", by: "human" });
  const now = Date.now();
  start("t1", { itemId: item.id }, now - 61 * MINUTE);
  trace("t1", "Bash", { command: "pnpm test" });
  llm.answer = () => ({ verdict: "spinning", reason: "It keeps rerunning the same failing test." });
  s.look(now);
  await judged();
  expect(llm.asked).toHaveBeenCalledTimes(1);
  const request = llm.asked.mock.calls[0]![0];
  expect(request.purpose).toBe("watchdog");
  expect(request.user).toContain("Fix login");
  expect(request.user).toContain("The form fails");
  expect(request.user).toContain("Bash: did it");
  expect(s.notices(now)).toMatchObject([{ itemId: item.id, text: "Running for 61 min: It keeps rerunning the same failing test." }]);
  // not again within the hour
  trace("t1", "Bash", { command: "pnpm build" });
  llm.answer = () => ({ verdict: "working", reason: "ok" });
  s.look(now + 2 * MINUTE);
  await judged();
  expect(llm.asked).toHaveBeenCalledTimes(1);
  // an hour on it is asked again, and the model takes back what it said
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61 * MINUTE);
  emit("t1", { type: "delta", runId: "run-t1", text: "x" });
  s.look(now + 61 * MINUTE);
  await judged();
  clock.mockRestore();
  expect(llm.asked).toHaveBeenCalledTimes(2);
  expect(s.notices(now + 61 * MINUTE)).toEqual([]);
});

it("says nothing when the model finds nothing wrong, fails, or is not there", async () => {
  const { s, start, llm, judged } = await boot();
  const now = Date.now();
  start("t1", {}, now - 2 * HOUR);
  s.look(now);
  await judged();
  expect(llm.asked).toHaveBeenCalledTimes(1);
  expect(s.notices(now)).toEqual([]);

  const failing = await boot();
  failing.start("t1", {}, now - 2 * HOUR);
  failing.llm.answer = () => {
    throw new Error("no answer");
  };
  failing.s.look(now);
  await failing.judged();
  expect(failing.llm.asked).toHaveBeenCalledTimes(1);
  expect(failing.s.notices(now)).toEqual([]);

  const none = await boot();
  none.start("t1", {}, now - 2 * HOUR);
  none.llm.ready = false;
  none.s.look(now);
  await none.judged();
  expect(none.llm.asked).not.toHaveBeenCalled();
});

it("does not ask a model the person said not to ask", async () => {
  const { s, start, llm, judged } = await boot({ judge: false });
  const now = Date.now();
  start("t1", {}, now - 2 * HOUR);
  s.look(now);
  await judged();
  expect(llm.asked).not.toHaveBeenCalled();
});

it("asks at most ten times a day, across runs", async () => {
  const { s, start, llm, judged } = await boot();
  const now = new Date(new Date().setHours(1, 0, 0, 0)).getTime();
  for (let i = 0; i < 14; i++) start(`t${i}`, {}, now - 2 * HOUR);
  // the interval here is an hour, so three of its looks read as sleep only past three hours
  for (let i = 0; i < 14; i++) {
    s.look(now + i * MINUTE);
    await judged();
  }
  expect(llm.asked).toHaveBeenCalledTimes(10);
});
