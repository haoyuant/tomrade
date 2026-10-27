import { describe, expect, it } from "vitest";
import type { ReviewRow, ReviewSegment } from "@tomradex/code-link";
import { alsoKeys, dayLabel, dayOf, groupByDay, landingSegment, openAtFirst, outcomeLine, outcomeParts, segmentKind, segmentSummary, segmentWork, stretchesOf } from "../src/lib/review";

const say = (key: string, vars?: Record<string, string | number>) => (vars?.n !== undefined ? `${key}:${vars.n}` : key);
const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  id: "s1", kind: "session", agent: "claude-code", title: "Save a snapshot", tickets: [], asked: 0, commits: 0, pr: null, said: null, where: "pane", threadId: null, resumable: true, startedAt: 1, endedAt: 2, ...over
});
const ticket = (key: string) => ({ itemId: key.toLowerCase(), key, title: key, pr: null, commits: 0 });
const seg = (itemId: string | null, lines: ReviewSegment["lines"] = []): ReviewSegment => ({ itemId, key: itemId?.toUpperCase() ?? null, title: null, from: null, to: null, lines });

describe("the look back's list", () => {
  it("groups rows by the local day they ended, newest day first, and names today and yesterday", () => {
    const day = 24 * 60 * 60_000;
    const now = new Date(2026, 9, 27, 15, 0).getTime();
    const rows = [row({ id: "a", endedAt: now - 60_000 }), row({ id: "b", endedAt: now - 3 * 60 * 60_000 }), row({ id: "c", endedAt: now - day }), row({ id: "d", endedAt: now - 3 * day })];
    const days = groupByDay(rows);
    expect(days.map((d) => [d.day, d.rows.map((r) => r.id)])).toEqual([[dayOf(now), ["a", "b"]], [dayOf(now - day), ["c"]], [dayOf(now - 3 * day), ["d"]]]);
    const words = { today: "今天", yesterday: "昨天" };
    const date = (at: number) => `${new Date(at).getMonth() + 1}-${new Date(at).getDate()}`;
    expect(days.map((d) => dayLabel(d.day, now, words, date))).toEqual(["今天", "昨天", date(now - 3 * day)]);
  });

  it("says the outcome first: the pull request, the commits, how often it asked — else what the session last said", () => {
    expect(outcomeParts(row({ pr: { number: 407, state: "merged", url: null }, commits: 4, asked: 2 }), say)).toEqual(["prMerged:407", "commits:4", "asked:2"]);
    expect(outcomeParts(row({ pr: { number: 9, state: "open", url: null }, commits: 1, asked: 1 }), say)).toEqual(["prOpen:9", "commit:1", "askedOnce:1"]);
    expect(outcomeParts(row({ pr: { number: null, state: "merged", url: null } }), say)).toEqual(["mergedLocally"]);
    expect(outcomeLine(row({ said: "写好了 releases/0.21.md" }), say)).toBe("写好了 releases/0.21.md");
    expect(outcomeLine(row({ asked: null, said: null }), say)).toBeNull();
    // what its code came to speaks first; without code, its last word, and the asks only when it said nothing
    expect(outcomeLine(row({ pr: { number: 407, state: "merged", url: null }, commits: 4, asked: 2, said: "done" }), say)).toBe("prMerged:407 · commits:4 · asked:2");
    expect(outcomeLine(row({ asked: 2, said: "写好了" }), say)).toBe("写好了");
    expect(outcomeLine(row({ asked: 2, said: null }), say)).toBe("asked:2");
    expect(alsoKeys(row({ tickets: [ticket("TOM-633"), ticket("TOM-647")] }))).toEqual(["TOM-647"]);
  });
});

describe("a conversation's stretches", () => {
  const talk = [{ who: "person" as const, text: "  开始做   TOM-633。" }, { who: "agent" as const, text: "先读工单。" }];
  const code = [...talk, { who: "tool" as const, text: "Write · packages/code-link/src/snapshots.ts", detail: { input: "…" } }, { who: "tool" as const, text: "Bash · pnpm test", detail: { input: "$ pnpm test", output: "Tests 18 passed" } }];

  it("marks a stretch that wrote a file or ran a command as writing code, one that only talked as chat", () => {
    expect(segmentKind(segmentWork(talk))).toBe("chat");
    const work = segmentWork(code);
    expect(segmentKind(work)).toBe("code");
    expect(work).toMatchObject({ steps: 2, files: 1, commands: 1, passed: 18 });
  });

  it("sums a stretch up by what the person first said in it, one line and shortened", () => {
    expect(segmentSummary(code)).toBe("开始做 TOM-633。");
    expect(segmentSummary([{ who: "agent", text: "x".repeat(100) }])).toBe(`${"x".repeat(79)}…`);
    expect(segmentSummary([])).toBe("");
  });

  it("opens every stretch from the list, only the ticket's from its page, landing on that ticket's last one", () => {
    const segments = [seg(null), seg("tom-634"), seg("tom-638"), seg("tom-634")];
    expect([...openAtFirst(segments, null)]).toEqual([0, 1, 2, 3]);
    expect([...openAtFirst(segments, "tom-634")]).toEqual([1, 3]);
    expect(landingSegment(segments, "tom-634")).toBe(3);
    expect(landingSegment(segments, "tom-638")).toBe(2);
    expect(landingSegment(segments, null)).toBeNull();
    expect([...stretchesOf(segments)]).toEqual([[null, 1], ["tom-634", 2], ["tom-638", 1]]);
  });
});
