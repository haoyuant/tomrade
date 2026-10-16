/**
 * tomrade:// links, as IM replies carry them, open the ticket, the file or the
 * conversation in the main window — even from the projects screen.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:deep-link
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { deliverDeepLink } from "../dist/deep-link.js";
import { provideMainWindow } from "../dist/main-window.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-deep-link-"));
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
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] } });
  const item = ctx.items.create({ projectId: project.id, boardId: ctx.boards.list(project.id)[0].id, title: "Fix the login page", status: "todo", by: "human" });
  const saved = await ctx.files.write(project.id, "Docs/release-plan.md", "# Release plan\n");

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  provideMainWindow({ open: () => win, current: () => win });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await $(js)) return true;
      await sleep(100);
    }
    return false;
  };
  await sleep(2000);

  deliverDeepLink(`tomrade://item/${encodeURIComponent(project.id)}/${item.key}`);
  check("an item link opens the ticket", await waitFor(`location.hash.includes(${JSON.stringify(`/i/${item.id}`)}) || [...document.querySelectorAll('h1, h2, [contenteditable], input')].some((n) => (n.value ?? n.textContent ?? '').includes('Fix the login page'))`), await $("location.hash"));
  fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS ?? work, "deep-link-item.png"), (await win.webContents.capturePage()).toPNG());

  deliverDeepLink(`tomrade://file/${encodeURIComponent(project.id)}/${encodeURIComponent(saved.fileId)}`);
  check("a file link opens the file", await waitFor(`decodeURIComponent(location.hash).includes('/f/Docs/release-plan.md')`), await $("location.hash"));

  deliverDeepLink(`tomrade://item/${encodeURIComponent(project.id)}/AL-999`);
  await sleep(800);
  check("a link to something gone changes nothing", decodeURIComponent(await $("location.hash")).includes("/f/Docs/release-plan.md"));

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
