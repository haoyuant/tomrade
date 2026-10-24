/**
 * The brief as durable memory: written by section so one agent's lesson does
 * not erase another's, refused over its cap rather than cut, compacted by the
 * worker with its facts kept, and one step back when a write was a mistake.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fakeLlm } from "@tomradex/llm";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, BRIEF_MAX_CHARS, parseBrief, withSection } from "@tomradex/agent";

async function boot(llm?: (system: string, user: string) => unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-brief-"));
  const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], ...(llm ? [fakeLlm(llm)] : []), Agent] });
  await settle();
  const tool = (args: Record<string, unknown>) => f.ctx.tools.execute("update_project_brief", args, { by: "ai:test", projectId: f.project.id }) as Promise<{ ok: true; size: number; max: number; sections: string[] }>;
  return { ...f, tool };
}

it("parses and rewrites sections by heading, keeping the preamble and the others", () => {
  const body = "Shop: a storefront.\n\n## Data\nProducts come from the feed.\n\n## Stack\nVue 3.";
  expect(parseBrief(body)).toEqual({ preamble: "Shop: a storefront.", sections: [{ heading: "Data", text: "Products come from the feed." }, { heading: "Stack", text: "Vue 3." }] });
  expect(withSection(body, "data", "Products are pulled hourly, never edited here.")).toBe("Shop: a storefront.\n\n## Data\nProducts are pulled hourly, never edited here.\n\n## Stack\nVue 3.");
  expect(withSection(body, "Commands", "pnpm test")).toBe(`${body}\n\n## Commands\npnpm test`);
  expect(withSection(body, "Stack", null)).toBe("Shop: a storefront.\n\n## Data\nProducts come from the feed.");
  expect(withSection("", "Data", "x")).toBe("## Data\nx");
});

it("lets an agent add, replace and remove one section through the tool, and says what the brief now holds", async () => {
  const { ctx, project, tool } = await boot();
  await tool({ body: "Shop: a storefront." });
  expect(await tool({ section: "Data", text: "Products come from the supplier feed." })).toMatchObject({ ok: true, max: BRIEF_MAX_CHARS, sections: ["Data"] });
  await tool({ section: "Stack", text: "Vue 3, pnpm." });
  await tool({ section: "data", text: "Products are pulled hourly and never edited here." });
  expect(ctx.agent.brief(project.id)).toBe("Shop: a storefront.\n\n## Data\nProducts are pulled hourly and never edited here.\n\n## Stack\nVue 3, pnpm.");
  expect(await tool({ section: "Stack", remove: true })).toMatchObject({ sections: ["Data"] });
  await expect(tool({})).rejects.toThrow(/pass body, or section/);
  await ctx.fiber.dispose();
});

it("refuses a write over the cap with the size and the cap, and keeps the brief as it was", async () => {
  const { ctx, project, tool } = await boot();
  await tool({ body: "Short." });
  const long = "x".repeat(BRIEF_MAX_CHARS);
  await expect(tool({ section: "Everything", text: long })).rejects.toThrow(new RegExp(`${BRIEF_MAX_CHARS} characters[\\s\\S]*${long.length + "## Everything\n".length + "Short.\n\n".length}[\\s\\S]*compact`));
  expect(ctx.agent.brief(project.id)).toBe("Short.");
  await ctx.fiber.dispose();
});

it("keeps one step back and restores it, and compacts with the worker leaving the long one behind", async () => {
  const seen: string[] = [];
  const { ctx, project, tool } = await boot((system, user) => (seen.push(system, user), { brief: "## Data\nProducts: supplier feed, hourly, read-only here." }));
  expect(() => ctx.agent.restoreBrief(project.id)).toThrow(/no earlier brief/);
  await tool({ body: "First." });
  await tool({ body: "Second." });
  expect(ctx.agent.briefView(project.id)).toMatchObject({ body: "Second.", previous: "First." });
  expect(ctx.agent.restoreBrief(project.id)).toMatchObject({ body: "First.", previous: "Second." });
  // Writing the same text again keeps the step back as it was.
  await tool({ body: "First." });
  expect(ctx.agent.briefView(project.id)).toMatchObject({ body: "First.", previous: "Second." });

  await tool({ body: "Shop: a storefront that shows products.\n\n## Data\nThe products, every single one of them, are pulled from the supplier feed every hour and are never edited here." });
  expect(await tool({ compact: true })).toMatchObject({ size: "## Data\nProducts: supplier feed, hourly, read-only here.".length, sections: ["Data"] });
  expect(seen[0]).toContain("compact a project brief");
  expect(seen[1]).toContain("Keep it under");
  expect(ctx.agent.briefView(project.id)).toMatchObject({ body: "## Data\nProducts: supplier feed, hourly, read-only here.", previous: expect.stringContaining("every single one of them") });
  await ctx.fiber.dispose();
});

it("says a compaction needs a worker model when there is none", async () => {
  const { ctx, project, tool } = await boot();
  await tool({ body: "Something." });
  await expect(tool({ compact: true })).rejects.toThrow(/worker model/);
  await ctx.fiber.dispose();
});
