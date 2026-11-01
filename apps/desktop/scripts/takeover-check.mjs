/**
 * Takeover regression: an empty backlog offers the scan, the dialog names what it reads and which
 * model it would send to before anything happens, a scan with sessions declined still lists the
 * branches with their sources, and only the ticked entry becomes a ticket.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:takeover
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.TOMRADE_SHOTS ?? path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-takeover-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repository() {
  const remote = path.join(work, "remote.git");
  const checkout = path.join(work, "checkout");
  fs.mkdirSync(remote);
  fs.mkdirSync(checkout);
  git(["init", "--bare", "-q", "-b", "main", "."], remote);
  git(["init", "-q", "-b", "main"], checkout);
  git(["remote", "add", "origin", remote], checkout);
  git(["config", "user.email", "dev@localhost"], checkout);
  git(["config", "user.name", "Dev"], checkout);
  const commit = (subject) => {
    fs.writeFileSync(path.join(checkout, `${subject.replace(/\W/g, "-")}.txt`), subject);
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", subject], checkout);
  };
  commit("initial");
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], checkout);
  for (const name of ["feature/export", "feature/import", "fix/login", "fix/crash", "spike/search"]) {
    git(["checkout", "-q", "-b", name, "main"], checkout);
    commit(`work on ${name}`);
  }
  git(["checkout", "-q", "-b", "feature/export-docs", "feature/export"], checkout);
  commit("document the export");
  git(["checkout", "-q", "main"], checkout);
  return { remote, checkout };
}

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work, linkAgents: "false" }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  const repo = repository();
  const row = ctx.repos.create({ projectId: project.id, remote: repo.remote });
  ctx.boards.update(project.id, ctx.boards.list(project.id)[0].id, { repoId: row.id });
  await ctx.repos.setCheckout(repo.remote, repo.checkout);

  const asked = [];
  ctx.llm.worker = async () => ({ ok: true, title: "Check Model" });
  ctx.llm.completeJson = async () => {
    asked.push("model");
    throw new Error("the check agreed to no model");
  };
  const reads = [];
  ctx.agent.engine({
    id: "recorder",
    title: "Recorder",
    author: "ai:recorder",
    capabilities: ["code"],
    available: async () => ({ ok: true }),
    async turn() {
      return { stop: "end" };
    },
    local: { record: { find: () => null, roots: () => ["/records/recorder"], read: () => (reads.push("read"), null), sessions: () => (reads.push("sessions"), []) } }
  });

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") console.log(`RENDERER: ${String(e.message).slice(0, 400)}`);
  });
  const until = async (js, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await $(js)) return true;
      await sleep(100);
    }
    return false;
  };
  const q = (id) => `document.querySelector('[data-testid="${id}"]')`;
  const text = (id) => $(`${q(id)}?.textContent ?? ""`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `takeover-${name}.png`), (await win.webContents.capturePage()).toPNG());

  check("an empty backlog offers the scan", await until(`!!${q("takeover-banner")}`));
  await $(`${q("takeover-open")}.click()`);
  check("the dialog opens on what would be read", await until(`!!${q("takeover-scan")} && !!${q("takeover-sessions")} && !!${q("takeover-model")}`));
  check("it names the folders it would read", (await text("takeover-sessions-note")).includes("/records/recorder"), await text("takeover-sessions-note"));
  check("sessions wait for a tick", (await $(`${q("takeover-sessions")}.checked`)) === false);
  check("the model waits for a tick", (await $(`${q("takeover-model")}.checked`)) === false);
  await $(`${q("takeover-model")}.click()`);
  check("it names the model before sending", await until(`${q("takeover-model-note")}.textContent.includes("Check Model")`), await text("takeover-model-note"));
  await $(`${q("takeover-sessions")}.click()`);
  check("what is sent grows with the sessions", await until(`${q("takeover-model-note")}.textContent.includes("session")`), await text("takeover-model-note"));
  await $(`${q("takeover-sessions")}.click()`);
  await sleep(400);
  await shot("consent");
  await $(`${q("takeover-model")}.click()`);

  await $(`${q("takeover-scan")}.click()`);
  check("the scan lists every unmerged branch", await until(`document.querySelectorAll('[data-testid="takeover-entry"]').length === 6`), await text("takeover-summary"));
  check("declined sessions were not read", reads.length === 0, reads);
  check("no model was asked", asked.length === 0, asked);
  check("nothing was ticked for the person", (await $(`document.querySelectorAll('[data-testid="takeover-tick"]:checked').length`)) === 0);
  check("the apply button waits for a tick", (await $(`${q("takeover-apply")}.disabled`)) === true);
  check("every entry shows its source", (await $(`[...document.querySelectorAll('[data-testid="takeover-entry"]')].every((e) => e.querySelector('[data-testid="takeover-source"]'))`)) === true);
  check("a stacked branch says what it needs", (await text("takeover-needs")).includes("work on feature/export"), await text("takeover-needs"));
  check("a declined source is said", (await $(`[...document.querySelectorAll('[data-testid="takeover-note"]')].some((n) => n.textContent.includes("sessions"))`)) === true);
  await shot("draft");

  await $(`document.querySelector('[data-testid="takeover-tick"]').click()`);
  check("ticking counts", await until(`${q("takeover-apply")}.textContent.includes("(1)")`), await text("takeover-apply"));
  await $(`${q("takeover-apply")}.click()`);
  check("the dialog closes", await until(`!${q("takeover-apply")}`));
  const tickets = ctx.items.list({ projectId: project.id });
  check("only the ticked entry became a ticket", tickets.length === 1, tickets.map((i) => i.title));
  check("it links its branch", ctx.codeLink.links(project.id, tickets[0]?.id).length === 1);
  check("its body says where it came from", tickets[0]?.body?.includes("Where this came from"), tickets[0]?.body);
  check("the banner goes once the backlog has a ticket", await until(`!${q("takeover-banner")}`));
  check("the board shows it", await until(`document.body.textContent.includes(${JSON.stringify(tickets[0]?.title ?? "?")})`));

  win.destroy();
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
