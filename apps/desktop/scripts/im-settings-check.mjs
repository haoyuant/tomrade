/**
 * IM settings without JSON: connect a bot from the wizard, pair yourself from a
 * direct message, talk, let an ignored person in, and retry a stuck reply — all
 * through the settings pane, against a stand-in platform adapter.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:im-settings
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-im-settings-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const TOKEN = "xoxb-im-settings-check-token";

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });

  ctx.agent.engine({ id: "echo", title: "Echo", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input, io) { io.emit({ type: "text", text: `echo: ${input.input.kind === "text" ? input.input.text : ""}` }); return { stop: "end" }; } });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "echo" } });

  // The stand-in platform: it signs in only with the right token, and records what it is asked to send.
  let receive;
  let failing = false;
  const sent = [];
  let opened;
  ctx.im.register({
    id: "standin", title: "Stand-in Chat",
    capabilities: { edit: false, buttons: false, inboundFiles: false, outboundFiles: false, maxTextLength: 4000, maxFileBytes: 0 },
    setup: {
      fields: [{ key: "botToken", label: { en: "Bot token", zh: "机器人令牌" }, secret: true, placeholder: "xoxb-…" }],
      steps: [{ en: "Create an app and install it to your workspace.", zh: "创建应用并安装到工作区。" }],
      permissions: ["chat:write", "im:history"],
      groupSteps: [{ en: "Invite the bot to a channel.", zh: "把机器人邀请进频道。" }, { en: "Run /standin setup there.", zh: "在那里运行 /standin setup。" }]
    },
    async open(_id, io) {
      opened = io.credentials;
      if (io.credentials.botToken !== TOKEN) throw new Error("invalid_auth");
      receive = io.receive;
      return {
        identity: { id: "B01", name: "@tomrade-bot" },
        describe: async (a) => (a.conversationId === "C-dev" ? { name: "#dev-room" } : a.conversationId === "D-owner" ? { name: "owner-dm" } : null),
        deliver: async (d) => {
          if (failing) throw Object.assign(new Error("timeout"), { disposition: "uncertain" });
          sent.push(d);
          return { messageId: `m-${sent.length}` };
        },
        close: () => { receive = undefined; }
      };
    }
  });
  const dm = (id, text, actor = "U-owner", conversation = "D-owner") => receive({ kind: "message", eventId: id, messageId: id, text, activation: "dm",
    actor: { id: actor, name: actor === "U-owner" ? "Owner" : "Teammate", isBot: false }, address: { tenantId: "T1", conversationId: conversation } });

  const win = new BrowserWindow({ width: 1400, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const fill = (selector, text) =>
    $(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const button = (text, scope = "document") => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent?.trim() === ${JSON.stringify(text)})`;
  const waitFor = async (js, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await $(js)) return true;
      await sleep(100);
    }
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS ?? work, name), (await win.webContents.capturePage()).toPNG());
  await sleep(2000);

  // ── connect a bot from the wizard ────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await sleep(800);
  check("settings list an IM pane", await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((r) => r.textContent?.trim() === 'IM')`));
  await waitFor(`!!document.querySelector('[data-testid=im-add]')`);
  check("the pane says where credentials are kept", (await $(`document.querySelector('[data-testid=im-secret-storage]')?.textContent ?? ''`)).length > 0);
  await press(`document.querySelector('[data-testid=im-add]')`);
  await waitFor(`!!document.querySelector('#im-cred-botToken')`);
  // Installed platforms come first in the list; this check drives the stand-in.
  await $(`(() => { const s = document.querySelector('#im-adapter'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'standin'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(`document.querySelector('[data-testid=im-form]')?.textContent.includes('Create an app')`);
  const form = await $(`document.querySelector('[data-testid=im-form]').textContent`);
  check("the wizard shows the platform's steps and permissions", form.includes("Create an app") && form.includes("chat:write"), form);
  check("a secret field is a password field", (await $(`document.querySelector('#im-cred-botToken').type`)) === "password");
  await fill("#im-id", "team");
  await fill("#im-cred-botToken", "wrong-token");
  await sleep(150);
  await $(`document.querySelector('[data-testid=im-plaintext-consent]')?.click();true`);
  await sleep(100);
  await press(button("Save and connect"));
  check("a refused token shows the connection failed", await waitFor(`document.querySelector('[data-im-connection=team]')?.dataset.state === 'error'`));
  await press(`document.querySelector('[data-im-connection=team] [aria-label=Edit]')`);
  await waitFor(`!!document.querySelector('#im-cred-botToken')`);
  await fill("#im-cred-botToken", TOKEN);
  await sleep(150);
  await $(`document.querySelector('[data-testid=im-plaintext-consent]')?.click();true`);
  await sleep(100);
  await press(button("Save and connect"));
  check("the right token connects", await waitFor(`document.querySelector('[data-im-connection=team]')?.dataset.state === 'connected'`), opened);
  check("and the card names the bot it signed in as", await waitFor(`document.querySelector('[data-im-connection=team]')?.textContent.includes('Signed in as @tomrade-bot')`));
  const file = fs.readFileSync(path.join(work, "settings.json"), "utf8");
  const storage = ctx.settings.secretStorage();
  check(storage === "keychain" ? "settings.json keeps the token sealed" : "without a keychain the token is plain, as the pane says",
    storage === "keychain" ? !file.includes(TOKEN) && file.includes("tomrade-encrypted:v1:") : file.includes(TOKEN), storage);
  await shot("im-connected.png");

  // ── pair yourself ────────────────────────────────────────────────────
  check("pairing waits behind Add a person", !(await $(`!!document.querySelector('[data-testid=im-pair-start]')`)) && await press(`document.querySelector('[data-testid=im-pair-add]')`));
  await waitFor(`!!document.querySelector('[data-testid=im-pair-start]')`);
  await press(`document.querySelector('[data-testid=im-pair-start]')`);
  await waitFor(`!!document.querySelector('[data-testid=im-pair-code]')`);
  const code = (await $(`document.querySelector('[data-testid=im-pair-code] .mono').textContent`)).replace("/pair ", "").trim();
  check("the pane shows a six-digit code", /^\d{6}$/.test(code), code);
  await dm("p1", `/pair ${code}`);
  check("the desktop asks who sent it", await waitFor(`document.querySelector('[data-testid=im-pair-confirm]') && document.querySelector('[data-testid=im-people]').textContent.includes('Owner')`));
  check("the bot tells them to confirm on the desktop", sent.at(-1)?.content.text.includes("Confirm the pairing"), sent.at(-1));
  await shot("im-pair-claim.png");
  await press(`document.querySelector('[data-testid=im-pair-confirm]')`);
  check("confirming lists them as paired", await waitFor(`document.querySelector('[data-testid=im-people]')?.textContent.includes('U-owner') && !!${button("Revoke")}`));
  check("and connects their direct chat to the project", await waitFor(`!!document.querySelector('[data-im-route]')`));
  check("a conversation is one line, saying where it goes, until opened", await waitFor(`document.querySelector('[data-im-route] [data-testid=im-route-summary]')?.textContent === 'Alpha · Project default'
    && !document.querySelector('[data-im-route] [id$=-project]')`), await $(`document.querySelector('[data-im-route]')?.textContent`));

  // ── the pane's order, and a bot folds ────────────────────────────────
  check("what conversations hear comes before the bots",
    await $(`!!(document.querySelector('[data-testid=im-notify]')?.compareDocumentPosition(document.querySelector('[data-testid=im-bots]')) & Node.DOCUMENT_POSITION_FOLLOWING)`));
  check("a bot's fold chevron sits outside its card, on the left", await $(`(() => {
    const fold = document.querySelector('[data-im-connection=team] [data-testid=im-fold]');
    const card = document.querySelector('[data-im-connection=team] .cfg-row');
    return !!fold && !!card && !card.contains(fold) && fold.getBoundingClientRect().right <= card.getBoundingClientRect().left;
  })()`));
  await press(`document.querySelector('[data-im-connection=team] [data-testid=im-fold]')`);
  check("folding a bot hides its pairing and conversations", await waitFor(`document.querySelector('[data-im-connection=team] [data-testid=im-fold]')?.getAttribute('aria-expanded') === 'false'
    && !document.querySelector('[data-im-connection=team] [data-im-route]') && !document.querySelector('[data-im-connection=team] [data-testid=im-people]')`));
  check("and its card says what is folded away", await waitFor(`document.querySelector('[data-im-connection=team] [data-testid=im-folded-summary]')?.textContent === 'Conversations: 1 · Paired: 1'`),
    await $(`document.querySelector('[data-im-connection=team] [data-testid=im-folded-summary]')?.textContent`));
  await $(`document.querySelector('[data-testid=im-bots]')?.scrollIntoView({ block: 'start' });true`);
  await sleep(200);
  await shot("im-folded.png");
  await press(`document.querySelector('[data-im-connection=team] [data-testid=im-fold]')`);
  check("and unfolding shows them again", await waitFor(`!!document.querySelector('[data-im-connection=team] [data-im-route]')`));
  await $(`document.querySelector('[data-testid=im-bots]')?.scrollIntoView({ block: 'start' });true`);
  await sleep(200);
  await shot("im-unfolded.png");

  // ── what conversations hear ──────────────────────────────────────────
  const imNow = () => ctx.settings.get().im;
  const until = async (cond, ms = 4000) => { for (let waited = 0; waited < ms && !cond(); waited += 100) await sleep(100); return cond(); };
  check("what every conversation hears is one line until opened", await waitFor(`document.querySelector('[data-testid=im-notify-summary]')?.textContent.startsWith('On: ') && !document.querySelector('[data-im-notify-kind]')`),
    await $(`document.querySelector('[data-testid=im-notify-summary]')?.textContent`));
  await press(`document.querySelector('[data-testid=im-notify-fold]')`);
  await press(`document.querySelector('[data-im-route] [data-testid=im-route-fold]')`);
  check("opening a conversation shows its settings", await waitFor(`!!document.querySelector('[data-im-route] [id$=-project]')`));
  check("a new conversation follows what every conversation hears", imNow().routes[0]?.notify === undefined && await waitFor(`document.querySelector('[data-im-notify] [role=switch]')?.getAttribute('aria-checked') === 'true'`), imNow().routes[0]);
  await press(`document.querySelector('[data-im-notify-kind=routines] [role=switch]')`);
  check("one switch turns a kind on for every conversation", await until(() => imNow().notify.routines === true), imNow().notify);
  await $(`document.querySelector('[data-testid=im-notify]')?.scrollIntoView({ block: 'center' });true`);
  await sleep(200);
  await shot("im-notify-shared.png");
  await press(`document.querySelector('[data-im-notify] [role=switch]')`);
  check("a conversation can choose for itself", await waitFor(`document.querySelectorAll('[data-im-notify] [role=switch]').length === 6`) && await until(() => imNow().routes[0]?.notify?.routines === true), imNow().routes[0]);
  await press(`[...document.querySelectorAll('[data-im-notify] [role=switch]')].find((s) => s.getAttribute('aria-label') === 'Routines as they run')`);
  check("and its choice stays its own", await until(() => imNow().routes[0]?.notify?.routines === false && imNow().notify.routines === true), imNow());
  await $(`document.querySelector('[data-im-notify]')?.scrollIntoView({ block: 'center' });true`);
  await sleep(200);
  await shot("im-notify-route.png");
  await press(`document.querySelector('[data-im-notify] [role=switch]')`);
  check("following again drops it", await waitFor(`document.querySelectorAll('[data-im-notify] [role=switch]').length === 1`) && await until(() => imNow().routes[0]?.notify === undefined), imNow().routes[0]);

  // ── talk ─────────────────────────────────────────────────────────────
  await dm("m1", "hello there");
  const replied = async (text) => { for (let i = 0; i < 80 && !sent.some((d) => d.content.text === text); i++) await sleep(100); return sent.some((d) => d.content.text === text); };
  check("a direct message reaches the assistant and is answered", await replied("echo: hello there"), sent.map((d) => d.content.text));

  // ── let an ignored person in ─────────────────────────────────────────
  await dm("t1", "PRIVATE BODY", "U-mate", "D-mate");
  check("an unknown sender shows as ignored, without the message", await waitFor(`document.querySelector('[data-testid=im-ignored]')?.textContent.includes('U-mate')`)
    && !(await $(`document.body.textContent.includes('PRIVATE BODY')`)));
  await press(button("Allow this person", "document.querySelector('[data-testid=im-ignored]')"));
  check("one click lets them in", await waitFor(`!document.querySelector('[data-testid=im-ignored]').textContent.includes('U-mate')`));
  await dm("t2", "hi from mate", "U-mate", "D-mate");
  check("and they are answered", await replied("echo: hi from mate"));

  // ── a stuck reply ────────────────────────────────────────────────────
  failing = true;
  await dm("m2", "will it arrive");
  check("an uncertain reply is listed", await waitFor(`document.querySelector('[data-testid=im-deliveries]')?.textContent.includes('echo: will it arrive')`, 10000));
  await shot("im-delivery.png");
  failing = false;
  await press(button("Retry", "document.querySelector('[data-testid=im-deliveries]')"));
  check("retrying sends it", await replied("echo: will it arrive"));
  check("and clears the list", await waitFor(`!document.querySelector('[data-testid=im-deliveries]').textContent.includes('echo: will it arrive')`));

  // ── using it in a group ──────────────────────────────────────────────
  const guide = `document.querySelector('[data-im-connection=team] [data-testid=im-group-guide]')`;
  check("a connected bot says how to use it in a group, in its platform's steps, then what each channel does", await waitFor(`${guide}?.textContent.includes('Run /standin setup there.')
    && ${guide}.textContent.includes('Work channel: each ticket in Doing or Verifying gets a thread of its own')`), await $(`${guide}?.textContent`));
  check("with only direct chats connected, it says ticket threads need a group", await waitFor(`!!document.querySelector('[data-im-connection=team] [data-testid=im-only-direct]')`));
  await $(`${guide}?.scrollIntoView({ block: 'center' });true`);
  await sleep(200);
  await shot("im-group-guide.png");
  ctx.settings.set({ ...ctx.settings.get(), im: { ...imNow(), routes: [...imNow().routes, { ...imNow().routes[0], id: "dev", kind: "group", conversationId: "C-dev", allowDirectMessages: false, allowGroups: true, ticketTopics: true, groupActivation: "reply", notify: { tickets: true, code: true } }] } });
  check("an allowed group is listed with what it is for", await waitFor(`document.querySelector('[data-im-connection=team] [data-testid=im-group-channels]')?.textContent === '#dev-room: work (a thread per ticket)'`),
    await $(`document.querySelector('[data-im-connection=team] [data-testid=im-group-channels]')?.textContent`));
  check("and the direct-chat-only hint goes", await waitFor(`!document.querySelector('[data-im-connection=team] [data-testid=im-only-direct]')`));

  // ── a direct chat stays one ──────────────────────────────────────────
  const dmRoute = imNow().routes.find((r) => r.id !== "dev");
  ctx.settings.set({ ...ctx.settings.get(), im: { ...imNow(), routes: imNow().routes.map((r) => r.id === dmRoute.id ? { ...r, allowGroups: true } : r) } });
  const route = (rid) => `document.querySelector('[data-im-route="${rid}"]')`;
  const switches = (rid) => `[...${route(rid)}.querySelectorAll('[role=switch]')].map((s) => s.getAttribute('aria-label'))`;
  check("a direct chat with the group switch on is still tagged a direct chat, without the group switches", await waitFor(`${route(dmRoute.id)}?.querySelector('.tag, [class*=tag]')?.textContent === 'Direct chat'
    && !${switches(dmRoute.id)}.includes('Group messages') && !${switches(dmRoute.id)}.includes('A thread per ticket') && !${switches(dmRoute.id)}.includes('Recent discussion window')
    && !${route(dmRoute.id)}.querySelector('#im-route-${dmRoute.id}-activation')`), await $(`${switches(dmRoute.id)}`));
  check("a group goes by its name, the id a tooltip, and a direct chat by the person in it", await waitFor(`${route("dev")}?.querySelector('[data-testid=im-route-name]')?.textContent === '#dev-room'
    && ${route("dev")}.querySelector('[data-testid=im-route-name]').title === 'C-dev'
    && ${route(dmRoute.id)}?.querySelector('[data-testid=im-route-name]')?.textContent === 'Owner' && ${route(dmRoute.id)}.querySelector('[data-testid=im-route-name]').title === 'D-owner'`),
    await $(`[...document.querySelectorAll('[data-testid=im-route-name]')].map((n) => [n.textContent, n.title])`));
  check("a group is one line saying what it is for", await waitFor(`${route("dev")}?.querySelector('[data-testid=im-route-summary]')?.textContent === 'work (a thread per ticket) · Alpha · 1 allowed'`),
    await $(`${route("dev")}?.querySelector('[data-testid=im-route-summary]')?.textContent`));
  await press(`${route("dev")}.querySelector('[data-testid=im-route-fold]')`);
  const purpose = `document.querySelector('#im-route-dev-purpose')`;
  check("opened, a group is set by what it is for, without the direct-chat switches or the ones its purpose stands for", await waitFor(`${purpose}?.value === 'work'
    && !${switches("dev")}.includes('Direct messages') && !${switches("dev")}.includes('Desktop turns in direct chat') && !${switches("dev")}.includes('A thread per ticket') && !${switches("dev")}.includes('Group messages')`),
    await $(`${switches("dev")}`));
  const select = (value) => $(`(() => { const s = ${purpose}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const dev = () => imNow().routes.find((r) => r.id === "dev");
  const PRESETS = { status: { ticketTopics: false, groupActivation: "mention", notify: { tickets: true, code: true, routines: true, presence: true } },
    chat: { ticketTopics: false, groupActivation: "reply", notify: { tickets: false, code: false, routines: false } },
    work: { ticketTopics: true, groupActivation: "reply", notify: { tickets: true, code: true } } };
  for (const [value, fields] of Object.entries(PRESETS)) {
    await select(value);
    check(`choosing ${value} sets the route as that preset`, await until(() => JSON.stringify({ ticketTopics: dev()?.ticketTopics, groupActivation: dev()?.groupActivation, notify: dev()?.notify }) === JSON.stringify(fields)), dev());
  }
  await select("custom");
  check("Custom shows the switches the purposes stand for", await waitFor(`${switches("dev")}.includes('A thread per ticket') && !!document.querySelector('#im-route-dev-activation') && !!${route("dev")}.querySelector('[data-im-notify]')`),
    await $(`${switches("dev")}`));
  await press(`${route("dev")}.querySelector('[data-testid=im-route-on]')`);
  check("one switch lets a conversation in or out", await until(() => dev()?.allowGroups === false) && await waitFor(`${route("dev")}.querySelector('.cfg-row').classList.contains('off')`), dev());
  await press(`${route("dev")}.querySelector('[data-testid=im-route-on]')`);
  await until(() => dev()?.allowGroups === true);
  check("and it no longer counts as a group in the guide", await $(`document.querySelector('[data-im-connection=team] [data-testid=im-group-channels]')?.textContent === '#dev-room: work (a thread per ticket)'`));
  await $(`${route(dmRoute.id)}?.scrollIntoView({ block: 'start' });true`);
  await sleep(200);
  await shot("im-direct-chat-kind.png");
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  // With a group in place the guide waits folded.
  check("once there is a group, the guide waits folded", await waitFor(`${guide}?.querySelector('[data-testid=im-group-guide-fold]')?.getAttribute('aria-expanded') === 'false'`));
  await press(`${guide}.querySelector('[data-testid=im-group-guide-fold]')`);
  check("in Chinese too", await waitFor(`${guide}?.textContent.includes('在群聊或服务器里使用') && ${guide}.textContent.includes('在那里运行 /standin setup。')
    && document.querySelector('[data-im-connection=team] [data-testid=im-group-channels]')?.textContent === '#dev-room：工作（每个工单一个话题）'`), await $(`${guide}?.textContent`));
  await $(`${guide}?.scrollIntoView({ block: 'center' });true`);
  await sleep(200);
  await shot("im-group-guide-zh.png");
  // The whole pane folded, as it opens: one line per conversation.
  const compact = async (name) => {
    await press(`${guide}.querySelector('[data-testid=im-group-guide-fold][aria-expanded=true]')`);
    for (const rid of [dmRoute.id, "dev"]) await press(`${route(rid)}.querySelector('[data-testid=im-route-fold][aria-expanded=true]')`);
    await $(`document.querySelector('[data-im-connection=team]')?.scrollIntoView({ block: 'start' });true`);
    await sleep(300);
    await shot(name);
  };
  await compact("im-compact-zh.png");
  ctx.settings.set({ ...ctx.settings.get(), language: "en" });
  await waitFor(`document.body.textContent.includes('Use it in a group or server')`);
  await compact("im-compact.png");
  ctx.settings.set({ ...ctx.settings.get(), im: { ...imNow(), routes: imNow().routes.filter((r) => r.id !== "dev") } });
  await waitFor(`!document.querySelector('[data-im-connection=team] [data-testid=im-group-channels]') && document.body.textContent.includes('Use it in a group or server')`);

  // ── the status bar opens the pane ────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(600);
  await waitFor(`!!document.querySelector('.status-item[aria-label="IM connections"]')`);
  await press(`document.querySelector('.status-item[aria-label="IM connections"]')`);
  check("the status bar item opens the IM pane", await waitFor(`!!document.querySelector('[data-im-connection=team]')`));

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
