import { expect, it } from "vitest";
import type { ThreadDetail, ThreadMessage } from "@tomradex/agent";
import { catchUp, heldThrough, insertMessage, missedBefore, withHeld } from "../src/lib/threadLive";

const msg = (seq: number, role: ThreadMessage["role"] = "agent"): ThreadMessage => ({
  id: `m${seq}`, threadId: "t", seq, role, block: { type: "text", text: `#${seq}` }, runId: null, at: seq
});
const seqs = (messages: ThreadMessage[]) => messages.map((m) => m.seq);

it("puts a message held back while the window slept before the question that followed it", () => {
  // the person's new question (seq 5) arrived first, the backlog from before it after waking
  let messages = [msg(1), msg(2), msg(5, "user")];
  for (const late of [msg(3), msg(4)]) messages = insertMessage(messages, late);
  expect(seqs(messages)).toEqual([1, 2, 3, 4, 5]);
  expect(messages.at(-1)!.role).toBe("user");
});

it("appends in order and ignores a message it already holds", () => {
  const messages = [msg(1), msg(2)];
  expect(seqs(insertMessage(messages, msg(3)))).toEqual([1, 2, 3]);
  expect(insertMessage(messages, msg(2))).toBe(messages);
});

it("sees a gap in what was pushed, so the thread is fetched again", () => {
  expect(missedBefore([msg(1), msg(2)], msg(3))).toBe(false);
  expect(missedBefore([msg(1), msg(2)], msg(6))).toBe(true);
  expect(missedBefore([msg(1), msg(5)], msg(2))).toBe(false);
  expect(missedBefore([], msg(9))).toBe(false);
});

it("fetches once for a burst of wake signals and again after a pause", () => {
  let now = 0;
  let fetched = 0;
  const wake = catchUp(() => fetched++, 2_000, () => now);
  wake(); // resume
  now = 50; wake(); // unlock-screen
  now = 80; wake(); // visibilitychange, focus
  expect(fetched).toBe(1);
  now = 5_000; wake();
  expect(fetched).toBe(2);
});

const detail = (messages: ThreadMessage[], threadId = "t") => ({ thread: { id: threadId }, messages, runs: [], cards: [], pending: null }) as unknown as ThreadDetail;

it("asks a thread again only for what follows the messages it holds, and whole when it holds a gap or another thread", () => {
  expect(heldThrough(undefined, "t")).toBeNull();
  expect(heldThrough(detail([]), "t")).toBeNull();
  expect(heldThrough(detail([msg(1), msg(2), msg(3)]), "t")).toBe(3);
  // a dropped event left a hole: the whole thread is asked for
  expect(heldThrough(detail([msg(1), msg(3)]), "t")).toBeNull();
  expect(heldThrough(detail([msg(1)], "other"), "t")).toBeNull();
  const held = detail([msg(1), msg(2)]);
  const merged = withHeld(held, detail([msg(3)]));
  expect(seqs(merged.messages)).toEqual([1, 2, 3]);
  // what was held keeps its identity, so its rows do not render again
  expect(merged.messages[0]).toBe(held.messages[0]);
  expect(withHeld(held, detail([])).messages).toBe(held.messages);
});
