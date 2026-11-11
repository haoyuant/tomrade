import { afterEach, expect, it, vi } from "vitest";

// The Terminal window's bridge, over a stand-in for the surface preload: what it sends, and the posts it hears.
const sent: Record<string, unknown>[] = [];
let hear: (post: unknown) => void = () => {};
(globalThis as { window?: unknown }).window = {
  tomradeSurface: {
    onMessage: (listener: (post: unknown) => void) => { hear = listener; return () => {}; },
    onState: () => () => {},
    onLook: () => () => {},
    send: (message: Record<string, unknown>) => void sent.push(message)
  }
};
const { answerSession, answerThreadAsk, openChanged, readChangeFile, readChanges } = await import("../src/code-sessions/bridge");

const settled = (p: Promise<void>) => {
  let done = false;
  void p.then(() => (done = true));
  return () => done;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  sent.length = 0;
});

it("settles a card's answer only once the plugin says it went, by its token", async () => {
  const allow = settled(answerSession("s1", "allow"));
  const choice = settled(answerThreadAsk("t1", "q", "确认"));
  expect(sent).toEqual([
    { type: "answer", sessionId: "s1", which: "allow", token: expect.any(Number) },
    { type: "answerThread", threadId: "t1", questionId: "q", value: "确认", token: expect.any(Number) }
  ]);
  const [a, b] = sent.map((m) => m.token as number);
  expect(a).not.toBe(b);
  hear({ type: "toast", text: "Allowed" });
  await flush();
  expect([allow(), choice()]).toEqual([false, false]);
  hear({ type: "answered", token: b });
  await flush();
  expect([allow(), choice()]).toEqual([false, true]);
  hear({ type: "answered", token: a });
  await flush();
  expect(allow()).toBe(true);
});

it("gives up waiting on an answer that never says it went, so its card is not stuck", async () => {
  vi.useFakeTimers();
  const allow = settled(answerSession("s1", "deny"));
  await vi.advanceTimersByTimeAsync(14_000);
  expect(allow()).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(allow()).toBe(true);
});

it("reads a ticket's changes, one of its files and where a file opened, each from the post that carries its token", async () => {
  const view = readChanges("i1", { scope: { kind: "uncommitted" }, ignoreWhitespace: true });
  const file = readChangeFile("i1", { path: "a.ts", full: true });
  const where = openChanged("i1", { linkId: "l1", path: "a.ts" });
  expect(sent).toEqual([
    { type: "changes", token: expect.any(Number), itemId: "i1", opts: { scope: { kind: "uncommitted" }, ignoreWhitespace: true } },
    { type: "changeFile", token: expect.any(Number), itemId: "i1", opts: { path: "a.ts", full: true } },
    { type: "openChanged", token: expect.any(Number), itemId: "i1", linkId: "l1", path: "a.ts" }
  ]);
  const [a, b, c] = sent.map((m) => m.token as number);
  // Answered out of order: each ask takes its own.
  hear({ type: "changedOpened", token: c, where: "cursor" });
  hear({ type: "changeFileRead", token: b, file: null });
  hear({ type: "changesRead", token: a, view: { linkId: "l1", files: [] } });
  expect(await where).toBe("cursor");
  expect(await file).toBeNull();
  expect(await view).toEqual({ linkId: "l1", files: [] });
});
