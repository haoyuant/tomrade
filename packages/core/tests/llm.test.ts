/**
 * LLM module regression: intent routing, extraction, dedup, gap — driven by
 * the deterministic FakeProvider (offline; no API calls).
 */
import { describe, expect, it } from "vitest";
import { FakeProvider, checkDuplicate, extractTickets, gapAnalysis, routeIntent } from "../src/index.js";

describe("llm: extract", () => {
  it("extracts tickets from free text with kinds", async () => {
    const provider = new FakeProvider((system) =>
      system.includes("extract")
        ? { items: [
            { title: "Add PDF export", body: "Export reports as PDF", kind: "ticket" },
            { title: "Reporting theme", kind: "epic" }
          ] }
        : { items: [] }
    );
    const out = await extractTickets(provider, "we need pdf export");
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("ticket");
    expect(out[1].kind).toBe("epic");
    expect(out[0].body).toBe("Export reports as PDF");
  });
});

describe("llm: dedup", () => {
  it("judges duplicates and returns matched ids", async () => {
    const provider = new FakeProvider((system, user) =>
      system.includes("dedup")
        ? { is_duplicate: true, duplicates: [{ id: "abc", reason: "same requirement" }] }
        : { is_duplicate: false, duplicates: [] }
    );
    const out = await checkDuplicate(provider, {
      title: "Export report to PDF",
      body: null,
      existing: [{ id: "abc", title: "Generate PDF invoice", body: null }]
    });
    expect(out.isDuplicate).toBe(true);
    expect(out.duplicates[0].id).toBe("abc");
  });
});

describe("llm: gap analysis", () => {
  it("returns missing items with reasons", async () => {
    const provider = new FakeProvider((system) =>
      system.includes("gap")
        ? { missing: [{ title: "Schedule reports", kind: "ticket", reason: "not covered" }] }
        : { missing: [] }
    );
    const out = await gapAnalysis(provider, {
      requirement: "reports with scheduling",
      existing: [{ id: "x", title: "PDF export", body: null }]
    });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("not covered");
  });
});

describe("llm: assistant intent routing", () => {
  it("routes a create request to create_item with args", async () => {
    const provider = new FakeProvider(() => ({
      needs_tool: true,
      tool: "create_item",
      args: { title: "Add dark mode", kind: "ticket" }
    }));
    const route = await routeIntent(provider, [{ role: "user", content: "create a ticket: dark mode" }]);
    expect(route.needsTool).toBe(true);
    expect(route.tool).toBe("create_item");
    expect(route.args?.title).toBe("Add dark mode");
  });

  it("routes a plain question to a direct reply", async () => {
    const provider = new FakeProvider(() => ({ needs_tool: false, reply: "Sure!" }));
    const route = await routeIntent(provider, [{ role: "user", content: "hi" }]);
    expect(route.needsTool).toBe(false);
    expect(route.reply).toBe("Sure!");
  });

  it("rejects unknown tool names (fallback to no tool)", async () => {
    const provider = new FakeProvider(() => ({ needs_tool: true, tool: "hack_the_planet" }));
    const route = await routeIntent(provider, [{ role: "user", content: "x" }]);
    expect(route.tool).toBeUndefined();
  });
});
