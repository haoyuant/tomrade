/** Isolated renderer + IPC regression. Run after build:backend with the UI dev server running. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-ui-"));
app.setPath("userData", work);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (name, value) => { if (!value) throw new Error(name); console.log(`PASS: ${name}`); };
let ctx;
let win;
app.whenReady().then(async () => {
  try {
    ({ ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] }));
    ctx.hub.configure(path.join(work, "hub"));
    const project = ctx.projects.create({ name: "Herdr regression", keyPrefix: "HDR" });
    const board = ctx.boards.list(project.id)[0];
    const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Herdr readiness", workType: "coding", status: "todo", by: "human" });
    ctx.agent.engine({ id: "ready", title: "Ready", author: "ai:ready", capabilities: ["code"], available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
    ctx.settings.set({ ...ctx.settings.get(), language: "zh", onboarding: { seen: ["*"] }, agent: { ...ctx.settings.get().agent, defaultEngine: "ready" } });
    assert("默认终端是自动", ctx.settings.get().codeLink.terminal === "auto");
    for (const locale of ["en", "zh", "fr"]) {
      const field = ctx.settings.sections(locale).find(s => s.id === "codeLink").schema.properties.terminal;
      assert(`${locale} 终端选项以自动开头并有说明`, field.enum[0] === "auto" && !!field.enumLabels?.auto);
      const help = field.description;
      assert(`${locale} 设置说明包含安装和启动命令`, help.includes("brew install herdr") && help.includes("`herdr`"));
      assert(`${locale} 设置说明不含错误插件命令`, !help.includes("plugin install"));
    }
    let state = "notInstalled";
    ctx.codeLink.herdrStatus = async () => state;
    win = new BrowserWindow({ width: 1200, height: 900, show: true, webPreferences: { backgroundThrottling: false, preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
    await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
    const js = code => win.webContents.executeJavaScript(code, true);
    const wait = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100); } throw new Error("界面等待超时"); };
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-ticket"]')`));
    await js(`document.querySelector('[data-testid="start-ticket"]').click(); true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-mode"]')`));
    await js(`document.querySelectorAll('[data-testid="start-mode"] button')[1].click(); true`);
    const line = () => js(`document.querySelector('[data-testid="start-herdr-status"]')?.textContent ?? ''`);
    await wait(async () => (await line()).includes("未安装"));
    assert("未安装时显示安装和启动指引", (await line()).includes("brew install herdr") && (await line()).includes("打开一个终端"));
    await wait(() => js(`!![...document.querySelectorAll('#stEngine option')].find(o => o.value === 'ready')`));
    await js(`const select = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'ready'); select.dispatchEvent(new Event('change', { bubbles: true })); true`);
    await wait(() => js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
    assert("未安装 herdr 不阻断开始", await js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
    fs.writeFileSync(path.join(work, "herdr-missing.png"), (await win.webContents.capturePage()).toPNG());
    state = "notRunning";
    await wait(async () => (await line()).includes("已安装未运行"));
    state = "running";
    await wait(async () => (await line()).includes("运行中"));
    assert("运行中不再显示安装指引", !(await line()).includes("brew install"));
    await js(`document.querySelectorAll('[data-testid="start-mode"] button')[0].click(); true`);
    await wait(() => js(`!document.querySelector('[data-testid="start-herdr-status"]')`));
    console.log(`界面截图：${work}`);
    win.destroy();
    await ctx.fiber.dispose();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (win) console.error(await win.webContents.executeJavaScript("document.body.innerText"));
    console.error(`测试目录：${work}`);
    app.exit(1);
  }
});
