import { expect, it } from "vitest";
import type { Block, ThreadMessage } from "@tomradex/agent";
import { interruptedNotes } from "../src/lib/interrupted";

let seq = 0;
const msg = (id: string, block: Block, threadId = "here"): ThreadMessage => ({ id, threadId, seq: ++seq, role: "system", block, runId: null, at: seq });
const note = (id: string, extra: Partial<Extract<Block, { type: "note" }>> = {}) => msg(id, { type: "note", text: "Interrupted.", interrupted: true, ...extra });

it("offers to continue on the newest interruption only, while the conversation is still interrupted", () => {
  const messages = [note("first"), msg("reply", { type: "text", text: "Picking up." }), note("second")];
  expect(interruptedNotes(messages, "here", () => true)).toEqual(new Map([["second", "here"]]));
  // continued, waved away or archived: no note offers anything
  expect(interruptedNotes(messages, "here", () => false)).toEqual(new Map());
});

it("offers on the newest note of each conversation coding under this one, for that conversation", () => {
  const messages = [note("mine"), note("childA-old", { threadFor: "a" }), note("childA", { threadFor: "a" }), note("childB", { threadFor: "b" })];
  expect(interruptedNotes(messages, "here", (id) => id !== "b")).toEqual(new Map([["mine", "here"], ["childA", "a"]]));
});

it("leaves alone notes that are not interruptions, and interruption notes written before they were marked", () => {
  const messages = [msg("plain", { type: "note", text: "Interrupted — the app closed while this run was in progress." }), msg("moved", { type: "note", text: "Moved the coding.", threadFor: "a" })];
  expect(interruptedNotes(messages, "here", () => true)).toEqual(new Map());
});
