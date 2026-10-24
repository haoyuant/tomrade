/** Archived Code Link conversations can be opened without restoring them.
 * pnpm build:backend && pnpm dev:ui, then pnpm --filter @tomrade/desktop test:archived-thread
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-archived-thread-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, pass) => { results.push({ name, pass: !!pass }); console.log(`${pass ? "PASS" : "FAIL"}: ${name}`); };

async function run() {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const project = ctx.projects.create({ name: "Archive", keyPrefix: "AR" });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] } });
  const item = ctx.items.create({ projectId: project.id, boardId: ctx.boards.list(project.id)[0].id, title: "Archived conversation", by: "human" });
  const archived = ctx.agent.newThread(project.id, "tomrade", item.boardId, { title: "Finished code conversation", itemId: item.id, surface: "code" });
  const transcript = "The archived code conversation is still readable.";
  ctx.agent.store.appendMessage(project.id, archived.id, "assistant", { type: "text", text: transcript }, null);
  const session = ctx.codeLink.store.createSession(project.id, { repoId: "fixture", branch: "ar-1/fix", itemIds: [item.id], mode: "run", agent: "tomrade", threadId: archived.id, device: "test" });
  ctx.codeLink.store.patchSession(project.id, session.id, { state: "ended", endedAt: Date.now() });
  ctx.agent.archiveThread(project.id, archived.id);
  const other = ctx.agent.newThread(project.id, "tomrade", null, { title: "Current conversation" });
  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js) => {
    for (let i = 0; i < 80; i++) { if (await $(js)) return true; await sleep(100); }
    return false;
  };
  const readable = `document.querySelector('.ai-scroll')?.textContent.includes(${JSON.stringify(transcript)})`;
  await waitFor(`!!document.querySelector('.ai-input')`);
  // The ticket command returns showThread; all consumers route that request to the assistant.
  const result = await ctx.contributions.run("code-link.open-thread", { projectId: project.id, itemId: item.id });
  check("the ticket command finds the ended session", result.showThread === archived.id);
  ctx.ipc.send("app.open", { projectId: project.id, threadId: result.showThread });
  check("the requested archived conversation shows its transcript", await waitFor(readable));
  check("viewing keeps it archived and read-only", ctx.agent.store.thread(project.id, archived.id)?.archived === true && await $(`document.querySelector('.ai-input')?.disabled === true`));
  check("it stays out of the active conversation list", !ctx.agent.store.threads(project.id).some((t) => t.id === archived.id));
  ctx.ipc.send("codeLink.changed", project.id);
  await sleep(500);
  check("refreshing the active list keeps the requested archive visible", await $(readable));
  ctx.ipc.send("app.open", { projectId: project.id, threadId: other.id });
  check("another conversation can be opened", await waitFor(`document.querySelector('.ai-input')?.disabled === false && !(${readable})`));
  ctx.ipc.send("app.open", { projectId: project.id, threadId: archived.id });
  check("the same archived conversation can be opened again", await waitFor(readable));
  check("reopening still does not restore it", ctx.agent.store.thread(project.id, archived.id)?.archived === true);
  await new Promise((resolve) => { win.webContents.once("did-finish-load", resolve); win.reload(); });
  check("a saved archive does not replace the active conversation on restart", await waitFor(`document.querySelector('.ai-input')?.disabled === false && !(${readable})`));
  ctx.ipc.send("app.open", { projectId: project.id, threadId: archived.id });
  check("explicitly opening the saved archive works after restart", await waitFor(readable));
  check("the archive still contains the conversation", ctx.agent.store.archivedThreads(project.id, "code").some((t) => t.id === archived.id));
  win.destroy();
}

app.whenReady().then(run).then(() => {
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((error) => { console.error(error); app.exit(1); });
