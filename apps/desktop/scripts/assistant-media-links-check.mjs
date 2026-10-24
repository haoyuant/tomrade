/** Assistant conversation: pictures and PDFs as thumbnails that open at full size, links and paths that open outside.
 * Start the UI dev server, then run Electron scripts/assistant-media-links-check.mjs.
 */
import { app, BrowserWindow, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-assistant-links-"));
app.setPath("userData", work);
const checks = [];
const check = (name, pass) => { checks.push({ name, pass: !!pass }); console.log(`${pass ? "PASS" : "FAIL"}: ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let modelServer;
let ctx;
let win;

function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 24 Tf 40 300 Td (Quarterly) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

async function run() {
  const onDisk = path.join(work, "report.txt");
  fs.writeFileSync(onDisk, "hello");
  const opened = { external: [], paths: [], revealed: [] };
  // the check must not launch a browser or Finder; the shell's own guards still run before these
  shell.openExternal = async url => { opened.external.push(url); };
  shell.openPath = async target => { opened.paths.push(target); return ""; };
  shell.showItemInFolder = target => { opened.revealed.push(target); };
  let bigPng = "";
  modelServer = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const last = JSON.parse(raw).messages.at(-1);
    const asked = JSON.stringify(last.content);
    const delta = asked.includes("Links please")
      ? { content: `Docs: https://example.com/guide?a=1. 文件：\`${onDisk}\`，还有 [the manual](https://example.com/manual) and /api/v1 stays text, missing ${path.join(work, "gone.txt")}.` }
      : asked.includes("Show the PDF") ? (await sleep(1500), { content: "The report" })
      : asked.includes("Draw big") ? { content: "Here it is", images: [{ image_url: { url: `data:image/png;base64,${bigPng}` } }] }
      : { content: "Received." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve));
  ({ ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]]
  }));
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Links regression", keyPrefix: "LNK" });
  await ctx.storage.ready;
  const baseURL = `http://127.0.0.1:${modelServer.address().port}/v1`;
  ctx.settings.set({ ...ctx.settings.get(),
    models: { profiles: [{ id: "media", title: "Multimodal test", provider: "openai-compatible", baseURL, model: "media", apiKey: "", inputModalities: ["image"], outputModalities: ["image"] }], roles: { worker: "media" } },
    agent: { defaultEngine: "tomrade", confirmWritesOver: 0, engines: { tomrade: { profile: "media" } }, playbookChoices: {} }
  });
  win = new BrowserWindow({ width: 1400, height: 950, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", event => { if (event.level === "error") console.log(`[renderer] ${event.message}`); });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5189/");
  const $ = js => win.webContents.executeJavaScript(js, true);
  const wait = async (predicate, name) => {
    for (let i = 0; i < 150; i++) { if (await predicate()) return; await sleep(100); }
    throw new Error(`Timed out: ${name}`);
  };
  await wait(() => $("!!document.querySelector('.proj')"), "project home");
  await $(`location.hash = '#/p/${project.id}'; true`);
  await wait(() => $("!!document.querySelector('.ai-input')"), "assistant composer");
  const send = async text => {
    await $(`(() => { const input = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(50);
    await $("document.querySelector('.ai-send').click()");
  };

  await send("Links please");
  await wait(() => $("document.querySelectorAll('.turn-ai .tlink').length >= 4"), "links in reply");
  await wait(() => !ctx.agent.activeRuns().length, "links run finish");
  const links = await $("[...document.querySelectorAll('.turn-ai .tlink')].map(a => a.textContent)");
  check("web URL, markdown link, quoted path and bare path are links; a route is not", links.length === 4 && links[0] === "https://example.com/guide?a=1" && links[2] === "the manual" && !links.some(l => l.includes("/api/v1")));
  check("sentence punctuation stays outside the link", await $("document.querySelector('.turn-ai p').textContent.includes('a=1. ')"));
  const url = await win.webContents.getURL();
  await $("document.querySelector('.turn-ai .tlink').click()");
  await wait(() => opened.external.length === 1, "openExternal");
  check("web link opens in the system browser", opened.external[0] === "https://example.com/guide?a=1" && win.webContents.getURL() === url);
  await $("[...document.querySelectorAll('.turn-ai .tlink')].find(a => a.textContent.includes('report.txt')).click()");
  await wait(() => opened.paths.length === 1, "openPath");
  check("file path opens with the system app", opened.paths[0] === onDisk);
  await $("[...document.querySelectorAll('.turn-ai .tlink')].find(a => a.textContent.includes('gone.txt')).click()");
  await wait(() => $("document.body.textContent.includes('on this computer')"), "missing-path toast");
  check("a missing path says so and opens nothing", opened.paths.length === 1);

  bigPng = await $("(() => { const c = document.createElement('canvas'); c.width = 1800; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#2a6'; g.fillRect(0, 0, 1800, 1200); g.fillStyle = '#fff'; g.fillRect(100, 100, 400, 300); return c.toDataURL('image/png').split(',')[1]; })()");
  await send("Draw big");
  await wait(() => $("!!document.querySelector('.turn-ai figure .media-thumb img')?.complete"), "image thumbnail");
  await wait(() => !ctx.agent.activeRuns().length, "image run finish");
  const thumb = await $("(() => { const r = document.querySelector('.turn-ai figure .media-thumb img').getBoundingClientRect(); return { w: r.width, h: r.height }; })()");
  check("image shows as a bounded thumbnail", thumb.w > 100 && thumb.w <= 320 && thumb.h <= 240);
  check("the thumbnail's frame hugs the picture", await $("(() => { const b = document.querySelector('.turn-ai figure .media-thumb'); return b.getBoundingClientRect().width - b.querySelector('img').getBoundingClientRect().width <= 3; })()"));
  await $("document.querySelector('.turn-ai figure .media-thumb').click()");
  await wait(() => $("!!document.querySelector('.sheet-image .media-stage img')?.complete"), "full-size dialog");
  await sleep(200);
  const full = await $("(() => { const img = document.querySelector('.sheet-image .media-stage img'); const stage = img.parentElement; return { w: img.getBoundingClientRect().width, natural: img.naturalWidth, scrolls: stage.scrollWidth > stage.clientWidth }; })()");
  check("click opens the image at its original size, scrollable", Math.round(full.w) === full.natural && full.natural === 1800 && full.scrolls);
  fs.writeFileSync(path.join(work, "image-original.png"), (await win.webContents.capturePage()).toPNG());
  await $("document.querySelector('.sheet-image .media-stage img').click()");
  await sleep(100);
  check("clicking the original fits it to the window", await $("(() => { const img = document.querySelector('.sheet-image .media-stage img'); return img.getBoundingClientRect().width < 1800 && img.parentElement.scrollWidth <= img.parentElement.clientWidth; })()"));
  await $("document.querySelector('.sheet-image .dlg-head button').click()");
  await wait(() => $("!document.querySelector('.sheet-image')"), "dialog closed");

  // a model has no PDF output of its own; a local agent's display_media publishes one into the running turn
  await send("Show the PDF");
  await wait(() => ctx.agent.activeRuns().length > 0, "PDF run");
  ctx.agent.publishMedia(ctx.agent.activeRuns()[0].run.id, { name: "quarterly.pdf", mime: "application/pdf", base64: minimalPdf() }, "Quarterly report");
  await wait(() => $("!!document.querySelector('.turn-ai figure .media-thumb.is-doc iframe')"), "PDF thumbnail");
  await wait(() => !ctx.agent.activeRuns().length, "pdf run finish");
  const doc = await $("(() => { const r = document.querySelector('.turn-ai .media-thumb.is-doc').getBoundingClientRect(); return { w: r.width, h: r.height }; })()");
  check("PDF shows as a page-sized thumbnail", doc.w <= 220 && doc.h <= 290 && doc.h > 200);
  await sleep(800);
  fs.writeFileSync(path.join(work, "pdf-thumbnail.png"), (await win.webContents.capturePage()).toPNG());
  await $("document.querySelector('.turn-ai .media-thumb.is-doc').click()");
  await wait(() => $("!!document.querySelector('.sheet-image iframe.media-doc-full')"), "PDF dialog");
  check("click opens the whole PDF in a window-sized sheet", await $("document.querySelector('.sheet-image iframe.media-doc-full').getBoundingClientRect().height > 500"));
  await sleep(800);
  fs.writeFileSync(path.join(work, "pdf-full.png"), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  try { await run(); } catch (error) { console.error(error); check("harness completed", false); }
  finally {
    win?.destroy();
    await ctx?.fiber.dispose();
    modelServer?.close();
    console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed; screenshots: ${work}`);
    app.exit(checks.some(c => !c.pass) ? 1 : 0);
  }
});
