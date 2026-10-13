/** Run after pnpm build:backend and pnpm dev:ui (TOMRADE_DEV_URL may override the UI URL). */
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexStep } from "../../../packages/engine-codex/dist/steps.js";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-commands-"));
app.setPath("userData", work);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ctx;
let win;

async function run() {
  ({ ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] }));
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const project = ctx.projects.create({ name: "Command results", keyPrefix: "CR" });
  await ctx.storage.ready;
  const cases = [
    { command: "rg missing src", status: "failed", exitCode: 1, aggregatedOutput: "" },
    { command: "npm test", status: "failed", exitCode: 1, aggregatedOutput: "first line\nFAIL: assertion\n" },
    { command: "npm test", status: "failed", exitCode: 2, aggregatedOutput: "" },
    { command: "npm test", status: "declined", exitCode: null },
    { command: "npm test", status: "failed", exitCode: 124 },
    { command: "npm test", status: "interrupted", exitCode: null }
  ];
  ctx.agent.engine({ id: "commands", title: "Commands", author: "ai:commands", available: async () => ({ ok: true }),
    async turn(_input, io) {
      for (const item of cases) {
        const { label: _, ...step } = codexStep({ type: "commandExecution", ...item });
        io.emit({ type: "trace", ...step });
      }
      return { stop: "end" };
    } });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "commands" } });
  const thread = ctx.agent.newThread(project.id, "commands");
  ctx.agent.send(project.id, thread.id, { kind: "text", text: "show command results" });
  win = new BrowserWindow({ width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = code => win.webContents.executeJavaScript(code, true);
  await $(`localStorage.setItem(${JSON.stringify(`tomrade.agent.thread.${project.id}`)}, ${JSON.stringify(thread.id)}); location.reload(); true`);
  for (const language of ["en", "zh"]) {
    ctx.settings.set({ ...ctx.settings.get(), language });
    const labels = language === "en" ? ["No matches", "Command failed", "Command failed", "Declined", "Timed out", "Interrupted"]
      : ["无匹配", "命令失败", "命令失败", "被拒绝", "超时", "中断"];
    let rows;
    for (let tries = 0; tries < 100; tries++) {
      rows = await $(`(() => { const rows = [...document.querySelectorAll('.trace-row')]; rows.forEach(row => { row.open = true; });
        return rows.map(row => ({ failed: row.classList.contains('failed'), summary: row.querySelector('summary').textContent,
          detail: [...row.querySelectorAll('pre')].map(pre => pre.textContent).join('\\n') })); })()`);
      if (rows.length === 6 && rows.every((row, i) => row.summary.includes(labels[i])) && rows.every(row => row.detail.includes("npm test") || row.detail.includes("rg missing"))) break;
      await sleep(100);
    }
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map(row => row.failed), [false, true, true, false, false, false]);
    rows.forEach((row, i) => assert.ok(row.summary.includes(labels[i]), row.summary));
    assert.ok(rows[1].detail.includes("FAIL: assertion"));
    assert.ok(rows[1].detail.includes(language === "en" ? "Exit code: 1" : "退出码：1"));
    assert.ok(rows[2].detail.includes(language === "en" ? "Exit code: 2" : "退出码：2"));
    assert.ok(rows[2].detail.includes(language === "en" ? "No output" : "无输出"));
    assert.ok(rows[5].detail.includes(language === "en" ? "Exit code: unavailable" : "退出码：未收到"));
    console.log(`PASS: ${language} command labels, neutral icons, exit codes, output and empty output`);
  }
}

app.whenReady().then(run).then(async () => {
  win?.destroy(); fs.rmSync(work, { recursive: true, force: true }); app.exit(0);
}).catch(async error => { console.error(error); win?.destroy(); fs.rmSync(work, { recursive: true, force: true }); app.exit(1); });
