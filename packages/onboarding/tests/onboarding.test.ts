/**
 * A first run opens on the sample project: the tour as tickets on a learning
 * path, a small backlog to practise on, written in the person's language. Its
 * seed is how it began — nothing in History, nothing to undo — and it is this
 * machine's own, never in the account's catalog.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import type { Context } from "cordis";
import { Agent, type Engine } from "@tomradex/agent";
import { CodeLink, sessionContext } from "@tomradex/code-link";
import GitHubAccount from "@tomradex/github";
import { ARTIFACT_DIR, Storage, readHubManifest, readLogs } from "@tomradex/storage";
import { Contributions } from "@tomradex/contributions";
import { Inbox } from "@tomradex/inbox";
import { Repos } from "@tomradex/repos";
import { Onboarding, PATH, SAMPLE, SAMPLE_REPO, START, sampleWords, type SampleWords } from "@tomradex/onboarding";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-onboarding-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const tmp = (name: string) => fs.mkdtempSync(path.join(root, `${name}-`));

const QUIET = { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0, autoRestore: false };
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("the sample project", () => {
  it("is what a first run opens on, written in the person's language", async () => {
    const { ctx, project, items, boards, views, hub } = await fresh({ firstRun: "none", plugins: [[Onboarding, { locale: "zh-CN" }]] });
    const words = SAMPLE.zh;
    expect(ctx.projects.list()).toHaveLength(1);
    expect(project).toMatchObject({ name: words.name, sample: true });
    expect(hub.catalog.project(project.id)).toMatchObject({ seed: true, sample: true });

    const [tour, more, example] = boards.list(project.id);
    expect([tour.name, more.name, example.name]).toEqual([words.tour, words.more, words.example]);
    expect(views.listForProject(project.id).map((v) => v.name)).toEqual(["看板", "最近更新", "按状态", "按需求组", "按优先级", "按工作流", words.path]);
    const path_ = views.listForProject(project.id).find((v) => v.name === words.path)!;
    expect(path_).toMatchObject({ layout: "graph", query: { graph: "deps", filter: [{ field: "board", op: "in", values: [tour.id, more.id] }] } });

    // The core loop leads, in its own workstream; every other lesson is under More.
    const titleOf = (key: string) => words.tickets.find((t) => t.key === key)!.title;
    expect(items.list({ projectId: project.id, boardId: tour.id }).map((i) => i.title)).toEqual(START.map(titleOf));
    expect(items.list({ projectId: project.id, boardId: more.id }).map((i) => i.title)).toEqual(words.tickets.filter((t) => !START.includes(t.key)).map((t) => t.title));
    const tickets = items.list({ projectId: project.id }).filter((i) => i.boardId !== example.id);
    expect(tickets.every((i) => i.status === "todo" && i.workType === "general")).toBe(true);
    const examples = items.list({ projectId: project.id, boardId: example.id });
    expect(examples.map((i) => i.title)).toEqual(words.examples.map((t) => t.title));
    expect(examples.filter((i) => i.workType === "coding").map((i) => i.title)).toEqual(["计时器：加一个重置按钮"]);

    const byKey = new Map(words.tickets.map((t) => [t.key, tickets.find((x) => x.title === t.title)!]));
    for (const [from, to] of PATH) expect(byKey.get(from)!.blocks).toContain(byKey.get(to)!.id);
  });

  it("opens on the core loop — ideas to tickets, Start, merge, undo — and keeps the board lesson for when no AI is connected", () => {
    expect(START).toEqual(["b4", "c1", "c3", "b3"]);
    for (const words of [SAMPLE.en, SAMPLE.zh]) {
      expect(words.tickets.slice(0, START.length).map((t) => t.key)).toEqual(START);
      // The first of More is the board lesson, which says to connect an AI before Start.
      const board = words.tickets[START.length];
      expect(board.key).toBe("a1");
      expect(board.body).toContain(words === SAMPLE.en ? "No model or agent connected yet" : "还没接上模型或智能体");
      // Every lesson says where to click now.
      for (const t of words.tickets) expect(t.body).toMatch(words === SAMPLE.en ? /\*\*Now:\*\* / : /\*\*现在\*\*：/);
    }
  });

  it("starts its learning path from the first lesson and blocks a lesson only on what it needs, the same in both languages", () => {
    for (const words of [SAMPLE.en, SAMPLE.zh]) {
      const keys = words.tickets.map((t) => t.key);
      expect(PATH.flat().every((k) => keys.includes(k))).toBe(true);
      const waiting = new Set(PATH.map(([, to]) => to));
      // The sample opens on the one lesson that starts the path.
      expect([...new Set(PATH.map(([from]) => from))].filter((k) => !waiting.has(k))).toEqual([keys[0]]);
      const reached = new Set([keys[0]]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [from, to] of PATH) if (reached.has(from) && !reached.has(to)) { reached.add(to); grew = true; }
      }
      expect([...waiting].every((k) => reached.has(k))).toBe(true);
      // Lessons that need nothing open at once: a fresh tour is not a wall of "Blocked".
      expect(waiting.size).toBeLessThanOrEqual(keys.length / 2);
    }
    expect(SAMPLE.zh.tickets.map((t) => t.key)).toEqual(SAMPLE.en.tickets.map((t) => t.key));
    expect(SAMPLE.zh.feedback.map((f) => [f.key, f.kind])).toEqual(SAMPLE.en.feedback.map((f) => [f.key, f.kind]));
    expect(SAMPLE.zh.examples.map((e) => [e.key, !!e.coding])).toEqual(SAMPLE.en.examples.map((e) => [e.key, !!e.coding]));
  });

  it("brings a git repository of its own for the Pomodoro example, with no remote, that the example workstream stands for", async () => {
    const { ctx, project, hub, boards, db } = await fresh({ firstRun: "none", hubDir: tmp("repo"), plugins: [[Storage, QUIET], Repos, [Onboarding, { locale: "en" }]] });
    await settle();
    await ctx.storage.ready;
    await ctx.onboarding.repoReady(project.id);

    const example = boards.list(project.id)[2];
    const [repo] = ctx.repos.list(project.id);
    expect(example.repoId).toBe(repo.id);
    const dir = path.join(hub.catalog.project(project.id)!.dir!, SAMPLE_REPO.folder);
    expect(repo).toMatchObject({ name: SAMPLE_REPO.folder, defaultBranch: "main", remote: dir });
    expect(ctx.repos.checkout(repo.remote)).toMatchObject({ checkout: dir });
    expect(ctx.repos.checkout(repo.remote).problem).toBeUndefined();

    // One commit on main holding the timer, a clean tree, and nowhere to push.
    expect(git(["rev-parse", "--show-toplevel"], dir)).toBe(fs.realpathSync(dir));
    expect(git(["branch", "--show-current"], dir)).toBe("main");
    expect(git(["log", "--format=%s"], dir)).toBe(SAMPLE_REPO.message);
    expect(git(["ls-files"], dir).split("\n").sort()).toEqual(Object.keys(SAMPLE_REPO.files).sort());
    expect(git(["status", "--porcelain"], dir)).toBe("");
    expect(git(["remote"], dir)).toBe("");
    // The example's own tests pass as it ships.
    expect(() => execFileSync(process.execPath, ["--test"], { cwd: dir, stdio: "pipe" })).not.toThrow();

    // Linking it is how the sample began, not something to undo.
    expect(db.prepare("SELECT COUNT(*) AS n FROM oplog").get()).toEqual({ n: 0 });
  });

  it("takes a Pomodoro code ticket from Start to Done on this machine: the agent's branch merged here, no GitHub", async () => {
    const hubDir = tmp("loop");
    // A code agent that adds Reset in the worktree it is given and commits it under the ticket's key.
    const engine: Engine = {
      id: "fake-code",
      title: "Fake coding agent",
      author: "ai:fake-code",
      capabilities: ["backlog", "code", "general"],
      available: async () => ({ ok: true }),
      async turn(input, io) {
        if (input.cwd && input.purpose === "code") {
          fs.appendFileSync(path.join(input.cwd, "timer.js"), "\nexport const RESET = true;\n");
          git(["add", "-A"], input.cwd);
          git(["-c", "user.email=agent@localhost", "-c", "user.name=Agent", "commit", "-q", "-m", `${input.ticket!.key}: add a Reset button`], input.cwd);
        }
        io.emit({ type: "text", text: "done" });
        return { stop: "end", resume: "fake-session" };
      }
    };
    const { ctx, project, items, boards } = await fresh({
      firstRun: "none",
      hubDir,
      plugins: [
        Tools,
        [Settings, { path: path.join(hubDir, "settings.json") }],
        GitHubAccount,
        [Storage, QUIET],
        Repos,
        Contributions,
        Agent,
        { name: "fake-code-engine", inject: ["agent"], apply: (c: Context) => void c.agent.engine(engine) },
        [CodeLink, { scanMs: 0, defaultsPath: path.join(hubDir, "code-link.json") }],
        [Onboarding, { locale: "en" }]
      ]
    });
    await settle();
    await ctx.storage.ready;
    await ctx.onboarding.repoReady(project.id);
    ctx.agent.store.setBrief(project.id, "The Tomrade tour.");
    ctx.codeLink.pulls = async () => null;

    const example = boards.list(project.id)[2];
    const ticket = items.list({ projectId: project.id, boardId: example.id }).find((i) => i.workType === "coding")!;
    const started = await ctx.codeLink.start(project.id, ticket.id, { mode: "run", engine: "fake-code" });
    if (!started.ok) throw new Error(started.message);
    for (const t0 = Date.now(); ctx.agent.activeRuns().length; ) {
      if (Date.now() - t0 > 8000) throw new Error("the run did not settle");
      await new Promise((r) => setTimeout(r, 15));
    }
    await ctx.codeLink.scan(project.id);
    await sessionContext.run({ projectId: project.id, sessionId: started.sessionId }, () =>
      ctx.tools.execute("link_code", { scopeChecked: true }, { by: "ai:fake-code", projectId: project.id })
    );
    expect(items.get(project.id, ticket.id)!.status).toBe("verifying");

    expect(await ctx.codeLink.merge(project.id, ticket.id)).toMatchObject({ merged: true });
    const dir = ctx.repos.list(project.id)[0].remote;
    expect(git(["log", "--format=%s", "main"], dir)).toContain(`${ticket.key}: add a Reset button`);
    expect(fs.readFileSync(path.join(dir, "timer.js"), "utf8")).toContain("RESET");
    expect(items.get(project.id, ticket.id)!.status).toBe("done");
  }, 30_000);

  it("makes its repository again when it is made again, and this machine forgets the old one's folder", async () => {
    const { ctx, project, hub } = await fresh({ firstRun: "none", hubDir: tmp("repo-again"), plugins: [[Storage, QUIET], Repos, Onboarding] });
    await settle();
    await ctx.storage.ready;
    await ctx.onboarding.repoReady(project.id);
    const old = ctx.repos.list(project.id)[0].remote;
    expect(fs.existsSync(path.join(old, ".git"))).toBe(true);

    const again = ctx.onboarding.restart({ resetSample: true, locale: "zh" });
    await ctx.onboarding.repoReady(again.id);
    expect(fs.existsSync(old)).toBe(false);
    expect(ctx.repos.checkout(old).checkout).toBeNull();
    const [repo] = ctx.repos.list(again.id);
    expect(repo.remote).toBe(path.join(hub.catalog.project(again.id)!.dir!, SAMPLE_REPO.folder));
    expect(ctx.repos.checkout(repo.remote).checkout).toBe(repo.remote);
    expect(git(["log", "--format=%s"], repo.remote)).toBe(SAMPLE_REPO.message);

    // Deleted from the home and made again from its tile: a fresh one too.
    ctx.projects.remove(again.id, { deleteFolder: true });
    const tiled = ctx.onboarding.sampleAgain("en");
    await ctx.onboarding.repoReady(tiled.id);
    expect(git(["status", "--porcelain"], ctx.repos.list(tiled.id)[0].remote)).toBe("");
  });

  it("names each shortcut the way the person's platform writes it, from the default keys", () => {
    const text = (words: SampleWords) => words.tickets.map((t) => `${t.title}\n${t.body}`).join("\n");
    for (const platform of ["win32", "linux"] as const) {
      for (const locale of ["en", "zh"] as const) {
        const words = sampleWords(locale, platform);
        const search = words.tickets.find((t) => t.key === "a5")!;
        expect(search.title).toContain("Ctrl+K");
        expect(search.body).toContain("Ctrl+K");
        expect(text(words)).toContain("Ctrl+Shift+F");
        expect(text(words)).toContain("Ctrl+Z");
        expect(text(words)).not.toMatch(/[⌘⇧⌥⌃]/);
      }
    }
    for (const locale of ["en", "zh"] as const) {
      const words = sampleWords(locale, "darwin");
      expect(words.tickets.find((t) => t.key === "a5")!.title).toContain("⌘K");
      expect(text(words)).toContain("⇧⌘F");
      expect(text(words)).toContain("⌘Z");
    }
    expect(SAMPLE.en).toEqual(sampleWords("en", process.platform));
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
    const example = boards.list(project.id)[2];
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

  it("comes back from the home's tile once, opening on its first lesson again, with the other hints still seen", async () => {
    const { ctx, project } = await fresh({ firstRun: "none", plugins: [[Settings, { path: path.join(tmp("again-settings"), "settings.json") }], Onboarding] });
    await settle();
    ctx.settings.set({ ...ctx.settings.get(), onboarding: { seen: ["setup-screen", "sample-first-lesson", "hint.revert"] } });
    expect(ctx.onboarding.sampleAgain("zh").id).toBe(project.id);
    expect(ctx.settings.get().onboarding).toEqual({ seen: ["setup-screen", "sample-first-lesson", "hint.revert"] });

    ctx.projects.remove(project.id);
    const again = ctx.onboarding.sampleAgain("zh");
    expect(again).toEqual(expect.objectContaining({ name: SAMPLE.zh.name, sample: true }));
    expect(ctx.onboarding.sampleAgain("zh").id).toBe(again.id);
    expect(ctx.projects.list().map((p) => p.id)).toEqual([again.id]);
    expect(ctx.settings.get().onboarding).toEqual({ seen: ["setup-screen", "hint.revert"] });
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
