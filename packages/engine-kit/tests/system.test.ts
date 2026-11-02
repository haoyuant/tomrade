import { describe, expect, it } from "vitest";
import type { TurnInput } from "@tomradex/agent";
import { sessionSystem, staticSystem } from "../src/system.js";

const input = (over: Partial<TurnInput> = {}): TurnInput => ({ threadId: "thread", projectId: "project", purpose: "code", input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null, options: {}, ...over });
const filesIndex = { markdown: "Project Files — 1 file", digest: "digest" };

describe("what an agent is told when its session opens", () => {
  it("puts an agent's own web search first and keeps Tomrade's as the fallback", () => {
    const system = sessionSystem(input({ filesIndex }), { title: "Claude Code", nativeWebSearch: true });
    expect(system).toContain("as Claude Code.");
    expect(system).toMatch(/your own tools first.*web_search and web_fetch.*fail or are unavailable/);
    expect(system).toContain(filesIndex.markdown);
  });

  it("says nothing of web search to an agent that declared none", () => {
    expect(sessionSystem(input({ filesIndex }), { title: "Pi" })).toBe(`${staticSystem("Pi")}\n\n${filesIndex.markdown}`);
    expect(sessionSystem(input(), { title: "Pi" })).toBe(staticSystem("Pi"));
  });
});
