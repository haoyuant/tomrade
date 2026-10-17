/**
 * Using Tomrade without an account, against the real shell and a stand-in for
 * Supabase that starts out unreachable: the sign-in page says what an account is
 * for and offers local use on every step, a failed sign-in still leaves it one
 * click away, the choice survives a restart, projects and tickets (over MCP too)
 * work while nothing reaches the server, and signing in later from Settings → Hub
 * takes those projects into the account. Signing out offers local use again.
 *
 *   pnpm --filter @tomrade/desktop test:account-optional      (needs the dev server up)
 */
import { app, BrowserWindow, shell } from "electron";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerExtensionResolution } from "../dist/extension-resolve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const WORK = "/tmp/tomrade-account-optional-check";
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

/**
 * Supabase Auth and the Hub RPCs for whoever signed up last. While `down`, every connection is dropped.
 * `reached` counts account and Hub requests only: announcements are public reads made either way.
 */
async function fakeSupabase() {
  const state = { down: true, reached: 0, user: null, password: null, mutations: [] };
  const accountOrHub = (url) => url.startsWith("/auth/") || /tomrade_(ensure_hub|mutate_hub|hub_records)/.test(url);
  const jwt = (claims) => [{ alg: "HS256", typ: "JWT" }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".e2e";
  const subject = (req) => {
    try {
      return JSON.parse(Buffer.from((req.headers.authorization ?? "").split(".")[1] ?? "", "base64url").toString()).sub ?? null;
    } catch {
      return null;
    }
  };
  const session = () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return { access_token: jwt({ sub: state.user.id, email: state.user.email, role: "authenticated", exp }), refresh_token: `refresh-${state.user.id}`, token_type: "bearer", expires_in: 3600, expires_at: exp, user: state.user };
  };
  const server = http.createServer((req, res) => {
    if (accountOrHub(req.url)) state.reached++;
    if (state.down) return req.socket.destroy();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const url = new URL(req.url, "http://supabase");
      const input = body ? JSON.parse(body) : {};
      if (url.pathname === "/auth/v1/signup") {
        state.user = { id: randomUUID(), aud: "authenticated", role: "authenticated", email: input.email, user_metadata: input.data ?? {}, app_metadata: {}, identities: [{ id: "i" }], created_at: new Date().toISOString() };
        state.password = input.password;
        return json(200, session());
      }
      if (url.pathname === "/auth/v1/token") {
        if (!state.user || (url.searchParams.get("grant_type") === "password" && (input.email !== state.user.email || input.password !== state.password))) return json(400, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" });
        return json(200, session());
      }
      if (url.pathname === "/auth/v1/user") {
        if (req.method === "PUT") state.user = { ...state.user, user_metadata: { ...state.user.user_metadata, ...input.data } };
        return json(200, state.user);
      }
      if (url.pathname === "/auth/v1/logout") return res.writeHead(204).end();
      if (url.pathname === "/rest/v1/rpc/tomrade_ensure_hub") return json(200, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      if (url.pathname === "/rest/v1/rpc/tomrade_mutate_hub") {
        const op = input.p_mutation;
        state.mutations.push({ user: subject(req), kind: op.kind, key: op.key });
        return json(200, { ok: true, record: { kind: op.kind, key: op.key, value: op.value, version: op.base_version + 1 } });
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) return json(200, null);
      if (url.pathname.startsWith("/rest/v1/")) return json(200, []);
      json(404, { msg: "not here" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, state };
}

/** The MCP SDK's client, from the package that serves MCP. */
async function mcpClient() {
  const require = createRequire(path.resolve(__dirname, "../../../packages/mcp/package.json"));
  const load = (spec) => import(pathToFileURL(require.resolve(spec)).href);
  const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await load("@modelcontextprotocol/sdk/client/streamableHttp.js");
  return { Client, StreamableHTTPClientTransport };
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
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });

  const win = new BrowserWindow({ width: 1280, height: 860, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message}`);
  });
  await win.loadURL(DEV_URL);
  await sleep(3500);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const typeInto = (selector, text) =>
    $(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const until = async (js, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (await $(js)) return true;
      await sleep(200);
    }
    return false;
  };
  // TOMRADE_SHOTS=<dir> keeps a picture of each state, for a look by eye.
  const shot = async (name) => {
    if (!process.env.TOMRADE_SHOTS) return;
    fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const button = (label, scope = "document") => `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const gate = `document.querySelector('.account-gate')`;
  const gateText = () => $(`${gate}?.textContent ?? ''`);
  const dialog = `document.querySelector('.dlg-body')`;
  const cache = () => JSON.parse(fs.readFileSync(path.join(userData, "hub-cloud.json"), "utf8"));
  const openHub = async () => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
    await sleep(500);
    await typeInto(".palette-input", "About");
    await sleep(400);
    await press(`[...document.querySelectorAll('.palette-row')].find(r => r.textContent.trim() === 'About Tomrade')`);
    await sleep(900);
    await press(`[...document.querySelectorAll('.side-row')].find(r => r.textContent.trim() === 'Hub')`);
    await sleep(700);
  };

  // ── a new person, and the server out of reach ───────────────────────
  check("a fresh install opens on the sign-in page", await until(`!!${gate}?.querySelector('input[type=email]')`), await gateText());
  // The form rises in after the sunrise.
  await sleep(2500);
  check("which says what an account is for", (await gateText()).includes("An account keeps your project list and preferences in sync across your computers."), await gateText());
  check("and offers to go on without one", await $(`!!${button("Use without an account", gate)}`) && (await gateText()).includes("Your projects stay on this computer. You can sign in later in Settings\u00a0→\u00a0Hub."), await gateText());
  await shot("account-optional-01-gate");

  await typeInto(".account-gate input[type=email]", "later@example.test");
  await typeInto(".account-gate input[type=password]", "long enough");
  await press(`document.querySelector('.account-agree input')`);
  await sleep(200);
  await press(button("Sign in", gate));
  check("signing in while the server is unreachable says so", await until(`(${gate}?.textContent ?? '').includes("Can't reach the Tomrade server")`), await gateText());
  check("and local use is still one click away", await $(`!!${button("Use without an account", gate)}`));
  await shot("account-optional-02-unreachable");

  await press(button("Use without an account", gate));
  check("one click opens the app", await until(`!${gate}`), await gateText());
  check("and the choice is kept in hub-cloud.json", cache().localOnly === true && cache().userId === null, { localOnly: cache().localOnly });
  await win.webContents.reload();
  await sleep(3500);
  check("a restart opens straight into the app", !(await $(`!!${gate}`)));

  // ── projects and tickets, over MCP too, with nothing sent ────────────
  const reached = supabase.state.reached;
  const project = ctx.projects.create({ name: "Kept local", keyPrefix: "KL" });
  await ctx.storage.ready;
  const { Client, StreamableHTTPClientTransport } = await mcpClient();
  const client = new Client({ name: "account-optional-check", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.urlFor(project.id))));
  await client.callTool({ name: "find_similar", arguments: { title: "Filed over MCP" } });
  const filed = await client.callTool({ name: "create_item", arguments: { title: "Filed over MCP" } });
  await client.close();
  check("an agent files a ticket over MCP", !filed.isError && ctx.items.list({ projectId: project.id }).some((i) => i.title === "Filed over MCP"), filed);
  await $(`location.hash = '#/p/${project.id}'; true`);
  check("and the project shows it", await until(`document.body.textContent.includes('Filed over MCP')`));
  await shot("account-optional-03-local-project");
  await ctx.storage.writeHub();
  await sleep(1500);
  check("no account or Hub request reached the server meanwhile", supabase.state.reached === reached, { before: reached, after: supabase.state.reached });
  check("the project waits in the outbox", cache().outbox.some((op) => op.kind === "project" && op.key === project.id), cache().outbox.map((op) => `${op.kind}:${op.key}`));

  // ── signing in later from Settings → Hub takes the projects along ────
  supabase.state.down = false;
  await openHub();
  check("Settings → Hub offers to sign in", await until(`!!${dialog}?.querySelector('input[type=email]')`));
  await typeInto(".dlg-body input[type=email]", "later@example.test");
  await typeInto(".dlg-body input[type=password]", "long enough");
  await press(`document.querySelector('.dlg-body .account-agree input')`);
  await sleep(200);
  await press(button("Create account", dialog));
  check("creating the account there signs in", await until(`(${dialog}?.textContent ?? '').includes('later@example.test') && !!${button("Sign out", dialog)}`), await $(`${dialog}?.textContent ?? ''`));
  const account = supabase.state.user?.id;
  let taken = false;
  for (let waited = 0; waited < 8000 && !taken; waited += 200) {
    taken = supabase.state.mutations.some((m) => m.user === account && m.kind === "project" && m.key === project.id);
    if (!taken) await sleep(200);
  }
  check("the project made without an account joins it", taken, supabase.state.mutations);
  check("and stays here, once", ctx.projects.list().filter((p) => p.id === project.id).length === 1 && ctx.projects.list().length === 1, ctx.projects.list().map((p) => p.name));
  check("local use is no longer recorded", cache().localOnly === false && cache().userId === account, { localOnly: cache().localOnly });
  await shot("account-optional-04-signed-in");

  // ── signing out offers local use again ───────────────────────────────
  await press(button("Sign out", dialog));
  check("signing out returns to the sign-in page", await until(`!!${gate}`));
  check("which still offers local use", await until(`!!${button("Use without an account", gate)}`));
  await press(button("Use without an account", gate));
  check("and opens this computer's projects again", await until(`!${gate}`) && !!ctx.hub.catalog.project(project.id));

  // ── in Chinese ───────────────────────────────────────────────────────
  await ctx.cloudHub.signOut();
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await win.webContents.reload();
  await sleep(3500);
  check("中文：登录页", await until(`!!${gate}`));
  await sleep(2500);
  check("中文：说明账号的用途", (await gateText()).includes("账号用于在多台电脑之间同步项目列表和偏好设置。"), await gateText());
  check("中文：不登录，本地使用", await $(`!!${button("不登录，本地使用", gate)}`) && (await gateText()).includes("之后可以在 设置\u00a0→\u00a0主目录 中登录。"), await gateText());
  await shot("account-optional-05-gate-zh");
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
