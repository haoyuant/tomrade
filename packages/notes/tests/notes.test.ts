import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Tools } from "@tomradex/tools";
import { Files } from "@tomradex/files";
import { Notes } from "@tomradex/notes";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-notes-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

async function boot() {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({
    hubDir,
    plugins: [
      [Settings, { path: path.join(hubDir, "settings.json") }],
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      Tools,
      [Files, { watch: false, autoSyncMs: 0 }],
      [Notes, { debounceMs: 0 }]
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  return bag;
}

const call = (ctx: Awaited<ReturnType<typeof boot>>["ctx"], name: string, args: Record<string, unknown>, projectId: string) =>
  ctx.tools.execute(name, args, { by: "ai:test", projectId }) as Promise<string>;

describe("notes over a project's files", { timeout: 60_000 }, () => {
  it("indexes notes and ranks a search by title, path and text", async () => {
    const { ctx, project } = await boot();
    const id = project.id;
    try {
      await ctx.files.write(id, "docs/onboarding.md", "# Onboarding guide\n\nHow a new hire gets a laptop and accounts.\n#process");
      await ctx.files.write(id, "notes/standup.md", "Standup: the laptop order is late; onboarding slips a week.\n#meeting #process/weekly");
      await ctx.files.write(id, "notes/喝水计划.md", "# 喝水计划\n\n每天喝水八杯，提醒同事。");
      await ctx.files.write(id, "readme.txt", "plain text that mentions a laptop");
      await ctx.files.write(id, "img/logo.svg", "<svg/>");

      const words = await ctx.notes.search(id, { query: "laptop onboarding" });
      expect(words.hits.map((h) => h.path)).toEqual(["docs/onboarding.md", "notes/standup.md"]);
      expect(words.hits[0]!.title).toBe("Onboarding guide");
      expect(words.hits[1]!.snippet).toContain("laptop order");
      const [start, end] = words.hits[1]!.marks[0]!;
      expect(words.hits[1]!.snippet.slice(start, end).toLowerCase()).toBe("laptop");

      expect((await ctx.notes.search(id, { query: "laptop" })).total).toBe(3);
      // two-character Chinese words are below a trigram; they still match
      expect((await ctx.notes.search(id, { query: "喝水" })).hits.map((h) => h.path)).toEqual(["notes/喝水计划.md"]);
      // and a short word with a capital SQLite cannot fold matches as written
      await ctx.files.write(id, "notes/öl.md", "Öl wechseln");
      expect((await ctx.notes.search(id, { query: "Öl" })).hits.map((h) => h.path)).toEqual(["notes/öl.md"]);
      expect((await ctx.notes.search(id, { query: "#process" })).hits.map((h) => h.path).sort()).toEqual(["docs/onboarding.md", "notes/standup.md"]);
      expect((await ctx.notes.search(id, { query: "#process/weekly" })).hits.map((h) => h.path)).toEqual(["notes/standup.md"]);
      expect((await ctx.notes.search(id, { query: "laptop path:notes" })).hits.map((h) => h.path)).toEqual(["notes/standup.md"]);
      expect((await ctx.notes.search(id, { query: '"order is late"' })).hits).toHaveLength(1);
      expect(await ctx.notes.tags(id)).toEqual([
        { tag: "process", count: 1 },
        { tag: "meeting", count: 1 },
        { tag: "process/weekly", count: 1 }
      ].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)));

      // an edit is searchable as soon as it is asked for, a delete drops out
      await ctx.files.write(id, "notes/standup.md", "Standup moved to Thursdays.");
      expect((await ctx.notes.search(id, { query: "Thursdays" })).hits.map((h) => h.path)).toEqual(["notes/standup.md"]);
      expect((await ctx.notes.search(id, { query: "laptop order" })).total).toBe(0);
      await ctx.files.remove(id, "docs/onboarding.md");
      expect((await ctx.notes.search(id, { query: "onboarding guide" })).total).toBe(0);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("answers backlinks, outgoing links and unlinked mentions", async () => {
    const { ctx, project } = await boot();
    const id = project.id;
    try {
      await ctx.files.write(id, "Roadmap.md", "# Roadmap\n\nShip [[specs/API]] then [[Pricing|prices]]. ![[diagram.png]]");
      await ctx.files.write(id, "specs/API.md", "# API\n\nBack to the [[Roadmap#Q4]].");
      await ctx.files.write(id, "meetings/kickoff.md", "We agreed on the roadmap in principle.\nSee [details](../specs/API.md).");
      await ctx.files.write(id, "diagram.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const roadmap = await ctx.notes.links(id, "Roadmap.md");
      expect(roadmap.outgoing.map((l) => [l.target, l.path])).toEqual([
        ["specs/API", "specs/API.md"],
        ["Pricing", null],
        ["diagram.png", "diagram.png"]
      ]);
      expect(roadmap.backlinks).toEqual([{ path: "specs/API.md", title: "API", line: 3, text: "Back to the [[Roadmap#Q4]]." }]);
      expect(roadmap.unlinked.map((m) => [m.path, m.line])).toEqual([["meetings/kickoff.md", 1]]);

      const api = await ctx.notes.links(id, "specs/API.md");
      expect(api.backlinks.map((b) => b.path).sort()).toEqual(["Roadmap.md", "meetings/kickoff.md"]);
      expect((await ctx.notes.links(id, "diagram.png")).backlinks.map((b) => b.path)).toEqual(["Roadmap.md"]);

      // a note made later answers a link that was dangling
      await ctx.files.write(id, "Pricing.md", "# Pricing");
      expect((await ctx.notes.links(id, "Pricing.md")).backlinks.map((b) => b.path)).toEqual(["Roadmap.md"]);
      expect(await ctx.notes.resolve(id, "Pricing", "specs/API.md")).toBe("Pricing.md");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("keeps links meaning the same file when a note or a folder moves, as one undoable version", async () => {
    const { ctx, project } = await boot();
    const id = project.id;
    try {
      await ctx.files.write(id, "Plan.md", "# Plan\n\nSee [[Ideas]], [[Ideas#Later|later]] and [old](Ideas.md).");
      await ctx.files.write(id, "Ideas.md", "# Ideas\n\nBack to [[Plan]] and [sibling](Plan.md).");
      await ctx.files.write(id, "other/Ideas.md", "# Other ideas");
      await ctx.notes.ready(id);

      await ctx.files.move(id, "Ideas.md", "Backlog ideas.md");
      const plan = (await ctx.files.read(id, "Plan.md"))!.body;
      expect(plan).toBe("# Plan\n\nSee [[Backlog ideas]], [[Backlog ideas#Later|later]] and [old](Backlog%20ideas.md).");
      expect((await ctx.files.history(id, "Plan.md"))[0]!.message).toBe("Updated 3 links to Backlog ideas");

      // a moved note's own relative links are re-aimed only where they would now miss
      await ctx.files.write(id, "docs/a.md", "[b](b.md), [plan](Plan.md)");
      await ctx.files.write(id, "docs/b.md", "# B");
      await ctx.files.move(id, "docs/a.md", "a.md");
      expect((await ctx.files.read(id, "a.md"))!.body).toBe("[b](docs/b.md), [plan](Plan.md)");

      // a whole folder: everything inside it is followed; a path suffix that still matches is left alone
      await ctx.files.write(id, "Ideas.md", "Links into [[docs/b]] and [[b]].");
      await ctx.files.move(id, "docs", "archive/docs");
      expect((await ctx.files.read(id, "a.md"))!.body).toBe("[b](archive/docs/b.md), [plan](Plan.md)");
      expect((await ctx.files.read(id, "Ideas.md"))!.body).toBe("Links into [[docs/b]] and [[b]].");
      await ctx.files.move(id, "archive/docs", "archive/papers");
      expect((await ctx.files.read(id, "Ideas.md"))!.body).toBe("Links into [[b]] and [[b]].");

      // one ⌘Z puts every rewritten link of that move back
      const timeline = await ctx.oplog.timeline(id, 10);
      expect(timeline[0]!.label).toBe("Ideas.md, a.md");
      await ctx.oplog.undo(id);
      expect((await ctx.files.read(id, "a.md"))!.body).toBe("[b](archive/docs/b.md), [plan](Plan.md)");
      expect((await ctx.files.read(id, "Ideas.md"))!.body).toBe("Links into [[docs/b]] and [[b]].");

      // a link written a moment before the move is followed too, and a name with brackets reads back
      await ctx.files.write(id, "fresh.md", "Just wrote [[Ideas]] and [it](Ideas.md).");
      await ctx.files.move(id, "Ideas.md", "Ideas (mine).md");
      expect((await ctx.files.read(id, "fresh.md"))!.body).toBe("Just wrote [[Ideas (mine)]] and [it](Ideas%20%28mine%29.md).");
      expect((await ctx.notes.links(id, "Ideas (mine).md")).backlinks.map((b) => b.path)).toEqual(["fresh.md"]);

      // switched off, a move leaves the text alone
      ctx.settings.set({ ...ctx.settings.get(), notes: { updateLinks: false, journalFolder: "Journal" } });
      await ctx.files.move(id, "Plan.md", "Master plan.md");
      expect((await ctx.files.read(id, "Backlog ideas.md"))!.body).toContain("[[Plan]]");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("starts the day's journal once", async () => {
    const { ctx, project } = await boot();
    const id = project.id;
    try {
      const p = await ctx.notes.journal(id, "2026-10-10");
      expect(p).toBe("Journal/2026-10-10.md");
      expect((await ctx.files.read(id, p))!.body).toBe("# 2026-10-10\n\n");
      await ctx.files.write(id, p, "# 2026-10-10\n\nWrote things.");
      expect(await ctx.notes.journal(id, "2026-10-10")).toBe(p);
      expect((await ctx.files.read(id, p))!.body).toContain("Wrote things.");
      await expect(ctx.notes.journal(id, "tomorrow")).rejects.toThrow("Not a date");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("gives agents a ranked search and the links around a note, keeping unlisted notes out unless asked by folder", async () => {
    const { ctx, project } = await boot();
    const id = project.id;
    try {
      await ctx.files.write(id, "plan.md", "# Launch plan\n\nLaunch after [[checklist]]. #launch");
      await ctx.files.write(id, "checklist.md", "# Checklist\n\nEverything before launch.");
      await ctx.files.write(id, "private/salaries.md", "# Salaries\n\nlaunch bonus figures");
      await ctx.files.setAgentRules(id, ["private"], "unlisted");

      const found = await call(ctx, "search_notes", { query: "launch" }, id);
      expect(found).toContain("plan.md — Launch plan · #launch");
      expect(found).toContain("checklist.md — Checklist");
      expect(found).not.toContain("salaries");
      expect(await call(ctx, "search_notes", { query: "launch", folder: "private" }, id)).toContain("private/salaries.md");

      await ctx.files.write(id, "private/notes.md", "The [[checklist]] is too long.");
      const links = await call(ctx, "note_links", { path: "checklist.md" }, id);
      expect(links).toContain("linked from (1):\n  plan.md:3: Launch after [[checklist]]. #launch");
      expect(links).not.toContain("private/");
      expect((await ctx.notes.links(id, "checklist.md")).backlinks.map((b) => b.path).sort()).toEqual(["plan.md", "private/notes.md"]);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe("guarded saves in ctx.files", { timeout: 60_000 }, () => {
  it("refuses to land over bytes the writer never read, and saves several files as one version", async () => {
    const { ctx, project } = await boot();
    const id = project.id;
    try {
      const first = await ctx.files.write(id, "a.md", "one");
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
      const saved = await ctx.files.save(id, "a.md", "two", { expect: first.hash });
      expect(saved.ok).toBe(true);
      // somebody else saved in between: the stale editor gets what is there now
      await ctx.files.write(id, "a.md", "three");
      const stale = await ctx.files.save(id, "a.md", "mine", { expect: saved.ok ? saved.content.hash : "" });
      expect(stale).toMatchObject({ ok: false, current: { body: "three" } });
      expect((await ctx.files.read(id, "a.md"))!.body).toBe("three");
      // null means the name must be free
      expect((await ctx.files.save(id, "a.md", "new", { expect: null })).ok).toBe(false);
      expect((await ctx.files.save(id, "b.md", "new", { expect: null })).ok).toBe(true);

      const versions = (await ctx.files.history(id, "a.md")).length;
      const current = (await ctx.files.read(id, "a.md"))!;
      await expect(ctx.files.writeMany(id, [{ path: "a.md", body: "x", expect: current.hash }, { path: "b.md", body: "y", expect: "stale" }])).rejects.toThrow("changed since it was read");
      expect((await ctx.files.read(id, "a.md"))!.body).toBe("three");
      const ref = await ctx.files.writeMany(id, [{ path: "a.md", body: "x" }, { path: "c/d.md", body: "y" }], { message: "Both" });
      expect(ref).toMatch(/^files:/);
      expect((await ctx.files.history(id, "a.md")).length).toBe(versions + 1);
      expect((await ctx.files.history(id, "c/d.md"))[0]!.message).toBe("Both");
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
