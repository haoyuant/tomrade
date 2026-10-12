/**
 * The agents Tomrade drives over ACP — Hermes, dsh, WorkBuddy — as the app
 * shows them: their state in Settings and the Start dialog, what Hermes says
 * when its ACP support is missing, the models WorkBuddy lists, and that only
 * WorkBuddy is offered for a terminal. Stand-in CLIs make every state
 * deterministic; the other local agents are switched off.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:acp-engines
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-acp-engines-"));
app.setPath("userData", work);
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

/** A stand-in CLI: `--version` answers, and each other first argument prints what it is given. */
const fake = (name, answers) => {
  const file = path.join(work, "bin", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cases = Object.entries(answers).map(([arg, out]) => `  ${arg}) printf '%s\\n' '${out}';;`).join("\n");
  fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  --version) echo "${name} 9.9.9";;\n${cases}\nesac\n`, { mode: 0o755 });
  return file;
};

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-claude-code", "engine-codex", "engine-pi", "engine-pi-builtin"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const project = ctx.projects.create({ name: "ACP agents", keyPrefix: "AC" });
  const board = ctx.boards.list(project.id)[0];
  const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Draft the launch post", workType: "general", status: "todo", by: "human" });

  const hermes = fake("hermes", { acp: "ModuleNotFoundError: No module named acp" });
  const codebuddy = fake("codebuddy", { "--help": "--model <model>  Model for the current session. Currently supported: (default-model, hy3, gpt-5.5)" });
  const dsh = fake("dsh", {});
  const settings = ctx.settings.get();
  ctx.settings.set({
    ...settings,
    language: "en",
    onboarding: { seen: ["*"] },
    agent: { ...settings.agent, engines: { ...settings.agent?.engines, hermes: { command: hermes }, workbuddy: { command: codebuddy }, dsh: { command: dsh } } }
  });

  // ── what the engines report ───────────────────────────────────────────
  const views = await ctx.agent.engineViews(true);
  const view = (id) => views.find((e) => e.id === id);
  check("Hermes without its ACP support needs repair, and says why", view("hermes") && !view("hermes").ok && view("hermes").need === "repair" && /ACP support/.test(view("hermes").reason), view("hermes"));
  check("WorkBuddy and dsh are ready with the CLI they found", view("workbuddy")?.ok && view("workbuddy").cli.path === codebuddy && view("dsh")?.ok, [view("workbuddy"), view("dsh")]);
  check("only WorkBuddy can be handed a terminal", view("hermes").terminal === false && view("dsh").terminal === false && view("workbuddy").terminal === undefined);
  check("WorkBuddy's models come from its help before any session", view("workbuddy").picks[0].choices.map((c) => c.value).join() === "default-model,hy3,gpt-5.5", view("workbuddy").picks);
  check("dsh offers its reasoning efforts", view("dsh").picks[1]?.choices.map((c) => c.value).join() === "off,low,high,max", view("dsh").picks);

  const win = new BrowserWindow({ width: 1440, height: 960, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  const click = (selector) => $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
  const wait = async (cond, what, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const shot = async (name) => {
    await sleep(600);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const options = () => $(`[...document.querySelectorAll('#stEngine option')].map((o) => o.textContent)`);
  const mode = (label) => $(`[...document.querySelectorAll('[data-testid="start-mode"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click() ?? false`);

  // ── Start ─────────────────────────────────────────────────────────────
  await $(`location.hash = '#/p/${project.id}/i/${item.id}';true`);
  check("the ticket offers Start", await wait(() => has('[data-testid="start-ticket"]'), "start button"));
  await click('[data-testid="start-ticket"]');
  check("the dialog opens", await wait(() => has('[data-testid="start-dialog"]'), "start dialog"));
  await mode("Run here");
  await wait(async () => (await options()).length === 3, "three agents");
  const here = await options();
  check("Run here offers all three, Hermes with its state", here.join("|") === "Hermes — Found, but won't run|dsh|WorkBuddy", here);
  check("the first ready one is chosen", (await $(`document.querySelector('#stEngine').value`)) === "dsh");
  check("dsh's efforts are a pick", (await $(`[...document.querySelectorAll('#stPick-effort option')].map((o) => o.value).join()`)) === ",off,low,high,max");
  await $(`(() => { const s = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'workbuddy'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check("WorkBuddy's models are offered as you type", await wait(async () => (await $(`[...document.querySelectorAll('#stPick-model-list option')].map((o) => o.value).join()`)) === "default-model,hy3,gpt-5.5", "model list"));
  await shot("acp-engines-01-start-here");

  await mode("Open in terminal");
  check("a terminal is offered only to WorkBuddy", await wait(async () => (await options()).join("|") === "WorkBuddy", "terminal agents"), await options());
  await shot("acp-engines-02-start-terminal");

  // ── Settings, from the agent that is not ready ────────────────────────
  await mode("Run here");
  await wait(async () => (await options()).length === 3, "three agents again");
  await $(`(() => { const s = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'hermes'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check("Hermes explains itself under the list", await wait(async () => (await text('[data-testid="start-engine-not-ready"]'))?.startsWith("Hermes isn't ready: Found, but won't run."), "hermes not ready"));
  await click('[data-testid="start-engine-configure"]');
  check("Set up opens Settings on Hermes' row", await wait(() => has('[data-testid="cli-setup-hermes"]'), "hermes row"));
  const row = await text('[data-testid="cli-setup-hermes"]');
  check("which says what is missing and how to look", row.includes("ACP support") && row.includes("hermes --version") && row.includes("which hermes"), row);
  await $(`document.querySelector('[data-testid="cli-setup-hermes"]').scrollIntoView({ block: "center" });true`);
  await shot("acp-engines-03-settings-hermes");

  console.log(`screenshots in ${shots}`);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error(err);
    check("the check ran to the end", false);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed < results.length) console.log(`failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(" | ")}`);
  app.exit(passed === results.length ? 0 : 1);
});
