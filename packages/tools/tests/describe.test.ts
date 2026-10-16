import { Context } from "cordis";
import { expect, it } from "vitest";
import { z } from "zod";
import { Tools, defineTool } from "@tomradex/tools";

it("describes a tool without the schema draft every request would pay for, and with its kit", async () => {
  const ctx = new Context();
  await ctx.plugin(Tools);
  ctx.tools.register(defineTool({ name: "schedule_template", kit: "routines", title: "t", description: "d", input: z.object({ id: z.string() }), execute: () => null }));
  const [described] = ctx.tools.describe();
  expect(described).toMatchObject({ name: "schedule_template", kit: "routines", inputSchema: { type: "object", required: ["id"] } });
  expect(described.inputSchema).not.toHaveProperty("$schema");
});
