/**
 * Settings → Devices, against the real shell and a stand-in for Supabase that plays the account's other
 * computers: a Windows machine with a session and an auto run going, and an old Mac. Without an account the
 * pane says devices need one; a computer past the plan's limit says so and lists the ones that hold the places;
 * once one is removed this computer is "This computer", the other is greyed with when it was last online, and
 * online with what it works on once its presence arrives; its ticket opens here and says where it runs.
 *
 *   pnpm --filter @tomrade/desktop test:devices      (needs the dev server up)
 */
import { app, BrowserWindow, shell } from "electron";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { registerExtensionResolution } from "../dist/extension-resolve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const WORK = "/tmp/tomrade-devices-check";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const userData = path.join(WORK, "userData");
app.setPath("userData", userData);
// The session is encrypted with safeStorage; a mock keychain keeps the real one out of it.
app.commandLine.appendSwitch("use-mock-keychain");
process.env.TOMRADE_USER_DATA = userData;
registerExtensionResolution([path.resolve(__dirname, "../../..")]);

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond || !extra ? "" : ` — ${JSON.stringify(extra)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
shell.openExternal = async () => {};

const HOUR = 3_600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** Supabase Auth, the Hub RPCs and the account's machines, for whoever signed up last. The free plan: two computers. */
async function fakeSupabase() {
  const state = {
    user: null, password: null, limit: 2,
    /** The account's machines, by id; `removed` keeps one out. */
    devices: new Map([
      ["win-000001", { device_id: "win-000001", name: "DESKTOP-WIN", facts: { platform: "win32", arch: "x64", version: "0.29.0", git: true, agents: [{ id: "claude-code", title: "Claude Code", ready: true }, { id: "codex", title: "Codex", ready: false }], repos: ["https://github.com/acme/app"], accept: { on: true, projects: "all", ceiling: "edits", concurrent: 1 } }, last_seen_at: ago(2 * HOUR), updated_at: ago(2 * HOUR), activity: { sessions: [], nightShifts: [] }, activity_at: ago(2 * HOUR), removed: false }],
      ["old-000001", { device_id: "old-000001", name: "Old Mac", facts: { platform: "darwin", arch: "x64", version: "0.20.0", git: false, agents: [], repos: [] }, last_seen_at: ago(40 * 24 * HOUR), updated_at: ago(40 * 24 * HOUR), activity: {}, activity_at: null, removed: false }]
    ]),
    registered: [],
    /** The account's queue of tickets sent between its machines. */
    dispatches: []
  };
  const jwt = (claims) => [{ alg: "HS256", typ: "JWT" }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".e2e";
  const session = () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return { access_token: jwt({ sub: state.user.id, email: state.user.email, role: "authenticated", exp }), refresh_token: `refresh-${state.user.id}`, token_type: "bearer", expires_in: 3600, expires_at: exp, user: state.user };
  };
  const held = () => [...state.devices.values()].filter((d) => !d.removed);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const url = new URL(req.url, "http://supabase");
      const input = body ? JSON.parse(body) : {};
      const rpc = url.pathname.startsWith("/rest/v1/rpc/") ? url.pathname.slice("/rest/v1/rpc/".length) : null;
      if (url.pathname === "/auth/v1/signup") {
        state.user = { id: randomUUID(), aud: "authenticated", role: "authenticated", email: input.email, user_metadata: input.data ?? {}, app_metadata: {}, identities: [{ id: "i" }], created_at: new Date().toISOString() };
        state.password = input.password;
        return json(200, session());
      }
      if (url.pathname === "/auth/v1/token") return state.user ? json(200, session()) : json(400, { code: "invalid_credentials", msg: "Invalid login credentials" });
      if (url.pathname === "/auth/v1/user") {
        if (req.method === "PUT") state.user = { ...state.user, user_metadata: { ...state.user.user_metadata, ...input.data } };
        return json(200, state.user);
      }
      if (url.pathname === "/auth/v1/logout") return res.writeHead(204).end();
      if (rpc === "tomrade_ensure_hub") return json(200, `bbbbbbbb-bbbb-4bbb-8bbb-${(state.user?.id ?? "").slice(-12) || "bbbbbbbbbbbb"}`);
      if (rpc === "tomrade_mutate_hub") {
        const op = input.p_mutation;
        return json(200, { ok: true, record: { kind: op.kind, key: op.key, value: op.value, version: op.base_version + 1 } });
      }
      if (rpc === "tomrade_register_device") {
        const old = state.devices.get(input.p_device);
        if ((!old || old.removed) && held().length >= state.limit) return json(200, { state: "over_limit", limit: state.limit, plan: "free" });
        const now = new Date().toISOString();
        state.devices.set(input.p_device, { device_id: input.p_device, name: old && !old.removed ? old.name : input.p_name, facts: input.p_facts, last_seen_at: now, updated_at: now, activity: old?.activity ?? {}, activity_at: old?.activity_at ?? null, removed: false });
        state.registered.push(input.p_device);
        return json(200, { state: "registered" });
      }
      if (rpc === "tomrade_device_plan") return json(200, { plan: "free", limit: state.limit, used: held().length });
      if (rpc === "tomrade_rename_device" || rpc === "tomrade_remove_device") {
        const device = state.devices.get(input.p_device);
        if (!device || device.removed) return json(400, { code: "P0002", message: "No such device" });
        if (rpc === "tomrade_rename_device") device.name = input.p_name;
        else Object.assign(device, { removed: true, facts: {}, activity: {}, activity_at: null });
        return res.writeHead(204).end();
      }
      if (rpc === "tomrade_report_device_activity") {
        const device = state.devices.get(input.p_device);
        if (!device || device.removed) return json(200, false);
        Object.assign(device, { activity: input.p_activity, activity_at: new Date().toISOString() });
        return json(200, true);
      }
      if (rpc === "tomrade_create_dispatch") {
        const now = new Date().toISOString();
        const row = { id: randomUUID(), from_device: input.p_from, to_device: input.p_to, to_platform: input.p_to ? null : input.p_platform, project_id: input.p_project, item_key: input.p_key, title: input.p_title, wish: input.p_wish, state: "queued", reason: null, claimed_by: null, created_at: now, updated_at: now, expires_at: new Date(Date.now() + 24 * HOUR).toISOString() };
        state.dispatches.unshift(row);
        return json(200, row);
      }
      if (rpc === "tomrade_cancel_dispatch") {
        const row = state.dispatches.find((d) => d.id === input.p_id);
        if (!row || !["queued", "accepted", "running"].includes(row.state)) return json(400, { code: "P0002", message: "This dispatch is no longer going" });
        Object.assign(row, { state: "cancelled", reason: input.p_reason ?? null, updated_at: new Date().toISOString() });
        return json(200, row);
      }
      if (rpc) return json(200, null);
      if (url.pathname === "/rest/v1/tomrade_dispatches") return json(200, state.dispatches);
      if (url.pathname === "/rest/v1/tomrade_devices") return json(200, held().map(({ removed: _removed, ...row }) => row));
      if (url.pathname.startsWith("/rest/v1/")) return json(200, []);
      json(404, { msg: "not here" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, state };
}

const run = async () => {
  const supabase = await fakeSupabase();
  const { boot } = await import("../dist/boot.js");
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData, locale: "en-US", pluginsRoot: path.join(WORK, "plugins"), pluginsDevRoot: path.join(WORK, "plugins-dev") },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", config: { userData, url: supabase.origin, publishableKey: "sb_publishable_e2e" } }]]
  });
  ctx.hub.configure(path.join(WORK, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  ctx.settings.set({ ...ctx.settings.get(), language: "en", theme: "light", onboarding: { seen: ["*"] } });
  const project = ctx.projects.create({ name: "Keep me", keyPrefix: "KM" });
  await ctx.storage.ready;
  const ticket = ctx.items.create({ projectId: project.id, boardId: ctx.boards.list(project.id)[0].id, title: "Faster on Windows", status: "todo", workType: "coding", by: "human" });
  const self = ctx.hub.deviceId;
  // What the Windows machine is on: a ticket of a project this machine has, and one of a project it does not.
  const win = supabase.state.devices.get("win-000001");
  win.activity = {
    sessions: [
      { projectId: project.id, key: ticket.key, title: ticket.title, agent: "claude-code", state: "working", startedAt: Date.now() - HOUR, branch: "km-1/faster" },
      { projectId: "not-on-this-machine", key: "ZZ-9", title: "A project this machine never opened", agent: "codex", state: "waiting", startedAt: Date.now() - HOUR, branch: null }
    ],
    nightShifts: [{ projectId: project.id, done: 2, total: 5, startedAt: Date.now() - HOUR }]
  };

  const win0 = new BrowserWindow({ width: 1280, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true } });
  win0.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message}`);
  });
  await win0.loadURL(DEV_URL);
  await sleep(3500);
  const $ = (js) => win0.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const typeInto = (selector, text) =>
    $(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const until = async (js, ms = 10_000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (await $(js)) return true;
      await sleep(200);
    }
    return false;
  };
  // TOMRADE_SHOTS=<dir> keeps a picture of each state, for a look by eye.
  const shot = async (name) => {
    if (!process.env.TOMRADE_SHOTS) return;
    fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS, `${name}.png`), (await win0.webContents.capturePage()).toPNG());
  };
  const button = (label, scope = "document") => `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const pane = `document.querySelector('.dlg-body')`;
  const paneText = () => $(`${pane}?.textContent ?? ''`);
  const card = (id) => `document.querySelector('[data-testid="device-card"][data-device="${id}"]')`;
  const cardIds = () => $(`[...document.querySelectorAll('[data-testid="device-card"]')].map(c => c.dataset.device)`);
  const openDevices = async (about = "About Tomrade", row = "Devices") => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
    await sleep(500);
    await typeInto(".palette-input", about.split(" ")[0]);
    await sleep(400);
    await press(`[...document.querySelectorAll('.palette-row')].find(r => r.textContent.trim() === ${JSON.stringify(about)})`);
    await sleep(900);
    await press(`[...document.querySelectorAll('.side-row')].find(r => r.textContent.trim() === ${JSON.stringify(row)})`);
    await sleep(700);
  };

  // ── without an account ───────────────────────────────────────────────
  ctx.cloudHub.useLocally();
  await $(`location.hash = '#/p/${project.id}'; true`);
  await sleep(2500);
  await openDevices();
  check("Settings has a Devices pane", await until(`(${pane}?.textContent ?? '').includes('The computers signed in to your account')`), await paneText());
  check("without an account it says devices need one", await until(`!!document.querySelector('[data-testid="devices-signed-out"]')`) && (await paneText()).includes("Devices need an account"), await paneText());
  check("and lists no computer", (await cardIds()).length === 0);
  await shot("devices-01-signed-out");

  // ── signed in, past the free plan's two computers ────────────────────
  await ctx.cloudHub.signUp("devices@example.test", "long enough", "en", true);
  check("a third computer is told it has no place", await until(`!!document.querySelector('[data-testid="devices-over-limit"]')`), await paneText());
  const over = await paneText();
  check("it says the plan's limit and what still works", over.includes("Your plan allows 2 computers") && over.includes("Your projects and settings still sync here"), over);
  check("it lists the two that hold the places, neither as this computer", JSON.stringify((await cardIds()).sort()) === JSON.stringify(["old-000001", "win-000001"]) && !(await $(`[...document.querySelectorAll('[data-testid="device-card"]')].some(c => c.textContent.includes('This computer'))`)), await cardIds());
  check("the plan line says two of two", (await $(`document.querySelector('[data-testid="devices-plan"]')?.textContent ?? ''`)).includes("2 of 2 computers"));
  check("this computer was not registered", !supabase.state.devices.has(self) && ctx.cloudHub.info().status.state === "synced", { state: ctx.cloudHub.info().status.state });
  await press(button("Subscribe", pane));
  check("Subscribe says subscriptions are not open yet", await until(`document.body.textContent.includes('Subscriptions are not open yet.')`));
  await shot("devices-02-over-limit");

  // ── remove one: this computer takes the place ────────────────────────
  await press(`${card("old-000001")}?.querySelector('[data-testid="device-remove"]')`);
  check("removing asks first, naming the computer", await until(`(document.querySelector('[data-testid="confirm-body"]')?.textContent ?? '').includes('Remove Old Mac from your devices?')`));
  await press(`document.querySelector('[data-testid="confirm-yes"]')`);
  check("once it is removed this computer takes the place", await until(`!!${card(self)}`, 15_000) && supabase.state.registered.includes(self), await cardIds());
  check("this computer is marked as such, and online", (await $(`${card(self)}?.textContent ?? ''`)).includes("This computer") && (await $(`${card(self)}?.dataset.online`)) === "true");
  check("it comes first", (await cardIds())[0] === self, await cardIds());
  check("the other is greyed, with when it was last online", (await $(`${card("win-000001")}?.classList.contains('offline')`)) && (await $(`${card("win-000001")}?.querySelector('[data-testid="device-presence"]')?.textContent ?? ''`)).includes("Last online 2h ago"), await $(`${card("win-000001")}?.textContent`));
  const winCard = () => $(`${card("win-000001")}?.textContent ?? ''`);
  check("with its platform, version and agents", (await winCard()).includes("Windows") && (await winCard()).includes("Tomrade 0.29.0") && (await winCard()).includes("Claude Code") && (await $(`!!${card("win-000001")}?.querySelector('.device-agent.unready')`)), await winCard());
  check("what it was doing reads as last known", (await winCard()).includes("Last known, 2h ago") && (await winCard()).includes(ticket.key) && (await winCard()).includes("Faster on Windows"), await winCard());
  await shot("devices-03-two-light");

  // ── accepting work from the other computers ──────────────────────────
  const accept = `document.querySelector('[data-testid="accept-work"]')`;
  const sw = `document.querySelector('[data-testid="accept-switch"]')`;
  const said = () => supabase.state.devices.get(self)?.facts?.accept;
  check("this computer does not accept work until asked to", await until(`${sw}?.getAttribute('aria-checked') === 'false'`) && !(await $(`!!document.querySelector('[data-testid="accept-warning"]')`)) && said()?.on === false, said());
  check("the other computer says it accepts work", (await winCard()).includes("Accepts work"), await winCard());
  check("a request is turned away while it is off", ctx.dispatch.admit({ from: "win-000001", projectId: project.id, key: ticket.key }).reason === "off");
  await press(sw);
  check("turning it on says what that means", await until(`(document.querySelector('[data-testid="accept-warning"]')?.textContent ?? '').includes('run an agent on this computer and change code here')`), await $(`${accept}?.textContent`));
  check("and the account's other computers are told, with the limit", await (async () => { for (let i = 0; i < 40 && said()?.on !== true; i++) await sleep(250); return said()?.on === true && said().ceiling === "edits" && said().projects === "all"; })(), said());
  check("the limit starts at editing files, not full access", (await $(`document.querySelector('[data-testid="accept-ceiling"]')?.value`)) === "edits");
  const took = ctx.dispatch.admit({ from: "win-000001", projectId: project.id, key: ticket.key }, ["bypassPermissions", "acceptEdits", "default"]);
  const refused = ctx.dispatch.admit({ from: "win-000001", projectId: project.id, key: ticket.key, permissionMode: "bypassPermissions" });
  check("a request within the limits is taken, one above them is not", took.ok && took.permissionMode === "acceptEdits" && !refused.ok && refused.reason === "permission", { took, refused });
  check("both are in the record, with who asked", await until(`(document.querySelector('[data-testid="accept-log"]')?.textContent ?? '').includes('Turned away from DESKTOP-WIN: it asked for more access than this computer allows')`) && (await $(`${accept}?.textContent`)).includes("Taken from DESKTOP-WIN"), await $(`document.querySelector('[data-testid="accept-log"]')?.textContent`));
  await shot("devices-03b-accept-on");
  await press(sw);
  check("it can be turned off again, and then takes nothing", await until(`${sw}?.getAttribute('aria-checked') === 'false'`) && ctx.dispatch.admit({ from: "win-000001", projectId: project.id, key: ticket.key }).reason === "off");

  // ── the other comes online ───────────────────────────────────────────
  // Its presence, as the channel would say it: this stand-in speaks no Realtime.
  ctx.cloudHub.machines.seen({ [self]: [{ at: Date.now() }], "win-000001": [{ at: Date.now() }] });
  check("the other reads as online once its presence arrives", await until(`${card("win-000001")}?.dataset.online === 'true'`) && (await $(`${card("win-000001")}?.querySelector('[data-testid="device-presence"]')?.textContent ?? ''`)).includes("Online"));
  check("what it works on: the ticket, the agent, how it stands, and the auto run", (await winCard()).includes("Working on") && (await winCard()).includes("Claude Code · working") && (await winCard()).includes("Auto run: 2 of 5"), await winCard());
  check("a ticket of a project this computer never opened still shows, by its key, and does not open", (await winCard()).includes("ZZ-9") && (await $(`[...${card("win-000001")}.querySelectorAll('[data-testid="device-session"]')].find(r => r.textContent.includes('ZZ-9'))?.querySelector('button') === null`)), await winCard());
  await shot("devices-04-online-light");
  ctx.settings.set({ ...ctx.settings.get(), theme: "dark" });
  await sleep(900);
  check("the dark theme keeps the cards readable", await $(`(() => { const c = ${card("win-000001")}; const fg = getComputedStyle(c.querySelector('.device-name')).color; const bg = getComputedStyle(c).backgroundColor; return fg !== bg; })()`));
  await shot("devices-05-online-dark");
  ctx.settings.set({ ...ctx.settings.get(), theme: "light" });

  // ── rename, from this computer ───────────────────────────────────────
  await press(`${button("Rename", card("win-000001"))}`);
  await sleep(300);
  await typeInto(`[data-device="win-000001"] .device-rename input`, "Windows tower");
  await press(`${button("Save", card("win-000001"))}`);
  check("renaming another computer shows at once and reaches the account", await until(`(${card("win-000001")}?.textContent ?? '').includes('Windows tower')`) && supabase.state.devices.get("win-000001").name === "Windows tower");

  // ── its ticket opens here, and says where it runs ────────────────────
  await press(`[...${card("win-000001")}.querySelectorAll('[data-testid="device-session"] button')].find(b => b.textContent.includes('Faster on Windows'))`);
  check("the ticket opens on this computer", await until(`location.hash.includes('/i/${ticket.key}')`), await $(`location.hash`));
  check("and says it runs on the other computer", await until(`(document.querySelector('[data-testid="ticket-elsewhere"]')?.textContent ?? '').includes('Running on Windows tower')`), await $(`document.querySelector('[data-testid="ticket-elsewhere"]')?.textContent`));
  await shot("devices-06-ticket-elsewhere");
  // Gone offline: the ticket says when it was last seen there.
  ctx.cloudHub.machines.seen({ [self]: [{ at: Date.now() }], "win-000001": [{ leaving: true }] });
  check("offline, the ticket says where it was last seen running", await until(`(document.querySelector('[data-testid="ticket-elsewhere"]')?.textContent ?? '').includes('Last seen running on Windows tower')`), await $(`document.querySelector('[data-testid="ticket-elsewhere"]')?.textContent`));

  // ── sending a ticket to the other computer ───────────────────────────
  const second = ctx.items.create({ projectId: project.id, boardId: ctx.boards.list(project.id)[0].id, title: "Port the installer", status: "todo", workType: "coding", by: "human" });
  await $(`location.hash = '#/p/${project.id}/i/${second.key}'; true`);
  await sleep(2500);
  const choose = (selector, value) =>
    $(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const openStart = async (shown = `!!document.querySelector('[data-testid="run-on-select"]')`) => {
    if (!(await press(`document.querySelector('[data-testid="start-ticket"]')`))) {
      await press(`document.querySelector('[data-testid="start-ways"]')`);
      await sleep(400);
      await press(`[...document.querySelectorAll('[role="menuitem"]')].find(n => n.textContent.includes('Full settings'))`);
    }
    return until(shown);
  };
  const sentLine = () => $(`document.querySelector('[data-testid="ticket-sent"]')?.textContent ?? ''`);
  check("Start offers where to run: this computer, the other one, or any of its platform", (await openStart()) && JSON.stringify(await $(`[...document.querySelector('[data-testid="run-on-select"]').options].map(o => o.textContent)`)) === JSON.stringify(["This computer", "Windows tower (offline)", "Any Windows computer"]), await $(`[...(document.querySelector('[data-testid="run-on-select"]')?.options ?? [])].map(o => o.textContent)`));
  check("on this computer, Start is as it was", (await $(`getComputedStyle(document.querySelector('[data-testid="start-dialog"]')).display`)) !== "none" && (await $(`!!document.querySelector('[data-testid="start-confirm"]')`)));
  await choose('[data-testid="run-on-select"]', "win-000001");
  check("choosing the other computer says what that means, and puts this computer's own choices away", await until(`(document.querySelector('[data-testid="run-on-note"]')?.textContent ?? '').includes('That computer is off')`) && (await $(`getComputedStyle(document.querySelector('[data-testid="start-dialog"]')).display`)) === "none" && !(await $(`!!document.querySelector('[data-testid="start-confirm"]')`)), await $(`document.querySelector('[data-testid="run-on"]')?.textContent`));
  await shot("devices-06b-run-on");
  await press(`document.querySelector('[data-testid="run-on-send"]')`);
  check("Send puts the ticket in the account's queue for that computer, and nothing else", await (async () => { for (let i = 0; i < 40 && !supabase.state.dispatches.length; i++) await sleep(250); const d = supabase.state.dispatches[0]; return !!d && d.from_device === self && d.to_device === "win-000001" && d.item_key === second.key && d.title === "Port the installer" && JSON.stringify(d.wish) === "{}"; })(), supabase.state.dispatches[0]);
  check("the ticket says it is sent and waiting, with a way to take it back", await until(`(document.querySelector('[data-testid="ticket-sent"]')?.textContent ?? '').includes('Sent to Windows tower, waiting for it to take it')`) && (await $(`!!document.querySelector('[data-testid="ticket-sent-cancel"]')`)), await sentLine());
  check("this computer started nothing itself", ctx.codeLink.sessionsOf(project.id, second.id).length === 0);
  await shot("devices-06c-sent");
  // The other computer turns it away.
  Object.assign(supabase.state.dispatches[0], { state: "refused", reason: "permission: bypassPermissions is above this machine's limit (edits)", claimed_by: "win-000001", updated_at: new Date().toISOString() });
  await ctx.dispatch.queue.tick();
  check("turned away, the ticket says by whom and why", await until(`(document.querySelector('[data-testid="ticket-sent"]')?.textContent ?? '').includes('Windows tower turned it away: it asked for more access than this computer allows')`) && !(await $(`!!document.querySelector('[data-testid="ticket-sent-cancel"]')`)), await sentLine());
  // Sent again, then taken back.
  await openStart();
  await choose('[data-testid="run-on-select"]', "platform:win32");
  await sleep(300);
  await press(`document.querySelector('[data-testid="run-on-send"]')`);
  check("it can be sent to any computer of a platform", await (async () => { for (let i = 0; i < 40 && supabase.state.dispatches.length < 2; i++) await sleep(250); const d = supabase.state.dispatches[0]; return supabase.state.dispatches.length === 2 && d.to_device === null && d.to_platform === "win32"; })(), supabase.state.dispatches[0]);
  await until(`!!document.querySelector('[data-testid="ticket-sent-cancel"]')`);
  await press(`document.querySelector('[data-testid="ticket-sent-cancel"]')`);
  check("taken back, it is cancelled in the queue and the ticket says so", await until(`(document.querySelector('[data-testid="ticket-sent"]')?.textContent ?? '').includes('Taken back')`) && supabase.state.dispatches[0].state === "cancelled", await sentLine());

  // ── one computer only ────────────────────────────────────────────────
  await $(`location.hash = '#/p/${project.id}'; true`);
  await sleep(1500);
  await ctx.cloudHub.removeDevice("win-000001");
  await openDevices();
  check("with one computer, it says how another appears", await until(`!!document.querySelector('[data-testid="devices-only-one"]')`) && (await paneText()).includes("Sign in to the same account on another computer and it appears here."), await paneText());
  check("and the plan line says one of two", (await $(`document.querySelector('[data-testid="devices-plan"]')?.textContent ?? ''`)).includes("1 of 2 computers"));
  await shot("devices-07-only-one");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await $(`location.hash = '#/p/${project.id}/i/${second.key}'; true`);
  await sleep(2500);
  const runOn = `document.querySelector('[data-testid="run-on"]')`;
  check("with one computer, Start still says where it runs, and how another computer could take it", (await openStart(`${runOn}?.dataset.state === 'alone'`)) && (await $(`${runOn}.textContent`)).includes("This computer") && (await $(`document.querySelector('[data-testid="run-on-hint"]')?.textContent ?? ''`)).includes("Sign in to the same account on another computer and tickets can be sent there.") && !(await $(`!!document.querySelector('[data-testid="run-on-select"]')`)) && (await $(`!!document.querySelector('[data-testid="start-confirm"]')`)), await $(`${runOn}?.outerHTML`));
  await shot("devices-07b-run-on-alone");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);

  // ── in Chinese ───────────────────────────────────────────────────────
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await win0.webContents.reload();
  await sleep(3500);
  await $(`location.hash = '#/p/${project.id}'; true`);
  await sleep(2000);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(500);
  await press(`[...document.querySelectorAll('.palette-row')].find(r => /关于/.test(r.textContent))`);
  await sleep(900);
  await press(`[...document.querySelectorAll('.side-row')].find(r => r.textContent.trim() === '设备')`);
  await sleep(700);
  const zh = await paneText();
  check("中文：设备页、这台电脑、免费版名额", zh.includes("登录了你账号的电脑") && zh.includes("这台电脑") && zh.includes("在线") && zh.includes("已用 1 / 2 台电脑") && zh.includes("在另一台电脑上登录同一个账号"), zh);
  check("中文：接单开关和记录", zh.includes("接受我其他设备派来的工作") && zh.includes("最近的派单请求") && zh.includes("它要求的权限超出了这台电脑允许的范围"), zh);
  await shot("devices-08-zh");
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    console.error(error);
    results.push({ name: "run", pass: false });
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  app.exit(passed === results.length ? 0 : 1);
});
