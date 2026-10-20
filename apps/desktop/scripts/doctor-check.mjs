/**
 * The troubleshooter, end to end in the real app: a failed turn offers
 * Troubleshoot; the troubleshooting thread ticks a checklist, runs a test turn,
 * names the known issue and offers what to do; the report shows exactly what
 * would be sent (no conversation unless ticked) and waits in the outbox when
 * it can't go; another agent, picked by the person, looks into it with only
 * the troubleshooting tools and concludes on a card; the bottom bar starts one too;
 * the developer's reply shows in the bottom bar and in About → My reports; the troubleshooter is never
 * offered as an agent; and a packaged build's log now lands in a file.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:doctor
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-doctor-"));
app.setPath("userData", work);
quietStarters(work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// A model service: asked to investigate (it is offered doctor_conclude), it concludes, then says so; anything else gets "pong".
const investigation = { tools: null, brief: "" };
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const endpoint = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let request = {};
    try { request = JSON.parse(body); } catch {}
    const tools = (request.tools ?? []).map((t) => t.function?.name);
    const answered = (request.messages ?? []).some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (tools.includes("doctor_conclude") && !answered) {
      investigation.tools = tools;
      investigation.brief = JSON.stringify(request.messages ?? []);
      const args = JSON.stringify({ headline: "Refusing signs in against the internal endpoint", explanation: "Its models end in -ioa: the internal edition.", confidence: "medium", offer: ["retry-with"] });
      return res.end(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "doctor_conclude", arguments: args } }] }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]));
    }
    const text = tools.includes("doctor_conclude") ? "It is the internal edition; carry on with another agent." : "pong";
    res.end(sse([{ choices: [{ delta: { content: text }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]));
  });
});
const agentLog = path.join(work, "refusing.log");
fs.writeFileSync(agentLog, `POST https://copilot.tencent.com/v2/chat for ${os.homedir()}/src\n401 endpoint mismatch\n`);

const run = async () => {
  await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
  const local = ["engine-claude-code", "engine-codex", "engine-pi", "engine-pi-builtin"];
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, ...local.map((id) => ({ id, disabled: true })),
      // no catalog from tomrade.com in a check
      { id: "doctor", config: { dataDir: "${userData}/doctor", logDir: "${logDir}", version: "${appVersion}", catalogUrl: "" } }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  let turns = 0;
  ctx.agent.engine({
    id: "refusing",
    title: "Refusing",
    author: "ai:refusing",
    capabilities: ["backlog", "code", "general"],
    available: async () => ({ ok: true }),
    setup: { install: [], signIn: "refusing login" },
    diagnostics: { logs: () => [agentLog], facts: () => ({ edition: "ioa" }) },
    async turn() {
      turns++;
      return { stop: "error", error: "Refusing stopped: Request failed with status code 401", details: '── answer ──\n{"statusCode":401,"model":"hy3-ioa"}' };
    }
  });
  ctx.doctor.issue({
    id: "refusing-ioa", engine: "refusing", when: [{ fact: "edition", matches: "^ioa$" }],
    title: { en: "Refusing is the internal edition", zh: "内部版" }, explain: { en: "Carry on with another agent for now.", zh: "先换个智能体。" }, confidence: "medium", offer: ["retry-with"]
  });
  const settings = ctx.settings.get();
  ctx.settings.set({
    ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "loop" },
    models: { profiles: [{ id: "good", title: "Good", provider: "openai-compatible", baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, model: "pong", apiKey: "sk-e2eSECRETKEY0123456789" }], roles: { worker: "good" } }
  });

  const failing = ctx.agent.newThread(project.id, "refusing");
  ctx.agent.send(project.id, failing.id, { kind: "text", text: "my secret plan" });
  await sleep(1500);

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const button = (text, scope = "document") => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const shots = process.env.TOMRADE_SHOTS ?? path.join(work, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const shot = async (name) => fs.writeFileSync(path.join(shots, `doctor-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const waitFor = async (js, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await $(js)) return true;
      await sleep(250);
    }
    return false;
  };
  await $(`localStorage.setItem(${JSON.stringify(`tomrade.agent.thread.${project.id}`)}, ${JSON.stringify(failing.id)}); location.reload(); true`);
  await sleep(3000);

  // ── a failed turn offers to look into it ─────────────────────────────
  check("a failed turn offers Troubleshoot", await $(`!!${button("Troubleshoot", "document.querySelector('.ai-error')")}`));
  const pickerHas = async () => {
    await press(`document.querySelector('.tag.chip-btn[title="Who conducts this thread"]')`);
    await sleep(400);
    const names = await $(`[...document.querySelectorAll('[role="menu"] .m-name')].map((n) => n.textContent)`);
    await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(200);
    return names;
  };
  const offered = await pickerHas();
  check("the troubleshooter is never offered as an agent", offered.length > 0 && !offered.includes("Troubleshooter"), offered);
  await press(button("Troubleshoot", "document.querySelector('.ai-error')"));
  const opened = await waitFor(`!!document.querySelector('.checklist')`, 8000);
  check("it opens a troubleshooting thread that shows its checklist", opened);
  const doctorThread = ctx.agent.store.threads(project.id, ["doctor"])[0];
  check("about that failure, named after the agent", doctorThread?.title === "Troubleshooting: Refusing", doctorThread?.title);
  await shot("running");
  const done = await waitFor(`!!document.querySelector('.finding')`, 30_000);
  check("the checks finish with a finding", done);
  const rows = await $(`[...document.querySelectorAll('.checklist .check-row')].map((r) => [r.querySelector('.check-title').textContent, r.className.match(/is-(\\w+)/)[1]])`);
  const states = Object.fromEntries(rows);
  check("Tomrade, the agent, the tools and a test turn were checked", states["Tomrade"] === "ok" && states["Refusing"] === "ok" && states["Tomrade's tools for local agents"] === "ok" && states["A test turn with Refusing"] === "fail", rows);
  check("the test turn really ran, in a thread nobody sees and that is gone", turns === 2 && !ctx.agent.store.threads(project.id, null).some((t) => t.surface === "probe"), { turns });
  const finding = await $(`(() => { const f = document.querySelector('.finding'); return { head: f.querySelector('.finding-head span').textContent, buttons: [...document.querySelectorAll('.finding button')].map((b) => b.textContent.trim()) }; })()`);
  check("the known issue is named", finding.head === "Refusing is the internal edition", finding);
  check("with a way to carry on, to check again, and to tell the developer", ["Continue with another agent", "Check again", "Send to the developer"].every((label) => finding.buttons.some((b) => b.startsWith(label))), finding.buttons);
  await shot("done");

  // ── the report: read before it goes ──────────────────────────────────
  await press(button("Send to the developer"));
  await waitFor(`!!document.querySelector('.report-preview')`, 5000);
  await sleep(800);
  const preview = () => $(`document.querySelector('.report-preview')?.textContent ?? ''`);
  const first = await preview();
  check("the report shows the error, the checks and the agent's log", first.includes("status code 401") && first.includes("[fail]") && first.includes("401 endpoint mismatch"), first.slice(0, 400));
  check("but not the conversation, until it is ticked", !first.includes("my secret plan"), first.slice(0, 200));
  check("and never the home folder's name", !first.includes(os.homedir()), first.slice(0, 200));
  const conversation = `[...document.querySelectorAll('.report-sections label')].find((l) => l.textContent.includes('The conversation')).querySelector('input')`;
  check("the conversation box starts unticked", (await $(`${conversation}.checked`)) === false);
  await $(`${conversation}.click(); true`);
  await sleep(800);
  check("ticked, the conversation is in the text too", (await preview()).includes("my secret plan"));
  await $(`${conversation}.click(); true`);
  await sleep(500);
  await shot("report");
  await press(button("Send", "document.querySelector('.dlg-foot, [role=dialog]')"));
  const saved = await waitFor(`!!document.querySelector('.report-result')`, 8000);
  const status = await $(`document.querySelector('.report-result')?.textContent ?? ''`);
  check("with no account to send through, it is kept for later with its code", saved && /Saved as report R-[0-9A-Z]{6}/.test(status), status);
  const outbox = fs.readdirSync(path.join(work, "doctor", "outbox"));
  check("in the outbox, without the conversation", outbox.length === 1 && !fs.readFileSync(path.join(work, "doctor", "outbox", outbox[0]), "utf8").includes("my secret plan"), outbox);
  await press(button("Done"));
  await sleep(500);

  // ── another agent looks into it, with only the troubleshooting tools ──
  await press(button("Let an agent look into it"));
  await sleep(500);
  const menu = await $(`({ note: document.querySelector('[role="menu"] .menu-note')?.textContent ?? '', names: [...document.querySelectorAll('[role="menu"] .m-name')].map((n) => n.textContent) })`);
  check("before anyone looks, it says what they read and where it goes", /model provider/.test(menu.note), menu.note);
  check("the agent that failed is not offered to look into itself", menu.names.includes("Tomrade") && !menu.names.includes("Refusing") && !menu.names.includes("Troubleshooter"), menu.names);
  await press(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((n) => n.querySelector(".m-name")?.textContent === "Tomrade")`);
  const concluded = await waitFor(`[...document.querySelectorAll('.finding-head span')].some((s) => s.textContent === 'Refusing signs in against the internal endpoint')`, 20_000);
  check("it concludes on a card of its own", concluded);
  check("having been handed the error, the checks and the facts", investigation.brief.includes("status code 401") && investigation.brief.includes("edition: ioa"), investigation.brief.slice(0, 300));
  const allowed = ["doctor_read_log", "doctor_check_again", "doctor_conclude", "ask_user", "web_search", "web_fetch"];
  check("and only the troubleshooting tools", Array.isArray(investigation.tools) && investigation.tools.length > 0 && investigation.tools.every((n) => allowed.includes(n)), investigation.tools);
  check("the thread says who is looking into it", (await $(`[...document.querySelectorAll('.tag')].some((t) => t.textContent.trim() === 'Troubleshooter · Tomrade')`)));
  await shot("investigated");

  // ── carry on with another agent ──────────────────────────────────────
  await press(button("Continue with another agent"));
  await sleep(500);
  await press(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((n) => n.querySelector(".m-name")?.textContent === "Tomrade")`);
  await sleep(3500);
  const moved = ctx.agent.store.thread(project.id, failing.id);
  const after = ctx.agent.store.messages(project.id, failing.id);
  check("the failed conversation moves to that agent", moved?.engine === "tomrade", moved?.engine);
  check("which answers the same message", after.filter((m) => m.role === "user").at(-1)?.block.text === "my secret plan" && after.at(-1)?.block.type === "text" && after.at(-1).block.text === "pong", after.at(-1)?.block);

  // ── the bottom bar starts one with nothing failed, on its right, with a bug ─
  const entry = await $(`(() => { const b = ${button("Troubleshoot", "document.querySelector('.statusbar')")}; if (!b) return null; const bar = document.querySelector('.statusbar'); const kids = [...bar.children]; return { right: kids.indexOf(b) > kids.findIndex((n) => n.classList.contains('spacer')), bug: !!b.querySelector('use[href="#i-bug"]'), label: b.getAttribute('aria-label') }; })()`);
  check("the bottom bar always offers Troubleshoot", !!entry);
  check("on the right of the bar, with a bug and a label", !!entry && entry.right && entry.bug && !!entry.label, entry);
  await press(button("Troubleshoot", "document.querySelector('.statusbar')"));
  await sleep(1000);
  const general = ctx.agent.store.threads(project.id, ["doctor"]).find((t) => t.id !== doctorThread.id);
  check("it opens a new troubleshooting thread", !!general && general.title === "Troubleshooting: a problem", general?.title);
  await waitFor(`[...document.querySelectorAll('.checklist')].length && !document.querySelector('.check-row.is-running, .check-row.is-pending')`, 20_000);
  const generalRows = await $(`[...[...document.querySelectorAll('.checklist')].pop().querySelectorAll('.check-title')].map((n) => n.textContent)`);
  check("which looks at the whole setup: agents, models, tools, sync", ["Tomrade", "Refusing", "Models", "Tomrade's tools for local agents", "Account and sync"].every((r) => generalRows.includes(r)), generalRows);
  await shot("general");

  // ── the developer answers ────────────────────────────────────────────
  const queuedCode = outbox[0].replace(/\.json$/, "");
  ctx.doctor.transport = async () => {};
  check("a waiting report goes once the backend can take it", (await ctx.doctor.flush()) === 1 && ctx.doctor.pending() === 0);
  ctx.doctor.fetchReports = async () => [{ code: queuedCode, created_at: new Date().toISOString(), summary: "Refusing is the internal edition", engine: "refusing", status: "fixed", reply: "Fixed — update to 0.7.0 and it signs in.", replied_at: new Date().toISOString(), fixed_in: "0.7.0" }];
  await ctx.doctor.refreshReports();
  const notice = await waitFor(`!!${button("A reply to your report", "document.querySelector('.statusbar')")}`, 5000);
  check("a reply shows in the bottom bar", notice);
  await press(button("A reply to your report", "document.querySelector('.statusbar')"));
  const listed = await waitFor(`!!document.querySelector('.my-report[data-code="${queuedCode}"]')`, 5000);
  check("which opens About on My reports", listed);
  const mine = await $(`(() => { const r = document.querySelector('.my-report[data-code="${queuedCode}"]'); return r ? { text: r.textContent, isNew: r.classList.contains('is-new') } : null; })()`);
  check("with the reply, marked new, and when the fix arrives", !!mine && mine.isNew && mine.text.includes("Fixed — update to 0.7.0") && mine.text.includes("Fixed in 0.7.0 — update to get it."), mine);
  await shot("my-reports");
  const gone = await waitFor(`!${button("A reply to your report", "document.querySelector('.statusbar')")}`, 5000);
  check("seen, the bottom bar lets it go", gone);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(400);

  // ── a log a packaged build keeps ─────────────────────────────────────
  const logs = fs.existsSync(path.join(work, "logs")) ? fs.readdirSync(path.join(work, "logs")) : [];
  const today = `tomrade-${new Date().toISOString().slice(0, 10)}.log`;
  check("the app writes today's log to a file", logs.includes(today), logs);
  check("with no key in it", logs.includes(today) && !fs.readFileSync(path.join(work, "logs", today), "utf8").includes("SECRETKEY"));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`shots: ${shots}`);
  endpoint.close();
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => run().catch((error) => { console.error(error); app.exit(1); }));
