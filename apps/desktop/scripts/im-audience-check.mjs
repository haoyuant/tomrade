/**
 * A conversation bound to an IM group says, above the composer, that desktop
 * turns stay on the desktop; sharing the next turn sends that one turn there.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:im-audience
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-im-audience-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  ctx.agent.engine({ id: "echo", title: "Echo", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input, io) { io.emit({ type: "text", text: `echo: ${input.input.kind === "text" ? input.input.text : ""}` }); return { stop: "end" }; } });
  const settings = ctx.settings.get();
  const sent = [];
  let receive;
  ctx.im.register({ id: "standin", title: "Stand-in Chat",
    capabilities: { edit: false, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 },
    async open(_id, io) { receive = io.receive; return { deliver: async (d) => { sent.push(d); return { messageId: `m-${sent.length}` }; }, close: () => {} }; } });
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "echo" },
    im: { connections: [{ id: "team", adapterId: "standin" }], routes: [{ id: "room", connectionId: "team", tenantId: "T1", conversationId: "C-room", projectId: project.id, engine: "echo", allowedActors: ["U1"], allowGroups: true }] } });
  for (let i = 0; i < 50 && !receive; i++) await sleep(100);
  await receive({ kind: "message", eventId: "g1", messageId: "g1", text: "plan the launch", activation: "mention", actor: { id: "U1", isBot: false }, address: { tenantId: "T1", conversationId: "C-room" } });
  for (let i = 0; i < 50 && !sent.some((d) => d.content.text === "echo: plan the launch"); i++) await sleep(100);
  const binding = ctx.im.store.bindings()[0];

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const waitFor = async (js, ms = 8000) => { for (let w = 0; w < ms; w += 100) { if (await $(js)) return true; await sleep(100); } return false; };
  await sleep(2000);
  check("the panel says desktop turns stay out of the group", await waitFor(`document.querySelector('[data-testid=im-group-share]')?.textContent.includes("C-room doesn't see them")`));
  fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS ?? work, "im-group-share.png"), (await win.webContents.capturePage()).toPNG());
  await press(`[...document.querySelectorAll('[data-testid=im-group-share] button')].find((b) => b.textContent.trim() === 'Share next turn')`);
  check("sharing the next turn is recorded", await waitFor(`document.querySelector('[data-testid=im-group-share]')?.textContent.includes('Your next turn here also goes to C-room')`) && ctx.im.threadBindings(project.id, binding.thread_id)[0].shareNext);
  ctx.agent.send(project.id, binding.thread_id, { kind: "text", text: "shared from the desk" });
  for (let i = 0; i < 50 && !sent.some((d) => d.content.text === "echo: shared from the desk"); i++) await sleep(100);
  check("the shared turn reaches the group", sent.some((d) => d.content.text === "echo: shared from the desk"));
  check("and the panel goes back to private", await waitFor(`document.querySelector('[data-testid=im-group-share]')?.textContent.includes("C-room doesn't see them")`));
  win.destroy();
};

app.whenReady()
  .then(run)
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — failed: ${failed.map((f) => f.name).join("; ")}` : ""}`);
    app.exit(failed.length ? 1 : 0);
  })
  .catch((error) => { console.error(error); app.exit(1); });
