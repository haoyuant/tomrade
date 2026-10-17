/**
 * A first run opens on the sample project: the tour as tickets on a learning
 * path, a small backlog to practise on, written in the person's language. Its
 * seed is how it began — nothing in History, nothing to undo — and it is this
 * machine's own, never in the account's catalog.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { ARTIFACT_DIR, Storage, readHubManifest, readLogs } from "@tomradex/storage";
import { Contributions } from "@tomradex/contributions";
import { Inbox } from "@tomradex/inbox";
import { Onboarding, PATH, SAMPLE } from "@tomradex/onboarding";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-onboarding-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const tmp = (name: string) => fs.mkdtempSync(path.join(root, `${name}-`));

const QUIET = { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0, autoRestore: false };

describe("the sample project", () => {
  it("is what a first run opens on, written in the person's language", async () => {
    const { ctx, project, items, boards, views, hub } = await fresh({ firstRun: "none", plugins: [[Onboarding, { locale: "zh-CN" }]] });
    const words = SAMPLE.zh;
    expect(ctx.projects.list()).toHaveLength(1);
    expect(project).toMatchObject({ name: words.name, sample: true });
    expect(hub.catalog.project(project.id)).toMatchObject({ seed: true, sample: true });

    const [tour, example] = boards.list(project.id);
    expect([tour.name, example.name]).toEqual([words.tour, words.example]);
    expect(views.listForProject(project.id).map((v) => v.name)).toEqual(["看板", "最近更新", words.path]);
    const path_ = views.listForProject(project.id).find((v) => v.name === words.path)!;
    expect(path_).toMatchObject({ layout: "graph", query: { graph: "deps", filter: [{ field: "board", op: "in", values: [tour.id] }] } });

    const tickets = items.list({ projectId: project.id, boardId: tour.id });
    expect(tickets.map((i) => i.title)).toEqual(words.tickets.map((t) => t.title));
    expect(tickets.every((i) => i.status === "todo" && i.workType === "general")).toBe(true);
    expect(items.list({ projectId: project.id, boardId: example.id }).map((i) => i.title)).toEqual(words.examples.map((t) => t.title));

    const byKey = new Map(words.tickets.map((t) => [t.key, tickets.find((x) => x.title === t.title)!]));
    for (const [from, to] of PATH) expect(byKey.get(from)!.blocks).toContain(byKey.get(to)!.id);
  });

  it("lays every tour ticket on one learning path from the first, the same in both languages", () => {
    for (const words of [SAMPLE.en, SAMPLE.zh]) {
      const keys = words.tickets.map((t) => t.key);
      expect(PATH.flat().every((k) => keys.includes(k))).toBe(true);
      const reached = new Set([keys[0]]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [from, to] of PATH) if (reached.has(from) && !reached.has(to)) { reached.add(to); grew = true; }
      }
      expect([...reached].sort()).toEqual([...keys].sort());
    }
    expect(SAMPLE.zh.tickets.map((t) => t.key)).toEqual(SAMPLE.en.tickets.map((t) => t.key));
    expect(SAMPLE.zh.feedback.map((f) => [f.key, f.kind])).toEqual(SAMPLE.en.feedback.map((f) => [f.key, f.kind]));
  });

  it("leaves the tour's feedback in the inbox to triage, from the tour as its source, once", async () => {
    const { ctx, project, items, boards } = await fresh({ firstRun: "none", plugins: [[Onboarding, { locale: "zh" }], Contributions, [Inbox, { pullMs: 3_600_000 }]] });
    await settle();
    const waiting = ctx.inbox.list(project.id);
    expect(waiting.map((e) => [e.title, e.kind, e.source])).toEqual(
      expect.arrayContaining(SAMPLE.zh.feedback.map((f) => [f.title, f.kind, SAMPLE.zh.name]))
    );
    expect(waiting).toHaveLength(SAMPLE.zh.feedback.length);

    // The exercise's merge target is there.
    const example = boards.list(project.id)[1];
    expect(items.list({ projectId: project.id, boardId: example.id }).map((i) => i.title)).toContain("设置页");

    // A sample made while the inbox is already running gets its own, and nothing is added twice.
    ctx.projects.remove(project.id);
    const again = ctx.onboarding.createSample("en");
    expect(ctx.inbox.list(again.id).map((e) => e.title).sort()).toEqual(SAMPLE.en.feedback.map((f) => f.title).sort());
  });

  it("leaves nothing in History: the seed is how it began, not something to undo", async () => {
    const { ctx, project, db } = await fresh({ firstRun: "none", plugins: [Onboarding] });
    expect(project.name).toBe(SAMPLE.en.name);
    expect(db.prepare("SELECT COUNT(*) AS n FROM oplog").get()).toEqual({ n: 0 });
    expect(await ctx.oplog.undo(project.id)).toBeNull();
  });

  it("can be run again, as often as wanted: hints unseen, the sample kept or made anew", async () => {
    const { ctx, project, items, hub } = await fresh({ firstRun: "none", hubDir: tmp("restart"), plugins: [[Settings, { path: path.join(tmp("restart-settings"), "settings.json") }], Onboarding] });
    await settle();
    ctx.settings.set({ ...ctx.settings.get(), onboarding: { seen: ["setup-screen", "hint.revert"] } });
    const first = items.list({ projectId: project.id })[0];
    items.update(project.id, first.id, { status: "done" }, "human");
    const dir = hub.catalog.project(project.id)!.dir;

    expect(ctx.onboarding.restart({ resetSample: false }).id).toBe(project.id);
    expect(ctx.settings.get().onboarding).toEqual({ seen: [] });
    expect(items.get(project.id, first.id)?.status).toBe("done");

    const again = ctx.onboarding.restart({ resetSample: true, locale: "zh" });
    expect(again.id).not.toBe(project.id);
    expect(ctx.projects.list().map((p) => p.id)).toEqual([again.id]);
    expect(again.name).toBe(SAMPLE.zh.name);
    expect(items.list({ projectId: again.id }).every((i) => i.status === "todo" || i.status === "backlog")).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);

    ctx.projects.remove(again.id, { deleteFolder: true });
    expect(ctx.onboarding.restart({ resetSample: false }).sample).toBe(true);
  });

  it("seeds nothing when the machine already has a project", async () => {
    const { ctx, project } = await fresh({ plugins: [Onboarding] });
    expect(ctx.projects.list().map((p) => p.name)).toEqual(["Default Project"]);
    expect(project.sample).toBeUndefined();
  });

  it("can be made again after it was deleted", async () => {
    const { ctx, project } = await fresh({ firstRun: "none", plugins: [Onboarding] });
    ctx.projects.remove(project.id);
    const again = ctx.onboarding.createSample("zh");
    expect(ctx.projects.list()).toEqual([expect.objectContaining({ id: again.id, name: SAMPLE.zh.name, sample: true })]);
  });

  it("gets its folder with the seed in the snapshot and none of it in the log, and stays out of the account's catalog", async () => {
    const hubDir = tmp("hub");
    const { ctx, project, hub, items, board } = await fresh({ hubDir, firstRun: "none", plugins: [[Storage, QUIET], Onboarding] });
    await settle();
    await ctx.storage.ready;
    const dir = hub.catalog.project(project.id)!.dir!;
    expect(fs.existsSync(path.join(dir, ARTIFACT_DIR))).toBe(true);
    expect(readLogs(dir).flatMap((l) => l.lines)).toEqual([]);

    // Used, it is still only this machine's.
    items.create({ projectId: project.id, boardId: board.id, title: "Mine now", by: "human" });
    expect(readLogs(dir).flatMap((l) => l.lines)).toHaveLength(1);
    await ctx.storage.writeHub();
    expect(readHubManifest(hubDir)?.projects ?? []).toEqual([]);
    // Nor does a Hub folder kept in git: its folder is ignored there.
    expect(fs.readFileSync(path.join(hubDir, ".gitignore"), "utf8").split("\n")).toContain(`${path.relative(hubDir, dir)}/`);
  });

  it("registers the seen-hints as the person's settings, and the playbook that explains the app", async () => {
    const { ctx } = await fresh({
      firstRun: "none",
      plugins: [Tools, [Settings, { path: path.join(tmp("settings"), `${crypto.randomUUID()}.json`) }], Agent, Onboarding]
    });
    expect(ctx.settings.sections().find((s) => s.id === "onboarding")).toMatchObject({ scope: "user" });
    expect(ctx.settings.get().onboarding).toEqual({ seen: [] });
    expect(ctx.agent.playbookIndex().map((p) => p.id)).toContain("app.guide");
  });
});
