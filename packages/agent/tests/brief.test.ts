import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, BRIEF_MAX_CHARS } from "@tomradex/agent";

it("shows the brief with its time and cap, takes the person's words under the cap, and refuses more", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-brief-"));
  const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent] });
  await settle();
  const { ctx, project } = f;
  expect(ctx.agent.briefView(project.id)).toEqual({ body: "", updatedAt: null, max: BRIEF_MAX_CHARS });

  const saved = ctx.agent.setBrief(project.id, "Shop: products are pulled from the supplier feed.\r\n\n");
  expect(saved).toMatchObject({ body: "Shop: products are pulled from the supplier feed.", max: BRIEF_MAX_CHARS });
  expect(saved.updatedAt).toBeGreaterThan(0);
  expect(ctx.agent.brief(project.id)).toBe("Shop: products are pulled from the supplier feed.");

  expect(() => ctx.agent.setBrief(project.id, "x".repeat(BRIEF_MAX_CHARS + 1))).toThrow(new RegExp(`${BRIEF_MAX_CHARS}`));
  expect(ctx.agent.brief(project.id)).toBe("Shop: products are pulled from the supplier feed.");
  await ctx.fiber.dispose();
});
