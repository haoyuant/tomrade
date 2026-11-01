/**
 * PR feedback on the real plugin tree, with GitHub played by a stand-in reader: the row loads, its card opens from
 * Settings and its switch turns it on, a person's comment reaches the ticket's conversation through the real Agent, a
 * stranger's does not, and a terminal session's feedback lands on the attention list with nothing typed into it.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:pr-feedback
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pr-feedback-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const pulls = new Map();
const github = (number) => {
  const pull = { pull: { state: "open", head: { sha: `sha${number}` }, user: { login: "ann" }, updated_at: "t0" }, comments: [] };
  pulls.set(number, pull);
  return pull;
};
const reader = {
  async read(route, pick) {
    const pull = pulls.get(Number(/\/(?:pulls|issues)\/(\d+)/.exec(route)?.[1]));
    if (route.includes("/check-runs")) return pick({ check_runs: [] });
    if (route.includes("/status")) return pick({ statuses: [] });
    if (route.includes("/issues/")) return pick(pull.comments);
    if (route.includes("/reviews") || route.includes("/comments")) return pick([]);
    return pick(pull.pull);
  }
};
const say = (pull, id, login, association) => {
  pull.comments = [...pull.comments, { id, user: { login, type: "User" }, author_association: association, created_at: new Date(Date.now() + 1_000).toISOString(), html_url: `https://github.com/o/r/pull/1#${id}`, body: `words ${id}` }];
  pull.pull = { ...pull.pull, updated_at: `t${id}` };
};

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, { id: "engine-scripted", disabled: false }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });

  check("the row loads and says what it provides", !!ctx.get("prFeedback"));
  check("off by default", ctx.settings.get().prFeedback?.enabled === false, ctx.settings.get().prFeedback);
  check("its card has words in Chinese", ctx.settings.sections("zh").find((s) => s.id === "prFeedback")?.title === "PR 反馈");
  ctx.prFeedback.reader = reader;

  const boardId = ctx.boards.list(project.id)[0].id;
  const repo = ctx.repos.create({ projectId: project.id, remote: "https://github.com/o/r" });
  const ticket = (title, number) => {
    const item = ctx.items.create({ projectId: project.id, boardId, title, status: "verifying", workType: "coding", by: "human" });
    ctx.codeLink.store.ensureActiveDelivery(project.id, item.id);
    const link = ctx.codeLink.store.upsertLink(project.id, { itemId: item.id, repoId: repo.id, branch: `al/${number}` }, { prNumber: number, prUrl: `https://github.com/o/r/pull/${number}`, prState: "open", source: "mcp" });
    return { item, link };
  };
  const conversation = ticket("In a conversation", 1);
  const terminal = ticket("In a terminal", 2);
  const merged = ticket("Already merged", 3);
  ctx.codeLink.store.patchLink(project.id, merged.link.id, { prState: "merged", mergedSha: "abc" });
  const thread = ctx.agent.newThread(project.id, "scripted", null, { itemId: conversation.item.id });
  const session = (t, mode, threadId) =>
    ctx.codeLink.store.createSession(project.id, { repoId: repo.id, delivery: t.link.delivery, branch: t.link.branch, itemIds: [t.item.id], mode, agent: "scripted", threadId, device: ctx.hub.deviceId });
  session(conversation, "headless", thread.id);
  const inTerminal = session(terminal, "terminal", null);
  session(merged, "headless", null);
  check("only pull requests not known to have ended are followed", ctx.codeLink.store.openPulls(project.id).map((l) => l.prNumber).sort().join() === "1,2", ctx.codeLink.store.openPulls(project.id));
  const one = github(1);
  const two = github(2);

  // ── the person turns it on, where they would ─────────────────────────
  const win = new BrowserWindow({ width: 1280, height: 860, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  await sleep(2500);
  ctx.settings.show("prFeedback");
  await sleep(1000);
  const dialog = `document.querySelector('[role="dialog"]')`;
  const shown = await $(`${dialog}?.textContent ?? ''`);
  check("Settings opens on its card", shown.includes("Wake agents on pull request feedback") && shown.includes("Wakes per ticket"), shown.slice(0, 300));
  await $(`(() => {
    const label = [...${dialog}.querySelectorAll('*')].filter((n) => n.children.length === 0 && n.textContent.trim() === 'Wake agents on pull request feedback').at(-1);
    for (let at = label; at; at = at.parentElement) {
      const control = at.querySelector('[role="switch"], input[type="checkbox"]');
      if (control) { control.click(); return true; }
    }
    return false;
  })()`);
  await sleep(600);
  check("its switch turns it on", ctx.settings.get().prFeedback?.enabled === true, ctx.settings.get().prFeedback);

  // ── a person, then a stranger ────────────────────────────────────────
  await ctx.prFeedback.look();
  const said = () => ctx.agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "text" && m.block.text.includes("<pr-activity>"));
  check("watching starts quietly", said().length === 0);
  say(one, 11, "mallory", "NONE");
  await ctx.prFeedback.look();
  check("a stranger wakes nobody", said().length === 0);
  say(one, 12, "bob", "COLLABORATOR");
  await ctx.prFeedback.look();
  await sleep(500);
  check("a person's comment reaches the conversation through the real Agent", said().length === 1 && said()[0].block.text.includes("words 12") && !said()[0].block.text.includes("words 11"), said());
  check("a run took it", ctx.agent.thread(project.id, thread.id).runs.length === 1, ctx.agent.thread(project.id, thread.id).runs);
  check("the ticket stays where it was", ctx.items.get(project.id, conversation.item.id).status === "verifying");

  // ── a terminal is told about, never typed into ───────────────────────
  say(two, 21, "bob", "OWNER");
  await ctx.prFeedback.look();
  await sleep(600);
  const entries = await $(`window.tomrade.invoke("attention.list")`);
  const entry = entries.find((e) => e.key.startsWith("pr:") && e.itemId === terminal.item.id);
  check("a terminal session's feedback is on the attention list", entry?.kind === "waiting" && entry.sessionId === inTerminal.id && entry.text.includes("#2"), entries);

  // ── back off ─────────────────────────────────────────────────────────
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, prFeedback: { ...settings.prFeedback, enabled: false } });
  await sleep(600);
  check("turned off, what it told leaves the list", !(await $(`window.tomrade.invoke("attention.list")`)).some((e) => e.key.startsWith("pr:")));
};

app
  .whenReady()
  .then(run)
  .catch((error) => {
    results.push({ name: `threw: ${error?.stack ?? error}`, pass: false });
    console.log(`FAIL: ${error?.stack ?? error}`);
  })
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    fs.rmSync(work, { recursive: true, force: true });
    app.exit(failed.length ? 1 : 0);
  });
