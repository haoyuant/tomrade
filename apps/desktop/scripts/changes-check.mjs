/**
 * A ticket's changes on the real plugin tree and a real repository: the ticket says how much its branch changes, the
 * diff opens from it with the files and their lines, switches to side by side and to one commit, shows the working
 * tree, and offers each file to an editor. Then the review: a comment on a line is kept and stays on its line, goes to
 * the clipboard with no session to take it and to a background session's conversation with one, and what came since the
 * review is all the diff then shows. Then one turn of an outside session as a scope of its own, with a picture drawn
 * beside its absence, a migration flagged, a reviewing agent's finding under its line and the delivery's report above
 * the diff. Then an agent's review asked for from the diff: a read-only conversation of its own that is told the ticket,
 * its finding under its line, and both said to be of older code once the branch moves. A general ticket and one with no
 * branch say nothing.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:changes
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

// The Terminal window's own sheet, bundled apart from the page it is put on: it brings its bridge, which the check answers.
const ui = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
const { build } = createRequire(ui.resolve("vite"))("esbuild");
const sheetBundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {IconSprite} from './src/components/icons';
      import {SessionChanges, showChanges} from './src/code-sessions/changes';
      window.notices = [];
      createRoot(document.body.appendChild(document.createElement('div'))).render(
        React.createElement(QueryClientProvider, {client: new QueryClient()}, React.createElement(IconSprite), React.createElement(SessionChanges, {locale: 'zh', onNotice: (text) => window.notices.push(text)})));
      window.showChanges = showChanges;`,
    resolveDir: fileURLToPath(new URL("../../../packages/ui/", import.meta.url)), loader: "tsx"
  },
  bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' }
});

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-changes-")));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(work, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (args, cwd) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const commit = (root, message) => {
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", message], root);
  return git(["rev-parse", "HEAD"], root);
};

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    // No agent of this machine's: a repository connected here must not start one reading it.
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-claude-code", "engine-codex", "engine-pi"].map((id) => ({ id, disabled: true })), { id: "engine-scripted", disabled: false }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.settings.set({ ...ctx.settings.get(), language: "zh", onboarding: { seen: ["*"] } });
  // No host to ask and no editor to start: the check reads git only.
  ctx.codeLink.pulls = async () => null;
  ctx.codeLink.findEditor = () => null;

  // ── a bare remote, a checkout of it, and a ticket's branch with two commits ──
  const remote = path.join(work, "remote", "app.git");
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  const checkout = path.join(work, "checkout");
  fs.mkdirSync(checkout);
  git(["init", "-q", "-b", "main"], checkout);
  git(["remote", "add", "origin", remote], checkout);
  git(["config", "user.email", "dev@localhost"], checkout);
  git(["config", "user.name", "Dev"], checkout);
  write(checkout, "README.md", "# app\n\none\ntwo\nthree\n");
  write(checkout, "src/greet.ts", "export const greet = (name: string) => `hello ${name}`;\n");
  commit(checkout, "initial");
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);

  const board = ctx.boards.list(project.id)[0];
  const repo = ctx.repos.create({ projectId: project.id, remote });
  ctx.boards.update(project.id, board.id, { repoId: repo.id });
  await ctx.repos.setCheckout(remote, checkout);
  const ticket = (title, workType) => ctx.items.create({ projectId: project.id, boardId: board.id, title, status: "todo", workType, by: "human" });
  const item = ticket("Greet by name", "coding");
  const plain = ticket("No branch yet", "coding");
  const general = ticket("Write the guide", "general");

  const branch = `al-${item.keyNum}/greet`;
  git(["checkout", "-q", "-b", branch, "main"], checkout);
  write(checkout, "README.md", "# app\n\none\nTWO\nthree\n");
  const first = commit(checkout, `${item.key}: reword the readme`);
  write(checkout, "src/greet.ts", "export const greet = (name: string) => `hello, ${name}!`;\nexport const bye = (name: string) => `bye ${name}`;\n");
  write(checkout, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  commit(checkout, `${item.key}: greet warmly`);
  git(["push", "-q", "origin", branch], checkout);
  await ctx.codeLink.scan(project.id);
  check("the scan links the branch to its ticket", ctx.codeLink.links(project.id, item.id).some((l) => l.branch === branch), ctx.codeLink.links(project.id, item.id));

  const win = new BrowserWindow({ width: 1500, height: 940, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.setBackgroundThrottling(false);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const until = async (js, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await $(js).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  };
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  const show = async (id) => {
    await $(`location.hash = '#/p/${project.id}/i/${id}'; true`);
    await sleep(900);
  };
  await win.loadURL(`${base}#/p/${project.id}/i/${item.id}`);

  // ── the ticket says how much, and opens the diff ─────────────────────
  const entry = `document.querySelector('[data-testid="ticket-changes"]')`;
  check("the ticket has a Changes entry", await until(`!!${entry}`));
  const said = await $(`${entry}?.textContent ?? ''`);
  check("it counts the branch's files and lines", said.includes("3 个文件") && said.includes("+4") && said.includes("−2"), said);
  await $(`document.querySelector('[data-testid="ticket-changes-open"]').click(); true`);
  const sheet = `document.querySelector('[data-testid="changes-sheet"]')`;
  check("View changes opens the diff", await until(`!!${sheet}?.querySelector('[data-testid="diff-view"]')`));
  check("the sheet is named for the ticket", (await $(`document.querySelector('[role="dialog"] .dlg-title')?.textContent ?? ''`)) === `改动 · ${item.key}`, await $(`document.querySelector('[role="dialog"] .dlg-title')?.textContent`));
  const listed = () => $(`[...${sheet}.querySelectorAll('.diff__item')].map((n) => n.getAttribute('title'))`);
  check("the file list names every changed file", (await listed()).sort().join() === "README.md,pnpm-lock.yaml,src/greet.ts", await listed());
  const rows = (kind) => $(`[...${sheet}.querySelectorAll('.diff__code--${kind}')].map((n) => n.textContent)`);
  check("an added line is drawn", await until(`[...${sheet}.querySelectorAll('.diff__code--add')].some((n) => n.textContent.includes('bye'))`), await rows("add"));
  check("a deleted line is drawn", (await rows("del")).some((line) => line.includes("two")), await rows("del"));
  check("the lockfile starts folded", await $(`!${sheet}.querySelector('[data-path="pnpm-lock.yaml"]')?.hasAttribute('data-open') && ${sheet}.querySelector('[data-path="pnpm-lock.yaml"]')?.textContent.includes('生成的文件')`));
  check("it opens unified", (await $(`${sheet}.querySelector('[data-testid="diff-view"]').dataset.layout`)) === "unified");

  // ── side by side ─────────────────────────────────────────────────────
  await $(`[...${sheet}.querySelectorAll('.seg button')].find((b) => b.textContent.trim() === '左右对比').click(); true`);
  check("it switches to side by side", await until(`${sheet}.querySelector('[data-testid="diff-view"]').dataset.layout === 'split' && !!${sheet}.querySelector('.diff__row--split')`));
  await $(`[...${sheet}.querySelectorAll('.seg button')].find((b) => b.textContent.trim() === '上下对比').click(); true`);
  check("and back to unified", await until(`${sheet}.querySelector('[data-testid="diff-view"]').dataset.layout === 'unified'`));

  // ── scopes: one commit, then the working tree ────────────────────────
  const scope = `${sheet}.querySelector('[data-testid="changes-scope"]')`;
  const options = await $(`[...${scope}.querySelectorAll('option')].map((o) => [o.value, o.textContent])`);
  check("the scopes are the branch, the working tree and its two commits", options.map((o) => o[0]).join() === ["branch", "uncommitted"].concat(options.slice(2).map((o) => o[0])).join() && options.length === 4 && options[0][1] === "分支对比基准" && options[1][1] === "未提交的改动", options);
  check("no link picker for one code link", !(await $(`!!${sheet}.querySelector('[data-testid="changes-link"]')`)));
  const pick = (value) =>
    $(`(() => { const s = ${scope}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await pick(`commit:${first}`);
  check("one commit shows only its file", await until(`[...${sheet}.querySelectorAll('.diff__item')].map((n) => n.getAttribute('title')).join() === 'README.md'`), await listed());
  check("the picker stays on that commit", (await $(`${scope}.value`)) === `commit:${first}`);

  write(checkout, "notes/todo.md", "- [ ] ship\n");
  write(checkout, "README.md", "# app\n\none\nTWO\nthree\nfour\n");
  await pick("uncommitted");
  check("the working tree shows an edited file and a new one", await until(`[...${sheet}.querySelectorAll('.diff__item')].map((n) => n.getAttribute('title')).sort().join() === 'README.md,notes/todo.md'`), await listed());
  check("each file offers an editor", (await $(`${sheet}.querySelectorAll('[data-testid="changes-open"]').length`)) === 2);
  const opened = await $(`window.tomrade.invoke("codeLink.openInEditor", ${JSON.stringify(project.id)}, ${JSON.stringify(item.id)}, { path: "notes/todo.md" })`);
  check("with no editor's command, the file's path comes back for the system to open", opened?.editor === null && opened.file === path.join(checkout, "notes", "todo.md"), opened);
  check("a path outside the folder is refused", (await $(`window.tomrade.invoke("codeLink.openInEditor", ${JSON.stringify(project.id)}, ${JSON.stringify(item.id)}, { path: "../../etc/hosts" })`)) === null);

  // ── it follows the working tree while open ───────────────────────────
  write(checkout, "notes/later.md", "- [ ] rest\n");
  // The check's window is never shown, so the page counts itself hidden: say it is seen, as coming back to it does.
  await $(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); window.dispatchEvent(new Event('visibilitychange')); true`);
  check("looked at again, it reads the working tree again", await until(`[...${sheet}.querySelectorAll('.diff__item')].some((n) => n.getAttribute('title') === 'notes/later.md')`), await listed());
  if (process.env.TOMRADE_SHOT) fs.writeFileSync(process.env.TOMRADE_SHOT, (await win.webContents.capturePage()).toPNG());

  // ── the review: a comment on a line, passed on, and what came since ──
  // The check's window is never shown and has no clipboard to write to: what would be copied is kept on the page.
  await $(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copied = text; } } }); true`);
  const kept = () => ctx.changeReview.comments(project.id, item.id);
  const names = (list) => `[...${sheet}.querySelectorAll('.diff__item')].map((n) => n.getAttribute('title')).sort().join() === ${JSON.stringify(list)}`;
  const notes = `[...${sheet}.querySelectorAll('[data-testid="diff-comment"]')]`;
  const sendButton = `${sheet}.querySelector('[data-testid="changes-send-comments"]')`;
  const comment = async (file, word, text) => {
    // A file's lines are drawn once it is on screen.
    await $(`${sheet}.querySelector('[data-path=${JSON.stringify(file)}]')?.scrollIntoView(); true`);
    await until(`!!${sheet}.querySelector('[data-path=${JSON.stringify(file)}] .diff__row .diff__add')`);
    const picked = await $(`(() => {
      const row = [...${sheet}.querySelectorAll('[data-path=${JSON.stringify(file)}] .diff__row')].find((r) => r.querySelector('.diff__code--add')?.textContent.includes(${JSON.stringify(word)}));
      row?.querySelector('.diff__add')?.click();
      return !!row?.querySelector('.diff__add');
    })()`);
    const box = `${sheet}.querySelector('[data-testid="diff-composer"] textarea')`;
    if (!picked || !(await until(`!!${box}`))) return false;
    await $(`(() => { const box = ${box}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)}); box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await $(`${sheet}.querySelector('[data-testid="diff-comment-save"]').click(); true`);
    return until(`${notes}.some((n) => n.textContent.includes(${JSON.stringify(text)}))`);
  };
  await pick("branch");
  await until(names("README.md,pnpm-lock.yaml,src/greet.ts"));
  check("with no comment yet there is nothing to send", await until(`${sendButton}?.disabled === true && ${sendButton}.textContent.trim() === '发送评论'`), await $(`${sendButton}?.textContent`));
  check("a line takes a comment, shown under it", await comment("src/greet.ts", "bye", "say goodbye properly"));
  check("the comment is kept with its line and what the line said", kept().length === 1 && kept()[0].path === "src/greet.ts" && kept()[0].side === "new" && kept()[0].line === 2 && kept()[0].quote.includes("bye") && kept()[0].sentAt === null, kept());
  check("the ticket says a comment is open", await until(`document.querySelector('[data-testid="ticket-changes-comments"]')?.textContent === '1 条未解决的评论'`), await $(`document.querySelector('[data-testid="ticket-changes-comments"]')?.textContent`));
  check("with no session to take it, the comment is offered to copy", await until(`${sendButton}?.disabled === false && ${sendButton}.textContent.trim() === '复制 1 条评论'`), await $(`${sendButton}?.textContent`));
  await $(`${sendButton}.click(); true`);
  check("copied, it is the agent's prompt with the line and the words", await until(`(window.copied ?? '').includes('<review-comments') && window.copied.includes('src/greet.ts') && window.copied.includes('say goodbye properly')`), await $(`window.copied`));
  check("and the comment counts as sent", await until(`${notes}.some((n) => n.textContent.includes('已发送'))`) && kept()[0].sentAt !== null, kept());
  check("passing comments on records a review", await until(`!!${scope}.querySelector('option[value="since"]')?.textContent.startsWith('自上次审阅以来')`), await $(`[...${scope}.querySelectorAll('option')].map((o) => o.textContent)`));

  // What was in the working tree at the review is not shown again; what the agent does next is.
  write(checkout, "notes/after.md", "- [x] reviewed\n");
  write(checkout, "src/greet.ts", "// greetings\nexport const greet = (name: string) => `hello, ${name}!`;\nexport const bye = (name: string) => `bye ${name}`;\n");
  await pick("since");
  check("since the review, only what changed after it", await until(names("notes/after.md,src/greet.ts")), await listed());
  check("the comment moved with its line", await until(`${notes}.some((n) => n.textContent.includes('say goodbye properly') && n.textContent.includes('第 3 行') && !n.textContent.includes('已过时'))`), await $(`${notes}.map((n) => n.textContent)`));

  // A background session of the ticket: its conversation takes the next comments.
  const link = ctx.codeLink.links(project.id, item.id).find((l) => l.branch === branch);
  const thread = ctx.agent.newThread(project.id, "scripted", null, { itemId: item.id });
  ctx.codeLink.store.createSession(project.id, { repoId: repo.id, delivery: link.delivery, branch, itemIds: [item.id], mode: "headless", agent: "scripted", threadId: thread.id, device: ctx.hub.deviceId });
  ctx.ipc.send("codeLink.changed", project.id);
  await pick("branch");
  await until(names("README.md,pnpm-lock.yaml,src/greet.ts"));
  const reviewedAt = () => ctx.codeLink.store.reviewed(project.id, link.id)?.at ?? 0;
  const before = reviewedAt();
  check("a second comment", await comment("README.md", "TWO", "why the capitals?"));
  check("with a session, the comments are offered to its agent", await until(`${sendButton}?.disabled === false && ${sendButton}.textContent.trim().startsWith('发送 1 条评论给')`), await $(`${sendButton}?.textContent`));
  if (process.env.TOMRADE_SHOT) fs.writeFileSync(process.env.TOMRADE_SHOT.replace(/\.png$/, "-review.png"), (await win.webContents.capturePage()).toPNG());
  await $(`${sendButton}.click(); true`);
  const heard = () => ctx.agent.thread(project.id, thread.id).messages.filter((m) => m.block.type === "text" && m.block.text.includes("<review-comments")).map((m) => m.block.text);
  for (let i = 0; i < 50 && !heard().length; i++) await sleep(100);
  check("the conversation receives the new comment, and not the one already passed on", heard().length === 1 && heard()[0].includes("why the capitals?") && heard()[0].includes("README.md") && !heard()[0].includes("say goodbye properly"), heard());
  check("nothing is left to send", await until(`${sendButton}?.disabled === true`) && kept().every((c) => c.sentAt !== null), kept());

  // The review is recorded once the comments have gone: what is written after it is what came since.
  for (let i = 0; i < 50 && reviewedAt() === before; i++) await sleep(100);
  write(checkout, "notes/more.md", "- [ ] more\n");
  await pick("since");
  check("sending records a review too: only what came after shows", await until(names("notes/more.md")), await listed());
  await $(`${sheet}.querySelector('[data-testid="changes-mark-reviewed"]').click(); true`);
  check("Mark as reviewed leaves nothing since", await until(`${sheet}.querySelector('.diff__blank')?.textContent === '没有改动。'`), await listed());
  await pick("branch");
  await until(names("README.md,pnpm-lock.yaml,src/greet.ts"));

  // ── the Terminal window: the same sheet on its page, read over its bridge ──
  const preload = path.join(work, "surface-preload.cjs");
  fs.writeFileSync(preload, "window.sent = []; window.tomradeSurface = { onMessage: (fn) => { window.hear = fn; return () => {}; }, onState: () => () => {}, onLook: () => () => {}, send: (m) => window.sent.push(m) };");
  const term = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const t$ = (js) => term.webContents.executeJavaScript(js, true);
  term.webContents.on("console-message", (event) => { if (event.level === "error") console.log(`  terminal page: ${event.message}`); });
  await term.loadURL(`${base}code-sessions.html`);
  await t$(sheetBundle.outputFiles[0].text + "\nvoid 0;");
  // What the plugin does with the window's asks, done here: the page has no plugin behind it.
  const asked = [];
  const answer = async (m) => {
    if (m.type === "changes") return { type: "changesRead", token: m.token, view: await ctx.codeLink.changes(project.id, m.itemId, m.opts) };
    if (m.type === "changeFile") return { type: "changeFileRead", token: m.token, file: await ctx.codeLink.changeFile(project.id, m.itemId, m.opts) };
    if (m.type === "openChanged") return { type: "changedOpened", token: m.token, where: (await ctx.codeLink.openInEditor(project.id, m.itemId, { linkId: m.linkId, path: m.path })) ? "system" : null };
    if (m.type === "changeReview") {
      const { ask } = m;
      const review = ctx.changeReview;
      const value =
        ask.op === "comments" ? review.comments(project.id, m.itemId)
        : ask.op === "add" ? review.add(project.id, m.itemId, ask.draft)
        : ask.op === "edit" ? review.edit(project.id, ask.id, ask.edit)
        : ask.op === "remove" ? review.remove(project.id, ask.id)
        : ask.op === "target" ? review.target(project.id, m.itemId)
        : ask.op === "send" ? await review.send(project.id, m.itemId, { deliver: ask.deliver })
        : ask.op === "reviewers" ? await review.reviewers(project.id, m.itemId)
        : ask.op === "reviews" ? review.reviews(project.id, m.itemId)
        : ask.op === "review" ? await review.review(project.id, m.itemId, { engine: ask.engine })
        : ask.op === "release" ? (review.release(project.id, m.itemId), null)
        : await ctx.codeLink.markReviewed(project.id, m.itemId, { linkId: ask.linkId });
      return { type: "changeReviewDone", token: m.token, value };
    }
    return null;
  };
  const relay = setInterval(async () => {
    for (const m of await t$("window.sent.splice(0)").catch(() => [])) {
      asked.push(m.type);
      const post = await answer(m);
      if (post) await t$(`window.hear(${JSON.stringify(post)}); true`);
    }
  }, 100);
  const tUntil = async (js, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await t$(js).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  };
  await t$(`window.showChanges(${JSON.stringify(item.id)}, ${JSON.stringify(item.key)}); true`);
  check("the Terminal window's page opens the sheet, in its language", await tUntil(`document.querySelector('[role="dialog"] .dlg-title')?.textContent === ${JSON.stringify(`改动 · ${item.key}`)}`), await t$(`document.querySelector('[role="dialog"] .dlg-title')?.textContent`));
  check("it reads the branch over the bridge", await tUntil(`[...${sheet}.querySelectorAll('.diff__item')].map((n) => n.getAttribute('title')).sort().join() === 'README.md,pnpm-lock.yaml,src/greet.ts'`), asked);
  check("its words are the window's", (await t$(`${scope}.querySelector('option')?.textContent`)) === "分支对比基准" && (await t$(`${sheet}.textContent.includes('忽略空白改动')`)));
  const box = await t$(`(() => { const r = document.querySelector('.palette.modal.sheet-changes').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.top), Math.round(r.left)]; })()`);
  check("the sheet fills that window as it does the app's", box[0] > 1200 && box[1] > 500 && box[2] >= 0 && box[3] >= 0, box);
  check("it shows the ticket's comments, read over the bridge", await tUntil(`${notes}.length === 2 && ${sheet}.querySelector('[data-testid="diff-comments-toggle"]')?.textContent.includes('评论（2）')`), await t$(`${notes}.map((n) => n.textContent)`));
  check("and where they would go", await tUntil(`${sendButton}?.disabled === true && ${sendButton}.textContent.trim() === '发送评论'`), await t$(`${sendButton}?.textContent`));
  await t$(`${sheet}.querySelector('[data-testid="diff-comment-resolve"]').click(); true`);
  for (let i = 0; i < 50 && !kept().some((c) => c.state === "resolved"); i++) await sleep(100);
  check("a comment resolved there is resolved", kept().filter((c) => c.state === "resolved").length === 1 && asked.includes("changeReview"), kept());
  check("and folds to a line there", await tUntil(`${notes}.some((n) => n.classList.contains('is-resolved'))`));
  await t$(`${sheet}.querySelector('[data-path="pnpm-lock.yaml"] .diff__file-head').click(); true`);
  await tUntil(`!!${sheet}.querySelector('[data-path="pnpm-lock.yaml"] .diff__more button')`);
  await t$(`${sheet}.querySelector('[data-path="pnpm-lock.yaml"] .diff__more button')?.click(); true`);
  check("a folded file's lines are read on their own", await tUntil(`[...${sheet}.querySelectorAll('[data-path="pnpm-lock.yaml"] .diff__code--add')].some((n) => n.textContent.includes('lockfileVersion'))`), asked);
  await t$(`${sheet}.querySelector('[data-testid="changes-open"]').click(); true`);
  check("opening a file says where it went", await tUntil(`window.notices.includes('已用系统默认应用打开。把 Cursor 或 VS Code 的命令加入 PATH 后，会在其中打开。')`), await t$("window.notices"));
  if (process.env.TOMRADE_SHOT) fs.writeFileSync(process.env.TOMRADE_SHOT.replace(/\.png$/, "-terminal.png"), (await term.webContents.capturePage()).toPNG());
  clearInterval(relay);
  term.destroy();

  // ── one turn of an outside session: its own scope, a picture, a finding, the report ──
  const outside = ctx.codeLink.store.createSession(project.id, { repoId: repo.id, delivery: link.delivery, branch, itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId });
  const hook = (name) => ctx.codeLink.sessions.hook(project.id, outside.id, { hook_event_name: name, cwd: checkout }, false);
  // The conversation above ran here too; only this session's turns are looked at.
  const turns = async () => (await ctx.codeLink.changes(project.id, item.id)).runs.filter((r) => r.source === "claude-code");
  await hook("UserPromptSubmit");
  write(checkout, "db/migrations/1_init.sql", "create table greeting (name text);\n");
  write(checkout, "logo.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  await hook("Stop");
  const [turn] = await turns();
  const option = (id) => `${scope}.querySelector('option[value="run:${id}"]')`;
  check("the turn is offered as a scope, named for its agent", !!turn && (await until(`${option(turn?.id)}?.textContent.startsWith('claude-code · ') && ${option(turn?.id)}.parentElement.label.startsWith('本机上的 Agent 运行（')`)), await $(`[...${scope}.querySelectorAll('option')].map((o) => o.textContent)`));
  await pick(`run:${turn.id}`);
  check("it shows what the turn changed, and nothing written before it", await until(names("db/migrations/1_init.sql,logo.png")), await listed());
  check("the migration is flagged by its path", (await $(`${sheet}.querySelector('[data-path="db/migrations/1_init.sql"] [data-testid="diff-risk"]')?.textContent`)) === "迁移" && !(await $(`!!${sheet}.querySelector('[data-path="logo.png"] [data-testid="diff-risk"]')`)));
  const picture = `${sheet}.querySelector('[data-path="logo.png"]')`;
  await $(`${picture}?.scrollIntoView(); true`);
  if (!(await $(`${picture}.hasAttribute('data-open')`))) await $(`${picture}.querySelector('.diff__file-head').click(); true`);
  await until(`!!${picture}.querySelector('.diff__more button')`);
  check("a picture is offered to be shown", (await $(`${picture}.querySelector('.diff__more button')?.textContent`)) === "显示图片", await $(`${picture}.textContent`));
  await $(`${picture}.querySelector('.diff__more button')?.click(); true`);
  check(
    "a new picture is drawn beside its absence",
    await until(`(() => { const box = ${picture}.querySelector('[data-testid="diff-images"]'); const img = box?.querySelector('img'); return box?.querySelectorAll('img').length === 1 && img.src.startsWith('data:image/png;base64,') && img.naturalWidth === 1 && box.textContent.includes('此版本中没有'); })()`),
    await $(`${picture}.textContent`)
  );
  const found = await ctx.tools.execute(
    "submit_review_findings",
    { key: item.key, findings: [{ linkId: link.id, path: "db/migrations/1_init.sql", side: "new", line: 1, endLine: 1, quote: "create table greeting (name text);", body: "No primary key.", severity: "error" }] },
    { by: "ai:reviewer", projectId: project.id }
  );
  await $(`${sheet}.querySelector('[data-path="db/migrations/1_init.sql"]')?.scrollIntoView(); true`);
  check("an agent's finding sits under its line, named as one", await until(`${notes}.some((n) => n.textContent.includes('No primary key.') && n.querySelector('[data-testid="diff-finding"]')?.textContent === 'Agent 发现 · 错误')`), await $(`${notes}.map((n) => n.textContent)`));
  check("and waits for the person to send it", found[0]?.sentAt === null && (await until(`/^(发送|复制) 1 条评论/.test(${sendButton}?.textContent.trim() ?? '')`)), await $(`${sendButton}?.textContent`));
  ctx.items.submitDelivery(project.id, item.id, { report: "Greets by name, warmly." }, "ai:scripted");
  ctx.ipc.send("codeLink.changed", project.id);
  check("the delivery's report is above the diff", await until(`${sheet}.querySelector('[data-testid="changes-report"]')?.textContent.includes('Greets by name, warmly.')`), await $(`${sheet}.textContent.slice(0, 200)`));
  if (process.env.TOMRADE_SHOT) fs.writeFileSync(process.env.TOMRADE_SHOT.replace(/\.png$/, "-run.png"), (await win.webContents.capturePage()).toPNG());
  // A turn that has not stopped has no diff yet, and says so.
  await hook("UserPromptSubmit");
  const [open] = await turns();
  check("a turn still running is listed without a diff", open.id !== turn.id && (await until(`${option(open.id)}?.textContent.endsWith('没有留下改动记录')`)), await $(`[...${scope}.querySelectorAll('option')].map((o) => o.textContent)`));
  await pick(`run:${open.id}`);
  check("and choosing it says why, instead of showing other changes", await until(`${sheet}.querySelector('.diff__blank')?.textContent.startsWith('Tomrade 没有这次运行开始和结束时的完整文件')`), await listed());
  await hook("Stop");
  await pick("branch");
  await until(names("README.md,pnpm-lock.yaml,src/greet.ts"));

  // ── an agent's review, asked for from the diff ───────────────────────
  const reviewBar = `${sheet}.querySelector('[data-testid="changes-review"]')`;
  const reviewStart = `${sheet}.querySelector('[data-testid="changes-review-start"]')`;
  check("with no agent here that can review, the diff says so and offers none", await until(`${reviewStart}?.disabled === true && ${reviewStart}.title === '这台电脑上没有能审查的编码 Agent。' && ${reviewStart}.textContent.trim() === '让另一个 Agent 审查'`), await $(`${reviewBar}?.textContent`));
  const reviewTold = [];
  ctx.agent.engine({
    id: "checker", title: "Checker", author: "ai:checker", capabilities: ["backlog", "code"],
    permissionModes: { default: "workspace", choices: [{ value: "read-only", label: "Read only" }, { value: "workspace", label: "Workspace" }] },
    available: async () => ({ ok: true }),
    async turn(input, io) {
      reviewTold.push({ text: input.input.text, mode: input.permissionMode, ticket: input.ticket?.key ?? null, cwd: input.cwd ?? null });
      ctx.changeReview.submitFindings(project.id, item.id, [{ linkId: link.id, path: "src/greet.ts", side: "new", line: 2, endLine: 2, quote: "export const bye = (name: string) => `bye ${name}`;", body: "Nothing tests bye.", severity: "warning" }], { by: "ai:checker", run: { id: io.run.id, threadId: input.threadId } });
      return { stop: "end" };
    }
  });
  ctx.ipc.send("codeLink.changed", project.id);
  check("an agent that can is offered to review", await until(`${reviewStart}?.disabled === false`), await $(`${reviewBar}?.textContent`));
  await $(`${reviewStart}.click(); true`);
  const reviewStatus = `${sheet}.querySelector('[data-testid="changes-review-status"]')`;
  check("the review ends with what it found", await until(`${reviewStatus}?.dataset.state === 'done' && ${reviewStatus}.textContent.startsWith('Checker 留下 1 条意见 · ')`, 150), await $(`${reviewBar}?.textContent`));
  const [made] = ctx.changeReview.reviews(project.id, item.id);
  check(
    "it ran in a conversation of its own, read-only, told the ticket and how to read the change",
    reviewTold.length === 1 && reviewTold[0].mode === "read-only" && reviewTold[0].ticket === null && reviewTold[0].text.includes(`Ticket ${item.key}: Greet by name`) && reviewTold[0].text.includes("read_review_changes") &&
      made?.state === "done" && made.findings === 1 && ctx.agent.store.thread(project.id, made.threadId)?.itemId === null,
    { reviewTold, made }
  );
  check("in a folder that is not the ticket's checkout", !!reviewTold[0]?.cwd && reviewTold[0].cwd !== checkout, reviewTold[0]?.cwd);
  check("its finding sits under its line and waits to be sent", await until(`${notes}.some((n) => n.textContent.includes('Nothing tests bye.') && !!n.querySelector('[data-testid="diff-finding"]') && !n.querySelector('[data-testid="diff-finding-stale"]'))`) && ctx.changeReview.comments(project.id, item.id).find((c) => c.body === "Nothing tests bye.")?.sentAt === null, await $(`${notes}.map((n) => n.textContent)`));
  check("another review can be asked for", (await $(`${reviewStart}.textContent.trim()`)) === "再审一次" && !(await $(`!!${sheet}.querySelector('[data-testid="changes-review-stale"]')`)));
  if (process.env.TOMRADE_SHOT) fs.writeFileSync(process.env.TOMRADE_SHOT.replace(/\.png$/, "-review.png"), (await win.webContents.capturePage()).toPNG());
  // The branch moves on: what the review found is of older code.
  write(checkout, "README.md", "# app\n\none\nTWO\nthree\nfour\n");
  commit(checkout, `${item.key}: one more line`);
  await ctx.codeLink.scan(project.id);
  ctx.ipc.send("codeLink.changed", project.id);
  check("once the branch moves, the review is said to be of older code", await until(`${sheet}.querySelector('[data-testid="changes-review-stale"]')?.textContent === '针对旧改动'`, 150), await $(`${reviewBar}?.textContent`));
  check("and so is its finding, where a person's comment is not", await until(`${notes}.filter((n) => !!n.querySelector('[data-testid="diff-finding-stale"]')).length === 1 && ${notes}.some((n) => n.textContent.includes('Nothing tests bye.') && !!n.querySelector('[data-testid="diff-finding-stale"]'))`), await $(`${notes}.map((n) => n.textContent)`));

  // ── tickets with nothing to show ─────────────────────────────────────
  await $(`document.querySelector('[role="dialog"] .dlg-head .btn-icon').click(); true`);
  check("the sheet closes", await until(`!${sheet}`));
  await show(plain.id);
  check("a coding ticket with no branch has no entry", !(await $(`!!${entry}`)));
  await show(general.id);
  check("a general ticket has no entry", !(await $(`!!${entry}`)));
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
