import { describe, expect, it } from "vitest";
import type { Item } from "@tomradex/domain";
import type { LayoutState, LayoutStateKey } from "@tomradex/plugin-sdk";
import { clientApi } from "../src/plugin-layout/client";
import { LayoutFeed } from "../src/plugin-layout/feed";
import { serveFrame } from "../src/plugin-layout/host";
import { applyItems, diffItems } from "../src/plugin-layout/protocol";

const item = (id: string, title = id): Item => ({ id, title, version: 1 }) as unknown as Item;
const look = { theme: "light", dark: false, tokens: {}, locale: "en" };
// One fields list and one query throughout: the feed tells keys apart by reference, as the workspace's memoized values let it.
const fields: LayoutState["fields"] = [];
const query = {} as LayoutState["query"];
const state = (items: Item[], extra: Partial<LayoutState> = {}): LayoutState => ({ projectId: "p", items, fields, query, selectedId: null, look, ...extra });

describe("items delta", () => {
  it("sends only the tickets whose object changed, the ids gone, and the order only when it moved", () => {
    const a = item("a");
    const b = item("b");
    const c = item("c");
    expect(diffItems([a, b], [a, b])).toEqual({ upsert: [], remove: [] });
    const b2 = item("b", "B");
    expect(diffItems([a, b], [a, b2])).toEqual({ upsert: [b2], remove: [] });
    expect(diffItems([a, b], [b, a])).toEqual({ upsert: [], remove: [], order: ["b", "a"] });
    expect(diffItems([a, b], [a, c])).toEqual({ upsert: [c], remove: ["b"], order: ["a", "c"] });
  });

  it("applies a delta so unchanged tickets keep their objects", () => {
    const a = item("a");
    const b = item("b");
    const b2 = item("b", "B");
    const c = item("c");
    const next = applyItems([a, b], diffItems([a, b], [a, b2]));
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(b2);
    expect(applyItems([a, b], diffItems([a, b], [c, a])).map((i) => i.id)).toEqual(["c", "a"]);
    expect(applyItems([a, b], { upsert: [c], remove: ["a"] }).map((i) => i.id)).toEqual(["b", "c"]);
  });
});

describe("layout feed", () => {
  it("coalesces every set between frames into one change naming the keys that differ", () => {
    let flush: (() => void) | null = null;
    const feed = new LayoutFeed(state([item("a")]), (fn) => ((flush = fn), () => (flush = null)));
    const heard: LayoutStateKey[][] = [];
    feed.listen((_s, changed) => heard.push([...changed].sort()));
    const first = feed.state;
    feed.set(state([item("a"), item("b")], { selectedId: "a" }));
    feed.set(state(feed.state.items, { selectedId: null }));
    expect(heard).toEqual([]);
    flush!();
    expect(heard).toEqual([["items"]]);
    feed.set(first);
    feed.set(feed.state);
    flush!();
    expect(heard).toEqual([["items"], ["items"]]);
    feed.set(feed.state);
    expect(flush).toBeNull();
  });
});

describe("frame port", () => {
  it("carries the state across as deltas and answers the frame's calls by id", async () => {
    let flush: (() => void) | null = null;
    const a = item("a");
    const b = item("b");
    const feed = new LayoutFeed(state([a, b]), (fn) => ((flush = fn), () => (flush = null)));
    const calls: string[] = [];
    const { port1, port2 } = new MessageChannel();
    const stop = serveFrame(feed, port1, { select: async (id) => void calls.push(`select ${id}`), update: async (id, patch) => void calls.push(`update ${id} ${JSON.stringify(patch)}`) }, (m) => calls.push(`error ${m}`));
    const api = clientApi(port2, structuredClone(feed.state));
    const heard: [string[], number][] = [];
    api.onChange((s, changed) => heard.push([[...changed].sort(), s.items.length]));
    const keptA = api.state.items[0];

    const b2 = item("b", "B");
    feed.set(state([a, b2, item("c")], { selectedId: "c" }));
    flush!();
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([[["items", "selectedId"], 3]]);
    expect(api.state.items[0]).toBe(keptA);
    expect(api.state.items.map((i) => i.title)).toEqual(["a", "B", "c"]);
    expect(api.state.selectedId).toBe("c");

    await api.select("a");
    await api.update("b", { title: "x" });
    expect(calls).toEqual(["select a", 'update b {"title":"x"}']);
    stop();
    port2.close();
  });
});
