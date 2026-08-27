/**
 * The assistant routes over the same registry MCP projects, so a tool
 * registered once appears on every surface — and the fake provider proves the
 * LLM seam swaps.
 */
import { describe, expect, it } from "vitest";
import { Assistant, checkDuplicate, extractTickets, gapAnalysis, routeIntent, systemPrompt } from "@tomrade/assistant";
import { FakeLlm, fakeLlm } from "@tomrade/llm";
import { fresh } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";

const boot = (respond: (system: string, user: string) => unknown) => fresh({ plugins: [Tools, fakeLlm(respond), Assistant] });

describe("workflows", () => {
  it("extracts tickets from free text with kinds", async () => {
    const llm = new FakeLlm((system) =>
      system.includes("extract")
        ? { items: [{ title: "Add PDF export", body: "Export reports as PDF", kind: "ticket" }, { title: "Reporting theme", kind: "epic" }] }
        : { items: [] }
    );
    const out = await extractTickets(llm, "we need pdf export");
    expect(out.map((o) => o.kind)).toEqual(["ticket", "epic"]);
    expect(out[0].body).toBe("Export reports as PDF");
  });

  it("judges duplicates and returns matched ids", async () => {
    const llm = new FakeLlm((system) => (system.includes("dedup") ? { is_duplicate: true, duplicates: [{ id: "abc", reason: "same requirement" }] } : { is_duplicate: false, duplicates: [] }));
    const out = await checkDuplicate(llm, { title: "Export report to PDF", body: null, existing: [{ id: "abc", title: "Generate PDF invoice", body: null }] });
    expect(out.isDuplicate).toBe(true);
    expect(out.duplicates[0].id).toBe("abc");
  });

  it("gap analysis returns missing items with reasons", async () => {
    const llm = new FakeLlm((system) => (system.includes("gap") ? { missing: [{ title: "Schedule reports", kind: "ticket", reason: "not covered" }] } : { missing: [] }));
    const out = await gapAnalysis(llm, { requirement: "reports with scheduling", existing: [{ id: "x", title: "PDF export", body: null }] });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("not covered");
  });

  it("routing only accepts tool names the registry knows", async () => {
    const tools = [{ name: "create_item", title: "", description: "", inputSchema: {} }];
    const create = await routeIntent(new FakeLlm(() => ({ needs_tool: true, tool: "create_item", args: { title: "Add dark mode" } })), tools, [{ role: "user", content: "x" }]);
    expect(create.tool).toBe("create_item");
    expect(create.args?.title).toBe("Add dark mode");
    const plain = await routeIntent(new FakeLlm(() => ({ needs_tool: false, reply: "Sure!" })), tools, [{ role: "user", content: "hi" }]);
    expect(plain.needsTool).toBe(false);
    const unknown = await routeIntent(new FakeLlm(() => ({ needs_tool: true, tool: "hack_the_planet" })), tools, [{ role: "user", content: "x" }]);
    expect(unknown.tool).toBeUndefined();
  });
});

describe("assistant over the registry", () => {
  it("the prompt is generated from every registered tool, MCP-only ones included", async () => {
    const { ctx } = await boot(() => ({ needs_tool: false, reply: "" }));
    const prompt = systemPrompt(ctx.tools.describe());
    for (const name of ["change_status", "list_boards", "extract_tickets", "gap_analysis"]) expect(prompt).toContain(`- ${name}:`);
    expect(prompt).toContain("status: backlog|todo|doing|verifying|done|cancelled");
  });

  it("chat executes the routed tool as ai:assistant, scoped to the project", async () => {
    const { ctx, items } = await boot(() => ({ needs_tool: true, tool: "create_item", args: { title: "Add dark mode" }, reply: "Created." }));
    const result = await ctx.assistant.chat("create a ticket for dark mode", [], "default");
    expect(result.kind).toBe("tool");
    const created = items.list()[0];
    expect(created.title).toBe("Add dark mode");
    expect(created.updatedBy).toBe("ai:assistant");
  });

  it("chat reports a refused tool call instead of throwing", async () => {
    const { ctx } = await boot(() => ({ needs_tool: true, tool: "update_item", args: { id: "missing", patch: { status: "done" } } }));
    const result = await ctx.assistant.chat("finish it", []);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.error).toMatch(/not found/);
  });

  it("extract_tickets and gap_analysis are ordinary registry tools", async () => {
    const { ctx } = await boot((system) => {
      if (system.includes("extract")) return { items: [{ title: "Add PDF export" }] };
      if (system.includes("dedup")) return { is_duplicate: false, duplicates: [] };
      return { missing: [{ title: "Schedule reports", reason: "absent" }] };
    });
    const extracted = (await ctx.tools.execute("extract_tickets", { text: "pdf please" }, { by: "ai:mcp" })) as { candidates: { title: string }[] };
    expect(extracted.candidates[0].title).toBe("Add PDF export");
    const gaps = (await ctx.tools.execute("gap_analysis", { requirement: "scheduled reports" }, { by: "ai:mcp" })) as { title: string }[];
    expect(gaps[0].title).toBe("Schedule reports");
  });
});
