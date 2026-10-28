import { expect, it } from "vitest";
import type { Item } from "@tomradex/domain";
import { mentionSignature } from "../src/components/workspace/agent-panel/links";
import { liveStore } from "../src/components/workspace/agent-panel/liveStore";

const item = (key: string, title: string, status = "todo") => ({ id: `id-${key}`, key, title, status }) as Item;

it("changes a reply's ticket signature only when a ticket it names changes", () => {
  const before = new Map([["TOM-1", item("TOM-1", "Login")], ["TOM-2", item("TOM-2", "Other")]]);
  const text = "Fixed TOM-1, see TOM-1 and TOM-9.";
  const sig = mentionSignature(text, before);
  // another ticket moving leaves it as it was
  expect(mentionSignature(text, new Map([...before, ["TOM-2", item("TOM-2", "Other", "done")]]))).toBe(sig);
  // the named one moving, or a named key turning up, changes it
  expect(mentionSignature(text, new Map([...before, ["TOM-1", item("TOM-1", "Login", "done")]]))).not.toBe(sig);
  expect(mentionSignature(text, new Map([...before, ["TOM-9", item("TOM-9", "New")]]))).not.toBe(sig);
  expect(mentionSignature("no keys here", before)).toBe("");
});

it("tells its listeners only when the value really changes", () => {
  const store = liveStore<{ text: string } | null>(null);
  let heard = 0;
  const off = store.subscribe(() => heard++);
  store.set((prev) => prev);
  expect(heard).toBe(0);
  store.set({ text: "a" });
  store.set((prev) => (prev ? { text: prev.text + "b" } : prev));
  expect(store.get()).toEqual({ text: "ab" });
  expect(heard).toBe(2);
  off();
  store.set(null);
  expect(heard).toBe(2);
});
