/**
 * The feedback inbox, end to end in the real app: a project switches a source
 * on from the inbox's Sources pane; what it pulls waits in the inbox, counted
 * on the sidebar's Inbox module; an entry accepted becomes a ticket with Source
 * and Kind and a "From feedback" view; another merged into it is counted on the
 * ticket; one closed as a duplicate is told to its source. And the bottom bar's
 * Feedback sends an idea through the troubleshooter's outbox, listed by kind
 * under My reports.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:inbox
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-inbox-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const local = ["engine-claude-code", "engine-codex", "engine-pi", "engine-pi-builtin", "engine-terminal", "engine-hermes", "engine-dsh", "engine-workbuddy"];
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, ...local.map((id) => ({ id, disabled: true })),
      { id: "doctor", config: { dataDir: "${userData}/doctor", logDir: "${logDir}", version: "${appVersion}", catalogUrl: "" } }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;

  // A source of the check's own: three pieces of feedback, and an ear for what becomes of them.
  const told = [];
  const day = Date.UTC(2026, 9, 14);
  ctx.inbox.source({
    id: "checks",
    title: "Check feedback",
    keyPattern: "F-\\d+",
    pull: async () => [
      { externalId: "F-1", kind: "bug", title: "Board freezes on drag", body: "Dragging a card across columns freezes the board for a second.", reporter: "ann", receivedAt: day },
      { externalId: "F-2", kind: "bug", title: "Drag is slow", body: "Same here, moving cards lags.", reporter: "bo", receivedAt: day + 3_600_000 },
      { externalId: "F-3", kind: "idea", title: "Board freezes when dragging", body: "Seen it too.", reporter: "cy", receivedAt: day + 7_200_000 }
    ],
    setStatus: async (entry, change) => void told.push([entry.externalId, change.state, change.reason ?? change.ticket?.key ?? null]),
    reply: async () => {}
  });
  const sent = [];
  ctx.doctor.transport = async (report) => void sent.push(report);
  ctx.doctor.fetchReports = async () => [];

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const button = (text, scope = "document") => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const type = (expr, value) =>
    $(`(() => { const n = ${expr}; if (!n) return false; const proto = n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(n, ${JSON.stringify(value)}); n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const shots = process.env.TOMRADE_SHOTS ?? path.join(work, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const shot = async (name) => fs.writeFileSync(path.join(shots, `inbox-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const waitFor = async (js, ms = 15_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await $(js)) return true;
      await sleep(200);
    }
    return false;
  };
  const dialog = "document.querySelector('.sheet-inbox')";

  // ── a door in the sidebar, and sources chosen per project ─────────────
  check("the sidebar has an Inbox module", await waitFor(`!!document.querySelector('[data-module-door="inbox"]')`));
  await press(`document.querySelector('[data-module-door="inbox"]')`);
  check("which opens the inbox", await waitFor(`!!${dialog}`));
  check("empty, it says to choose a source", await waitFor(`${dialog}?.textContent.includes('Switch on a source')`));
  await press(button("Choose sources", dialog));
  check("the Sources pane lists the source, off", await waitFor(`document.querySelector('.inbox-source[data-source="checks"] .switch')?.getAttribute('aria-checked') === 'false'`));
  await press(`document.querySelector('.inbox-source[data-source="checks"] .switch')`);
  check("switched on, it pulls at once", await waitFor(`document.querySelector('.inbox-source[data-source="checks"]')?.textContent.includes('Last checked')`));
  await shot("sources");
  await press(button("Back to the inbox", dialog));
  check("three entries wait", await waitFor(`${dialog}?.querySelectorAll('.inbox-entry').length === 3`));
  check("counted on the To triage tab and the sidebar", await waitFor(`${dialog}?.querySelector('.inbox-tabs .side-count')?.textContent === '3' && document.querySelector('.side-module-head .side-count')?.textContent === '3'`));
  await shot("entries");

  // ── accept, merge, close ──────────────────────────────────────────────
  await press(`document.querySelector('.inbox-entry[data-entry="F-1"]')`);
  await press(`document.querySelector('[data-testid="inbox-accept"]')`);
  check("accepting asks for the ticket's title, filled in", await waitFor(`document.querySelector('.inbox-form input')?.value === 'Board freezes on drag'`));
  await type(`document.querySelector('.inbox-form input')`, "Dragging a card freezes the board");
  await shot("accept");
  await press(button("Create ticket", dialog));
  check("it says which ticket it made", await waitFor(`document.body.textContent.includes('Created AL-1')`));
  const ticket = ctx.items.getByKey(project.id, "AL-1");
  const fields = ctx.fields.custom(project.id);
  const source = fields.find((f) => f.name === "Source");
  const kind = fields.find((f) => f.name === "Kind");
  check("the ticket carries the title, the quote and Source and Kind", ticket?.title === "Dragging a card freezes the board" && ticket.body.includes("F-1") && ticket.body.includes("freezes the board for a second") && !!source && !!kind && !!ticket.fields[source.id] && !!ticket.fields[kind.id], { ticket, fields: fields.map((f) => f.name) });
  check("and a From feedback view is in the sidebar", await waitFor(`[...document.querySelectorAll('.sidebar .side-name')].some((n) => n.textContent === 'From feedback')`));
  check("the accepted entry leaves To triage", await waitFor(`${dialog}?.querySelectorAll('.inbox-entry').length === 2`));

  await press(`document.querySelector('.inbox-entry[data-entry="F-3"]')`);
  await press(button("Merge into a ticket", dialog));
  await waitFor(`!!document.querySelector('.inbox-form input')`);
  await type(`document.querySelector('.inbox-form input')`, "AL-1");
  check("merging finds the ticket by key", await waitFor(`document.querySelector('.inbox-match')?.textContent.includes('AL-1')`));
  await press(`document.querySelector('.inbox-match')`);
  check("and says it merged", await waitFor(`document.body.textContent.includes('Merged into AL-1')`));

  await press(`document.querySelector('.inbox-entry[data-entry="F-2"]')`);
  await press(button("Duplicate", dialog));
  check("closed as a duplicate, nothing waits", await waitFor(`${dialog}?.textContent.includes('Nothing waits for triage')`));
  check("and the sidebar count goes", await waitFor(`!document.querySelector('.side-module-head .side-count')`));
  await press(button("Closed", `${dialog}.querySelector('.inbox-tabs')`));
  check("the Closed tab holds it, with a way back", await waitFor(`${dialog}?.textContent.includes('Closed: duplicate') && !!${button("Reopen", dialog)}`));
  await shot("closed");
  for (let i = 0; i < 50 && told.length < 3; i++) await sleep(100);
  check("the source heard every triage: accepted, merged and closed", JSON.stringify(told.map((t) => t[1]).sort()) === JSON.stringify(["accepted", "closed", "merged"]), told);

  // ── the ticket counts what came in ────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await waitFor(`!${dialog}`, 3000);
  check("the ticket's Feedback field counts two", ctx.fields.derivedValues(project.id).get(ticket?.id)?.feedback === 2);
  await win.webContents.executeJavaScript(`location.hash = '#/p/${project.id}/i/${ticket?.id}'; true`);
  check("and its page lists both", await waitFor(`document.body.textContent.includes('Came in 2 times.')`));
  await shot("ticket");

  // ── writing in ────────────────────────────────────────────────────────
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  check("the bottom bar offers Feedback", await waitFor(`!!${button("Feedback", "document.querySelector('.statusbar')")}`));
  await press(button("Feedback", "document.querySelector('.statusbar')"));
  check("which opens a place to write", await waitFor(`!!document.querySelector('[data-testid="feedback-kind"]')`));
  await press(`[...document.querySelectorAll('[data-testid="feedback-kind"] button')].find((b) => b.textContent === 'Idea')`);
  await type(`document.querySelector('.sheet-report textarea')`, "Let me group the board by who reported it.");
  check("it says what goes with the text", await waitFor(`document.querySelector('.sheet-report')?.textContent.includes('Goes with: Tomrade')`));
  await shot("feedback");
  await press(button("Send", "document.querySelector('.sheet-report')"));
  check("sent, it gives the code", await waitFor(`/Sent as R-[0-9A-Z]{6}/.test(document.querySelector('.sheet-report')?.textContent ?? '')`));
  check("as an idea, with only what was written", sent.length === 1 && sent[0].kind === "idea" && sent[0].sections.length === 1 && sent[0].sections[0].text === "Let me group the board by who reported it.", sent);
  await press(button("Done", "document.querySelector('.sheet-report')"));
  check("the palette offers it too", ctx.contributions.commands().some((c) => c.id === "inbox-tomrade.feedback"));
  const code = sent[0]?.code;
  const reports = await ctx.doctor.reports();
  check("My reports lists it as an idea", reports.reports.some((r) => r.code === code && r.kind === "idea"), reports.reports);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`shots: ${shots}`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => run().catch((error) => { console.error(error); app.exit(1); }));
