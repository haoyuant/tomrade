import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { FakeChatModel, fakeChat } from "@tomradex/llm";
import { Agent, composeSkill, DRAFT_SYSTEM, keptVersions, renameSkill } from "@tomradex/agent";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pb-draft-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

const drafted = { name: "Workshop Prep", title: "Prepare a workshop", description: "Use when an offline workshop needs preparing.", body: "1. List attendees.\n2. Book the room.\n\nChecks\n- Room confirmed" };

async function boot() {
  const playbooksDir = path.join(root, `user-${n++}`);
  const base = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, `settings-${n++}.json`) }], fakeChat(new FakeChatModel([{ text: "ok" }]), (system) => {
    if (system === DRAFT_SYSTEM) return drafted;
    throw new Error("not this call");
  }), [Agent, { playbooksDir }]] });
  await settle();
  const { items, project, board } = base;
  const accepted = (title: string) => {
    let item = items.create({ projectId: project.id, boardId: board.id, title, body: "Get the workshop ready", workType: "general", status: "doing", by: "human" });
    item = items.submitDelivery(project.id, item.id, { report: "Booked room B, sent invites, printed name tags." }, "ai:test");
    return items.reviewDelivery(project.id, item.id, { submissionId: item.evidence.submissions[0].id, decision: "accepted", comment: "" }, item.version);
  };
  return { ...base, playbooksDir, accepted };
}

describe("composeSkill / renameSkill", () => {
  it("writes frontmatter the loader reads, and renames by the name field", () => {
    const { id, text } = composeSkill(drafted, "general");
    expect(id).toBe("workshop-prep");
    expect(text).toMatch(/^---\nname: workshop-prep\n/);
    expect(text).toContain("workTypes:\n  - general");
    expect(renameSkill(text, "acme.workshop")).toMatch(/name: acme\.workshop/);
  });
});

describe("saving how a ticket was done", () => {
  it("drafts from an accepted ticket and writes only what the person saves, with where it came from", async () => {
    const { ctx, project, playbooksDir, accepted } = await boot();
    const item = accepted("Prepare the offline workshop");
    const draft = await ctx.agent.draftPlaybook(project.id, item.key);
    expect(draft).toMatchObject({ key: item.key, id: "workshop-prep" });
    expect(fs.existsSync(path.join(playbooksDir, "workshop-prep"))).toBe(false);
    const saved = ctx.agent.savePlaybookDraft({ projectId: project.id, itemId: item.id, text: draft.text, scope: "user" });
    expect(saved).toMatchObject({ id: "workshop-prep", version: 1 });
    const entry = ctx.agent.playbookIndex().find((e) => e.id === "workshop-prep");
    expect(entry).toMatchObject({ source: "user", workTypes: ["general"], origin: { from: { ticket: item.key }, version: 1 } });
    const again = ctx.agent.savePlaybookDraft({ projectId: project.id, itemId: item.id, text: draft.text.replace("Book the room", "Book room B"), scope: "user" });
    expect(again).toMatchObject({ version: 2, replaced: true });
    expect(keptVersions(path.join(playbooksDir, "workshop-prep"))).toEqual([1]);
  });

  it("saves under a chosen id as a new version of it", async () => {
    const { ctx, project, playbooksDir, accepted } = await boot();
    const item = accepted("Prepare the offline workshop");
    const draft = await ctx.agent.draftPlaybook(project.id, item.id);
    ctx.agent.savePlaybookDraft({ projectId: project.id, itemId: item.id, text: draft.text, scope: "user", id: "events.prep" });
    expect(fs.readFileSync(path.join(playbooksDir, "events.prep", "SKILL.md"), "utf8")).toMatch(/name: events\.prep/);
    expect(ctx.agent.playbookIndex().some((e) => e.id === "events.prep")).toBe(true);
  });

  it("refuses a ticket that is not done, or one nothing can be learned from", async () => {
    const { ctx, items, project, board } = await boot();
    const open = items.create({ projectId: project.id, boardId: board.id, title: "Still going", workType: "general", by: "human" });
    await expect(ctx.agent.draftPlaybook(project.id, open.id)).rejects.toThrow(/not done/);
    const bare = items.create({ projectId: project.id, boardId: board.id, title: "Done by hand", workType: "general", status: "done", by: "human" });
    await expect(ctx.agent.draftPlaybook(project.id, bare.id)).rejects.toThrow(/nothing|no agent conversation/);
  });

  it("the tool asks the person first, and writes nothing on cancel", async () => {
    const { ctx, project, playbooksDir, accepted } = await boot();
    const item = accepted("Prepare the offline workshop");
    const asked: string[] = [];
    const cancelled = (await ctx.tools.execute("save_playbook_from_ticket", { ticket: item.key, scope: "user" }, { by: "ai:test", projectId: project.id, ask: async (text: string, options: string[]) => (asked.push(text), options[1]) } as never)) as { saved: boolean };
    expect(cancelled.saved).toBe(false);
    expect(asked[0]).toContain("workshop-prep");
    expect(fs.existsSync(path.join(playbooksDir, "workshop-prep"))).toBe(false);
    const unasked = (await ctx.tools.execute("save_playbook_from_ticket", { ticket: item.key, scope: "user" }, { by: "ai:test", projectId: project.id })) as { saved: boolean; draft?: string };
    expect(unasked).toMatchObject({ saved: false });
    expect(unasked.draft).toContain("name: workshop-prep");
    const given = (await ctx.tools.execute("save_playbook_from_ticket", { ticket: item.key, scope: "user", text: unasked.draft }, { by: "ai:test", projectId: project.id })) as { saved: boolean; version: number };
    expect(given).toMatchObject({ saved: true, version: 1 });
  });
});
