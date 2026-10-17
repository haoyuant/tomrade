/**
 * Storage race regression: tickets written while the periodic reconcile is
 * busy with a slow remote must all survive, in the cache and in the folder.
 *
 * The project is bound to a bare git remote reached through a `git` that takes
 * a second and a half for fetch, ls-remote and push — a network remote's
 * pace — and the reconcile runs every two seconds while a ticket is created
 * every 0.7 s. Before the fix a merge recorded itself as the folder's base, so
 * the next refresh read the folder's older snapshot as a deletion; 20-odd of
 * 30 tickets vanished on every run. `--second-instance` adds another process
 * on the same userData, idle, as when the app is launched twice.
 *
 * Then publishes are made to meet — a write's own, the catch-up, a quit's —
 * with the reconcile still running. Before they took turns, two staged the same
 * change and the second commit found nothing left: `git commit … failed:` with
 * no reason, in the log of an installed app.
 *
 *   pnpm build:backend && pnpm --filter @tomrade/desktop test:storage-race
 */
import { app } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(dir, "../tomrade.yml");
const patches = [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "storage", config: { reconcileMs: 2_000 } }]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const idleIndex = process.argv.indexOf("--idle-instance");
const work = idleIndex > 0 ? process.argv[idleIndex + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-storage-race-"));
app.setPath("userData", work);

// Every git this process (and the idle instance) starts goes through the slow one.
const slow = path.join(work, "slow-git");
if (idleIndex < 0) {
  fs.mkdirSync(slow, { recursive: true });
  const real = execFileSync("/usr/bin/env", ["which", "git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(slow, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in fetch|ls-remote|push) sleep 1.5; break;; esac; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
}
process.env.PATH = `${slow}${path.delimiter}${process.env.PATH}`;

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${!cond && detail ? `\n  ${detail}` : ""}`);
};

async function idleInstance() {
  const { ctx } = await boot({ configFile, vars: { userData: work }, patches });
  await ctx.storage.ready;
  fs.writeFileSync(path.join(work, "idle-ready"), String(process.pid));
  for (let i = 0; i < 1200 && !fs.existsSync(path.join(work, "idle-stop")); i++) await sleep(100);
  app.exit(0);
}

async function run() {
  const { ctx } = await boot({ configFile, vars: { userData: work }, patches });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const p of ctx.projects.list()) ctx.projects.remove(p.id);
  const remote = path.join(work, "remote.git");
  fs.mkdirSync(remote, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", "."], { cwd: remote });
  const project = ctx.projects.create({ name: "Race", keyPrefix: "RAC" });
  for (let i = 0; i < 50 && !ctx.hub.catalog.project(project.id)?.dir; i++) await sleep(50);
  const board = ctx.boards.defaultFor(project.id);
  ctx.items.create({ projectId: project.id, boardId: board.id, title: "already there", by: "human" });
  await ctx.storage.bind(project.id, "git", { remote, branch: "main" });
  await ctx.storage.publish(project.id);

  let idle = null;
  if (process.argv.includes("--second-instance")) {
    idle = spawn(process.execPath, [fileURLToPath(import.meta.url), "--idle-instance", work], { stdio: ["ignore", "ignore", "inherit"] });
    for (let i = 0; i < 300 && !fs.existsSync(path.join(work, "idle-ready")); i++) await sleep(100);
    check("a second instance boots on the same userData", fs.existsSync(path.join(work, "idle-ready")));
  }

  const made = [];
  for (let i = 0; i < 30; i++) {
    made.push(ctx.items.create({ projectId: project.id, boardId: board.id, title: `written during reconcile ${i + 1}`, by: "ai:mcp" }).key);
    await sleep(700);
  }
  // past the idle snapshot and a few more reconcile rounds
  await sleep(12_000);

  const inCache = new Set(ctx.items.list({ projectId: project.id }).map((i) => i.key));
  const folder = path.join(ctx.hub.catalog.project(project.id).dir, ".tomrade/state/items.jsonl");
  const inFolder = new Set(fs.readFileSync(folder, "utf8").split("\n").filter(Boolean).map((l) => `RAC-${JSON.parse(l).key_num}`));
  const lostCache = made.filter((k) => !inCache.has(k));
  const lostFolder = made.filter((k) => !inFolder.has(k));
  check("every ticket written during a slow reconcile stays in the cache", lostCache.length === 0, `lost: ${lostCache.join(", ")}`);
  check("and reaches the folder's snapshot", lostFolder.length === 0, `lost: ${lostFolder.join(", ")}`);
  check("the folder ends in step with the cache", (await ctx.storage.statusFor(project.id)).state === "synced");

  const warnings = [];
  ctx.logger.exporter({ colors: 0, export: (m) => m.type === "warn" && warnings.push(m.args.map(String).join(" ")) });
  const rejected = [];
  for (let i = 0; i < 3; i++) {
    ctx.items.create({ projectId: project.id, boardId: board.id, title: `published from every side ${i + 1}`, by: "human" });
    const met = await Promise.allSettled([ctx.storage.publish(project.id, "write"), ctx.storage.reconcileAll("reconcile"), ctx.storage.publish(project.id, "catch-up"), ctx.storage.flushAll("quit")]);
    rejected.push(...met.filter((o) => o.status === "rejected").map((o) => String(o.reason?.message ?? o.reason)));
  }
  const gitFailures = warnings.filter((w) => /git .* failed/.test(w));
  check("publishes that meet all go through", rejected.length === 0, rejected.join("\n  "));
  check("and no git command fails meanwhile", gitFailures.length === 0, gitFailures.join("\n  "));
  // Once the turns queued so far are through, with nothing left to write: no step of a publish is caught half-way.
  await ctx.storage.publish(project.id, "check");
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const projectDir = ctx.hub.catalog.project(project.id).dir;
  const onRemote = git(["show", "main:.tomrade/state/items.jsonl"], remote);
  const committed = git(["status", "--porcelain", "--", ".tomrade"], projectDir).trim() === "" && git(["rev-parse", "HEAD"], projectDir) === git(["rev-parse", "main"], remote);
  check("every one of them is committed and pushed", committed && [1, 2, 3].every((i) => onRemote.includes(`published from every side ${i}`)));
  check("and the project reads synced", (await ctx.storage.statusFor(project.id)).state === "synced");

  fs.writeFileSync(path.join(work, "idle-stop"), "1");
  await sleep(300);
  idle?.kill();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.rmSync(work, { recursive: true, force: true });
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(() => (idleIndex > 0 ? idleInstance() : run())).catch((e) => {
  console.error(e);
  app.exit(1);
});
