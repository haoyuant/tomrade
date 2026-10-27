/**
 * Starting tickets from the conversation (TOM-598): the assistant starts several
 * tickets at once with its own engine, a conversation whose engine cannot code
 * gets a card to pick one on, and under the "ask" merge policy each delivery
 * comes back to the conversation as a merge card. Stand-in engines and a local
 * git repository keep it offline and deterministic.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:start-batch
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-start-batch-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const KEYS = /\b[A-Z]{2,}-\d+\b/g;

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Demo", keyPrefix: "DM" });
  await ctx.storage.ready;

  // A repository with no remote: the branch is the delivery, and Tomrade merges it here.
  const folder = path.join(work, "repo");
  fs.mkdirSync(folder);
  git(["init", "-q", "-b", "main"], folder);
  git(["config", "user.email", "dev@localhost"], folder);
  git(["config", "user.name", "Dev"], folder);
  fs.writeFileSync(path.join(folder, "package.json"), '{ "name": "demo" }\n');
  fs.writeFileSync(path.join(folder, "README.md"), "# demo\n");
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "initial"], folder);
  // With a brief already written, the import starts no orientation: its conversation would run a real local agent and take the panel.
  ctx.agent.setBrief(project.id, "Demo: a stand-in project for starting tickets from the conversation.");
  const { repo } = await ctx.repos.addFromFolder(project.id, folder);
  const board = ctx.boards.list(project.id)[0];
  ctx.boards.update(project.id, board.id, { repoId: repo.id });
  ctx.codeLink.setRepoPolicy(project.id, repo.id, { mergePolicy: "ask" });
  const ticket = (title) => ctx.items.create({ projectId: project.id, boardId: board.id, title, workType: "coding", status: "todo", by: "human" });
  const one = ticket("Add a greeting banner");
  const two = ticket("Rename the settings tab");
  const three = ticket("Log slow requests");

  const said = [];
  // The assistant that can code: in chat it starts or merges tickets; on a ticket it commits and hands over.
  ctx.agent.engine({
    id: "chatty",
    title: "Chatty (stand-in)",
    author: "ai:chatty",
    capabilities: ["backlog", "code", "general"],
    available: async () => ({ ok: true }),
    async turn(input, io) {
      if (input.cwd && input.purpose === "code") {
        await sleep(1500);
        if (input.input.kind === "text" && /no longer merges/.test(input.input.text)) {
          git(["merge", "-q", "-X", "ours", "main"], input.cwd);
          await io.tools.execute("link_code", { scopeChecked: true });
          io.emit({ type: "text", text: "Brought the branch up to date and handed it over again." });
          return { stop: "end" };
        }
        fs.writeFileSync(path.join(input.cwd, `${input.ticket?.key ?? "DM-0"}.ts`), "export {};\n");
        git(["add", "-A"], input.cwd);
        git(["commit", "-q", "-m", `${input.ticket?.key ?? "DM-0"}: work`], input.cwd);
        await io.tools.execute("link_code", { scopeChecked: true });
        io.emit({ type: "text", text: "Committed on the branch and handed it over." });
        return { stop: "end" };
      }
      const text = input.input.kind === "text" ? input.input.text : "";
      const keys = text.match(KEYS) ?? [];
      const result = /^merge/i.test(text)
        ? await io.tools.execute("merge_ticket", { key: keys[0] }).catch((err) => ({ error: err.message }))
        : await io.tools.execute("start_ticket", { keys }).catch((err) => ({ error: err.message }));
      said.push(result);
      io.emit({ type: "text", text: result.note ?? result.message ?? result.error ?? "done" });
      return { stop: "end" };
    }
  });
  // One that only chats: start_ticket has to ask the person to pick.
  ctx.agent.engine({
    id: "talker",
    title: "Talker (chat only)",
    author: "ai:talker",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const text = input.input.kind === "text" ? input.input.text : "";
      const result = await io.tools.execute("start_ticket", { keys: text.match(KEYS) ?? [] }).catch((err) => ({ error: err.message }));
      said.push(result);
      io.emit({ type: "text", text: result.note ?? result.error ?? "done" });
      return { stop: "end" };
    }
  });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", agent: { ...settings.agent, defaultEngine: "chatty" } });
  ctx.agent.newThread(project.id, "talker");

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const shot = async (name) => {
    if (!process.env.TOMRADE_SHOTS) return;
    fs.mkdirSync(process.env.TOMRADE_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS, name), (await win.webContents.capturePage()).toPNG());
  };
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const send = async (text) => {
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };
  const until = async (js, timeout = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const value = await $(js);
      if (value) return value;
      if (Date.now() - t0 > timeout) return value;
      await sleep(200);
    }
  };
  const batch = () =>
    $(`[...document.querySelectorAll('[data-testid="start-batch"]')].map((c) => ({ head: c.querySelector('.tool-head')?.textContent, tickets: [...c.querySelectorAll('[data-testid="start-batch-ticket"]')].map((li) => ({ state: li.dataset.state, text: li.textContent })) }))`);
  const merges = () => $(`[...document.querySelectorAll('[data-testid="merge-offer"]')].map((c) => ({ state: c.dataset.state, head: c.querySelector('.tool-head')?.textContent, body: c.textContent }))`);
  await sleep(2500);

  // ── a conversation whose engine cannot code: pick one on the card ─────
  await send(`please do ${three.key}`);
  await until(`!!document.querySelector('[data-testid="start-batch-go"]')`);
  let cards = await batch();
  check("a chat-only engine gets a card asking the person to pick the agent", cards.length === 1 && /pick the agent/.test(cards[0].head ?? "") && cards[0].tickets[0]?.state === "pending", cards);
  check("with the reason on it", await $(`/can't code right now/.test(document.querySelector('[data-testid="start-batch"]')?.textContent ?? '')`));
  check("and nothing started yet", ctx.codeLink.sessionsOf(project.id, three.id).length === 0);
  const options = await $(`[...(document.querySelector('[data-testid="start-batch"] select')?.options ?? [])].map((o) => o.value)`);
  check("the card lists the coding agents that are ready, the stand-in among them", options.includes("chatty"), options);
  await shot("01-pick.png");
  await $(`(() => { const s = document.querySelector('[data-testid="start-batch"] select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'chatty'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(200);
  await press(`document.querySelector('[data-testid="start-batch-go"]')`);
  await until(`document.querySelectorAll('[data-testid="start-batch-ticket"][data-state="started"]').length === 1`);
  cards = await batch();
  check("Start on the card starts the ticket with the picked agent and the card shows it", cards[0]?.tickets[0]?.state === "started" && /Chatty/.test(cards[0].tickets[0].text), cards);
  check("the pick is remembered as the Start defaults", ctx.codeLink.startDefaults()?.engine === "chatty", ctx.codeLink.startDefaults());
  await until(`document.querySelectorAll('[data-testid="merge-offer"][data-state="offered"]').length === 1`, 30_000);
  check("its delivery comes back to this conversation too", (await merges()).length === 1);
  await shot("02-pick-started.png");

  // ── the same conversation, now on the engine that can code ───────────
  const shown = ctx.agent.showing() ?? ctx.agent.store.threads(project.id)[0].id;
  ctx.agent.setEngine(project.id, shown, "chatty");
  await sleep(600);

  // ── two tickets at once, with the conversation's own engine ───────────
  await send(`do ${one.key} and ${two.key}`);
  await until(`document.querySelectorAll('[data-testid="start-batch-ticket"][data-state="started"]').length === 2`);
  cards = await batch();
  const both = cards.at(-1);
  check("the conversation shows one more card with both tickets started", cards.length === 2 && both?.tickets.length === 2 && both.tickets.every((t) => t.state === "started"), cards);
  check("and says which engine runs them, on which branch", both?.tickets.every((t) => /Chatty/.test(t.text) && /dm-\d+\//.test(t.text)), cards);
  const told = said.find((r) => r.started?.length === 2);
  check("the tool told the assistant what started", !!told && told.started.every((s) => s.engine === "chatty"), said);
  check("each started ticket offers to open its session", (await $(`(() => { const all = document.querySelectorAll('[data-testid="start-batch"]'); return all[all.length - 1]?.querySelectorAll('[data-testid="start-batch-open"]').length; })()`)) === 2);
  await shot("03-started.png");
  const sessions = ctx.codeLink.sessionsOf(project.id);
  check("each ticket runs in a headless session that remembers the conversation", sessions.length === 3 && sessions.every((s) => s.mode === "headless" && s.requestedBy), sessions.map((s) => ({ mode: s.mode, requestedBy: s.requestedBy })));

  // ── the sessions hand over; the "ask" policy brings each merge back here ──
  await until(`document.querySelectorAll('[data-testid="merge-offer"][data-state="offered"]').length === 3`, 30_000);
  let offered = await merges();
  check("once delivered, a merge card for each ticket is in the conversation", offered.length === 3 && offered.every((c) => c.state === "offered"), offered);
  check("the cards name the branch and the default branch", offered.every((c) => /→ main/.test(c.body)), offered);
  check("the tickets are Verifying, not done", [one, two].every((i) => ctx.items.get(project.id, i.id).status === "verifying"), [one, two].map((i) => ctx.items.get(project.id, i.id).status));
  await shot("04-merge-offered.png");

  // ── the button merges the first; "merge it" in chat merges the second ──
  const before = git(["rev-parse", "main"], folder);
  await press(`[...document.querySelectorAll('[data-testid="merge-offer"]')].find((c) => c.textContent.includes(${JSON.stringify(one.key)}))?.querySelector('[data-testid="merge-go"]')`);
  await until(`document.querySelectorAll('[data-testid="merge-offer"][data-state="merged"]').length === 1`);
  offered = await merges();
  check("the Merge button lands the branch and the card says so", offered.filter((c) => c.state === "merged").length === 1 && /Merged/.test(offered.find((c) => c.state === "merged")?.body ?? ""), offered);
  check("main moved and the first ticket is done", git(["rev-parse", "main"], folder) !== before && ctx.items.get(project.id, one.id).status === "done", ctx.items.get(project.id, one.id).status);
  await send(`merge ${two.key}`);
  await until(`document.querySelectorAll('[data-testid="merge-offer"][data-state="merged"]').length === 2`);
  check("saying \"merge\" in the conversation merges the other through merge_ticket", said.at(-1)?.merged === true && ctx.items.get(project.id, two.id).status === "done", said.at(-1));
  check("no second merge card: the one card was updated", (await $(`document.querySelectorAll('[data-testid="merge-offer"]').length`)) === 3);
  await shot("05-merged.png");

  // ── a merge that conflicts is handed back to the session, from the card ──
  const cardOf = (key) => `[...document.querySelectorAll('[data-testid="merge-offer"]')].find((c) => c.textContent.includes(${JSON.stringify(key)}))`;
  fs.writeFileSync(path.join(folder, `${three.key}.ts`), "export const clash = 1;\n");
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "clash on main"], folder);
  await press(`${cardOf(three.key)}?.querySelector('[data-testid="merge-go"]')`);
  await until(`${cardOf(three.key)}?.dataset.state === 'refused'`);
  check("a conflicting merge is refused on the card, with what to do", await $(`(() => { const c = ${cardOf(three.key)}; return c?.dataset.state === 'refused' && /conflicts with main/.test(c.textContent) && !!c.querySelector('[data-testid="merge-resolve"]'); })()`));
  await $(`${cardOf(three.key)}?.scrollIntoView({ block: 'center' });true`);
  await sleep(300);
  await shot("07-merge-conflict.png");
  await press(`${cardOf(three.key)}?.querySelector('[data-testid="merge-resolve"]')`);
  await until(`${cardOf(three.key)}?.dataset.state === 'resolving'`);
  check("the session is sent back and the card says so", (await $(`${cardOf(three.key)}?.dataset.state`)) === "resolving");
  await until(`${cardOf(three.key)}?.dataset.state === 'offered'`, 30_000);
  check("once it hands over again, the merge is offered again", (await $(`${cardOf(three.key)}?.dataset.state`)) === "offered");
  await press(`${cardOf(three.key)}?.querySelector('[data-testid="merge-go"]')`);
  await until(`${cardOf(three.key)}?.dataset.state === 'merged'`);
  check("and now it merges", (await $(`${cardOf(three.key)}?.dataset.state`)) === "merged" && ctx.items.get(project.id, three.id).status === "done", ctx.items.get(project.id, three.id).status);
  await $(`${cardOf(three.key)}?.scrollIntoView({ block: 'center' });true`);
  await sleep(300);
  await shot("08-merge-resolved.png");

  // ── the merge policy, under the project's repositories ───────────────
  await press(`document.querySelector('.rail-project-settings') ?? document.querySelector('.side-project-settings')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav button')].find((b) => /Repositor/i.test(b.textContent))`);
  await sleep(800);
  const policy = await $(`(() => { const s = document.querySelector('select.repo-merge-policy'); return s ? { value: s.value, options: [...s.options].map((o) => o.textContent) } : null; })()`);
  check("the repository shows the merge policy, set to ask", policy?.value === "ask" && policy.options.length === 3, policy);
  await $(`document.querySelector('select.repo-merge-policy')?.scrollIntoView({ block: 'center' });true`);
  await sleep(300);
  await shot("06-merge-policy.png");
  check("harness reached the end", true);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
