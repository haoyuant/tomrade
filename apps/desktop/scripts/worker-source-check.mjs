/**
 * Worker source regression (TOM-176): with no key, a signed-in Claude Code
 * answers worker calls; Settings → Assistant lets the person pick it even with
 * a profile, and says why when the picked agent cannot answer. A fake Claude
 * CLI stands in, so nothing reaches a real model.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:worker-source
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-worker-source-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const log = path.join(work, "claude.jsonl");
const bin = path.join(work, "claude");
const fake = path.resolve(dir, "../../../packages/engine-claude-code/tests/fake-claude-lent.mjs");
fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
const spawns = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.spawn) : []);

const run = async () => {
  const others = ["engine-codex", "engine-pi", "engine-terminal", "engine-hermes", "engine-dsh", "engine-workbuddy"];
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, ...others.map((id) => ({ id, disabled: true }))]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, engines: { ...settings.agent?.engines, "claude-code": { command: bin } } } });
  const schema = z.object({ seen: z.number() });

  // ── no key: the signed-in agent answers ──────────────────────────────
  check("with no key, the worker is the signed-in Claude Code", (await ctx.llm.worker()).via === "lent", await ctx.llm.worker());
  const first = await ctx.llm.completeJson(schema, { system: "count", user: "one" }).catch((e) => String(e));
  const second = await ctx.llm.completeJson(schema, { system: "count", user: "two" }).catch((e) => String(e));
  check("it answers worker calls", first?.seen === 1 && second?.seen === 1, { first, second });
  check("from one kept process", spawns().length === 1, spawns().length);

  // ── Settings: picked even with a profile ─────────────────────────────
  const models = { profiles: [{ id: "p1", title: "Cheap", provider: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" }], roles: { worker: "" } };
  ctx.settings.set({ ...ctx.settings.get(), models });
  check("a profile takes over in Automatic", (await ctx.llm.worker()).via === "profile");

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  await sleep(2000);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await sleep(800);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((r) => r.textContent?.trim() === 'Assistant')`);
  await sleep(800);
  const options = await $(`[...document.querySelectorAll('#role-worker option')].map((o) => [o.value, o.textContent])`);
  check("the worker picker offers Automatic, the profile and the signed-in agent", JSON.stringify(options.map((o) => o[0])) === JSON.stringify(["", "p1", "lent:claude-code"]), options);
  check("and names the agent as signed in here", options[2]?.[1] === "Claude Code (signed in on this computer)", options[2]);

  await $(`(() => { const s = document.querySelector('#role-worker'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'lent:claude-code'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(800);
  check("picking it is saved", ctx.settings.get().models?.roles?.worker === "lent:claude-code", ctx.settings.get().models?.roles);
  const picked = await ctx.llm.completeJson(schema, { system: "count", user: "three" }).catch((e) => String(e));
  check("and the agent answers despite the profile", picked?.seen === 1, picked);

  // ── the picked agent cannot answer: said, not swapped ────────────────
  fs.writeFileSync(log + ".signed-out", "");
  await sleep(31_000); // the sign-in probe is cached for 30s
  const refused = await ctx.llm.completeJson(schema, { system: "count", user: "four" }).then(() => "answered", (e) => String(e));
  check("signed out, a call says the picked agent cannot answer", /set to Claude Code/.test(refused), refused);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((r) => r.textContent?.trim() !== 'Assistant')`);
  await sleep(300);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((r) => r.textContent?.trim() === 'Assistant')`);
  await sleep(1500);
  const problem = await $(`document.querySelector('[data-testid="worker-problem"]')?.textContent ?? ''`);
  check("and Settings shows why under the picker", /Claude Code/.test(problem), problem);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => run().catch((error) => {
  console.error(error);
  app.exit(1);
}));
