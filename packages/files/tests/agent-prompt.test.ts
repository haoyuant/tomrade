import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Tools } from "@tomradex/tools";
import { Agent, promptSections, type TurnInput, type TurnIO } from "@tomradex/agent";
import { Files } from "@tomradex/files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-prompt-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

async function machine() {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({
    hubDir,
    plugins: [
      [Settings, { path: path.join(hubDir, "settings.json") }],
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      Tools,
      Agent,
      [Files, { watch: false, autoSyncMs: 0 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  return bag;
}

/** The turn the platform would hand an engine, minus everything this test does not read. */
const turnOf = (projectId: string, purpose: TurnInput["purpose"]): TurnInput => ({
  threadId: "t1", projectId, purpose, input: { kind: "text", text: "hello" },
  messages: [], cards: [], brief: null, pending: null, options: {}
});
const io = { playbooks: { index: () => [] } } as unknown as TurnIO;

describe("what an agent is told about a project's files", () => {
  it("never holds a turn on the files: an index not ready in a moment is left out this once", async () => {
    const { ctx, project } = await machine();
    try {
      // As a first copy still fetching a slow remote's files would.
      (ctx.files as unknown as { indexFor: () => Promise<never> }).indexFor = () => new Promise<never>(() => {});
      const input = turnOf(project.id, "backlog");
      const started = Date.now();
      await ctx.parallel("agent/prepare-turn", input);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(input.filesIndex).toBeUndefined();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("puts the index on every turn, once, and lets an engine leave it out of the per-turn prompt", async () => {
    const { ctx, project } = await machine();
    try {
      await ctx.files.write(project.id, "Specs/brief.md", Buffer.from("# Product brief\nThe plan.\n"));
      const input = turnOf(project.id, "backlog");
      await ctx.parallel("agent/prepare-turn", input);
      expect(input.filesIndex?.markdown).toContain("Specs/brief.md");
      expect(input.filesIndex?.markdown).toContain("Product brief");
      expect(input.filesIndex?.digest).toMatch(/^[0-9a-f]{12}$/);

      const sections = promptSections(input, io).join("\n\n");
      expect(sections).toContain("Specs/brief.md");
      // An engine whose session prompt already carries it must not pay again every turn.
      expect(promptSections(input, io, { filesIndex: false }).join("\n\n")).not.toContain("Specs/brief.md");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("names the folder on this machine only when the engine can open it itself", async () => {
    const { ctx, project } = await machine();
    try {
      await ctx.files.write(project.id, "notes.md", Buffer.from("# Notes\n"));
      const dir = ctx.files.dirFor(project.id)!;

      const backlog = turnOf(project.id, "backlog");
      await ctx.parallel("agent/prepare-turn", backlog);
      expect(backlog.filesIndex?.markdown).not.toContain(dir);
      expect(backlog.filesIndex?.markdown).toContain("search_files finds text");

      const general = turnOf(project.id, "general");
      await ctx.parallel("agent/prepare-turn", general);
      expect(general.filesIndex?.markdown).toContain(dir);
      expect(general.filesIndex?.markdown).toContain("Skip .tomrade-files/");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("says nothing at all when the person sets the index budget to zero", async () => {
    const { ctx, project } = await machine();
    try {
      await ctx.files.write(project.id, "notes.md", Buffer.from("# Notes\n"));
      ctx.settings.set({ ...ctx.settings.get(), files: { agentIndexTokens: 0 } });
      const input = turnOf(project.id, "backlog");
      await ctx.parallel("agent/prepare-turn", input);
      expect(input.filesIndex).toBeUndefined();
      expect(promptSections(input, io).join("\n\n")).not.toContain("Project Files");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("has no index for a project whose files were never opened", async () => {
    const { ctx, project } = await machine();
    try {
      const input = turnOf(project.id, "backlog");
      await ctx.parallel("agent/prepare-turn", input);
      expect(input.filesIndex).toBeUndefined();
      // Asking did not create the store, so a first turn runs no git.
      expect(fs.existsSync(ctx.files.dirFor(project.id)!)).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
