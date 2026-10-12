/**
 * Rules regression: a project's rules are written in Project settings, kept as
 * a file in the project's folder, and read by the next turn of every
 * conversation; an agent's proposed rule lands only after the person says yes.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:rules
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-rules-"));
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
  await ctx.storage.ready;
  const heard = [];
  ctx.agent.engine({ id: "listener", title: "Listener", author: "ai:listener", available: async () => ({ ok: true }), async turn(input) {
    heard.push(input.rules ?? null);
    return { stop: "end" };
  } });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "listener" } });

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const type = (selector, text) => $(`(() => { const i = document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  await sleep(2500);

  // ── written in Project settings ───────────────────────────────────────
  await press(`[...document.querySelectorAll('.side-name')].find((n) => n.textContent?.trim() === 'Project settings')?.closest('button,a')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Rules')`);
  await sleep(500);
  check("Project settings has a Rules pane", (await $(`!!document.querySelector('[data-testid="project-rules"]')`)) === true);
  check("with nothing to save yet", (await $(`document.querySelector('[data-testid="save-rules"]')?.disabled`)) === true);
  await type('[data-testid="project-rules"]', "- Write tickets in Chinese\n- Never touch billing");
  await sleep(200);
  await press(`document.querySelector('[data-testid="save-rules"]')`);
  await sleep(800);
  await shot("rules-01-project-settings");
  const file = path.join(ctx.storage.artifactDirFor(project.id), "rules.md");
  check("saving writes them beside the project's state", fs.existsSync(file) && fs.readFileSync(file, "utf8") === "- Write tickets in Chinese\n- Never touch billing\n", fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  check("the pane says where they live", ((await $(`document.querySelector('[data-testid="project-rules"]')?.closest('.project-settings-section')?.textContent`)) ?? "").includes("rules.md"));
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(400);

  // ── every turn reads them ─────────────────────────────────────────────
  const thread = ctx.agent.newThread(project.id, "listener");
  ctx.agent.send(project.id, thread.id, { kind: "text", text: "plan the week" });
  await sleep(800);
  check("the next turn is told the rules", heard[0] === "- Write tickets in Chinese\n- Never touch billing", heard);

  // ── an agent proposes one; only a yes adds it ─────────────────────────
  const ask = (answer) => async () => answer;
  await ctx.tools.execute("propose_rule", { rule: "Keep pull requests small" }, { by: "ai:listener", projectId: project.id, ask: ask("Don't add") });
  check("a declined proposal adds nothing", !fs.readFileSync(file, "utf8").includes("pull requests"));
  await ctx.tools.execute("propose_rule", { rule: "Keep pull requests small" }, { by: "ai:listener", projectId: project.id, ask: ask("Add rule") });
  check("an accepted one is appended", fs.readFileSync(file, "utf8").endsWith("- Keep pull requests small\n"), fs.readFileSync(file, "utf8"));
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
