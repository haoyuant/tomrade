/**
 * Deleting a Tomrade account from Settings → Hub, against the real shell and a
 * stand-in for Supabase: the panel says what goes and what stays, a wrong
 * password deletes nothing, the right one deletes the account and signs out,
 * this computer's projects stay, and the next account to sign in takes them.
 *
 *   pnpm --filter @tomrade/desktop test:account-delete      (needs the dev server up)
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
const WORK = "/tmp/tomrade-account-delete-check";
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

/** Supabase Auth, the Hub RPCs and account deletion, for whoever signed up last. Every other table reads as empty. */
async function fakeSupabase() {
  const state = { user: null, password: null, deleted: [], mutations: [] };
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
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const url = new URL(req.url, "http://supabase");
      const input = body ? JSON.parse(body) : {};
      const invalid = () => json(400, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" });
      if (url.pathname === "/auth/v1/signup") {
        state.user = { id: randomUUID(), aud: "authenticated", role: "authenticated", email: input.email, user_metadata: input.data ?? {}, app_metadata: {}, identities: [{ id: "i" }], created_at: new Date().toISOString() };
        state.password = input.password;
        return json(200, session());
      }
      if (url.pathname === "/auth/v1/token") {
        if (!state.user) return invalid();
        if (url.searchParams.get("grant_type") === "password" && (input.email !== state.user.email || input.password !== state.password)) return invalid();
        return json(200, session());
      }
      if (url.pathname === "/auth/v1/user") {
        if (!state.user || subject(req) !== state.user.id) return json(403, { code: "user_not_found", msg: "User from sub claim in JWT does not exist" });
        if (req.method === "PUT") state.user = { ...state.user, user_metadata: { ...state.user.user_metadata, ...input.data } };
        return json(200, state.user);
      }
      if (url.pathname === "/auth/v1/logout") return res.writeHead(204).end();
      if (url.pathname === "/rest/v1/rpc/tomrade_delete_account") {
        if (!state.user || subject(req) !== state.user.id) return json(401, { code: "42501", message: "Authentication required" });
        state.deleted.push(state.user.id);
        state.user = null;
        return res.writeHead(204).end();
      }
      if (url.pathname === "/rest/v1/rpc/tomrade_ensure_hub") return json(200, `bbbbbbbb-bbbb-4bbb-8bbb-${(state.user?.id ?? "").slice(-12) || "bbbbbbbbbbbb"}`);
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
  const step = `document.querySelector('.dlg-body form.account-step')`;
  const stepText = () => $(`${step}?.textContent ?? ''`);
  const signUp = async (email) => {
    await until(`!!${gate}?.querySelector('input[type=email]')`);
    await typeInto(".account-gate input[type=email]", email);
    await typeInto(".account-gate input[type=password]", "long enough");
    await press(`document.querySelector('.account-agree input')`);
    await sleep(200);
    await press(button("Create account"));
    return until(`!${gate}`);
  };
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

  check("signs up", await signUp("leaving@example.test"));
  const first = supabase.state.user.id;
  const project = ctx.projects.create({ name: "Keep me", keyPrefix: "KM" });
  await ctx.storage.ready;
  const projectDir = ctx.hub.catalog.project(project.id)?.dir;
  await $(`location.hash = '#/p/${project.id}'; true`);
  await sleep(2500);
  await openHub();
  check("Settings → Hub offers to delete the account", await until(`!!${button("Delete account…", "document.querySelector('.dlg-body')")}`));

  // ── the confirmation says what goes and what stays ──────────────────
  await press(button("Delete account…", "document.querySelector('.dlg-body')"));
  check("it asks before anything happens", await until(`(${step}?.textContent ?? '').includes('Delete your Tomrade account?')`), await stepText());
  const said = await stepText();
  check("naming the account and what is deleted", said.includes("leaving@example.test") && said.includes("your synced preferences and project list, your plugin reports and your publisher profile"), said);
  check("and what stays: projects here, their remotes, published plugins", said.includes("your projects on this computer and in their git remotes") && said.includes("support@tomrade.com"), said);
  check("the password field holds the focus", await $(`document.activeElement?.type === 'password' && !!${step}?.contains(document.activeElement)`));
  check("Delete account waits for the password", await $(`${button("Delete account", step)}?.disabled === true`));
  await shot("account-delete-01-confirm");

  await typeInto(".dlg-body form.account-step input[type=password]", "not my password");
  await press(button("Delete account", step));
  check("a wrong password says so", await until(`(${step}?.textContent ?? '').includes("That password isn't right.")`), await stepText());
  check("and deletes nothing", supabase.state.deleted.length === 0 && !!supabase.state.user);
  await press(button("Cancel", step));
  await sleep(300);
  check("Cancel goes back to the account", !(await $(`!!${step}`)) && !!(await $(`!!${button("Delete account…", "document.querySelector('.dlg-body')")}`)));

  // ── the right password deletes it ───────────────────────────────────
  await press(button("Delete account…", "document.querySelector('.dlg-body')"));
  await sleep(300);
  await typeInto(".dlg-body form.account-step input[type=password]", "long enough");
  await press(button("Delete account", step));
  check("the right password deletes the account on the server", await until(`!!${gate}`) && supabase.state.deleted.join() === first, supabase.state.deleted);
  check("and Tomrade is back at sign-in", !!(await $(`!!${gate}?.querySelector('input[type=email]')`)));
  check("the project is still on this computer", !!ctx.hub.catalog.project(project.id) && !!projectDir && fs.existsSync(projectDir), { projectDir });
  const registry = JSON.parse(fs.readFileSync(path.join(userData, "accounts.json"), "utf8"));
  check("the account no longer owns a folder here", !registry.accounts[first], registry);
  const cache = JSON.parse(fs.readFileSync(path.join(userData, "hub-cloud.json"), "utf8"));
  check("and this local Hub belongs to nobody", cache.userId === null && cache.hubId === null && cache.email === null, { userId: cache.userId, email: cache.email });
  check("the stored session is gone", !(await ctx.cloudHub.client.auth.getSession()).data.session);
  await shot("account-delete-02-signed-out");

  // ── the next account takes the projects ─────────────────────────────
  check("another account can sign up here", await signUp("next@example.test"));
  const second = supabase.state.user.id;
  let taken = false;
  for (let waited = 0; waited < 8000 && !taken; waited += 200) {
    taken = supabase.state.mutations.some((m) => m.user === second && m.kind === "project" && m.key === project.id);
    if (!taken) await sleep(200);
  }
  check("and it takes this computer's projects", taken, supabase.state.mutations);

  // ── in Chinese ───────────────────────────────────────────────────────
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await win.webContents.reload();
  await sleep(3500);
  await $(`location.hash = '#/p/${project.id}'; true`);
  await sleep(2000);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(500);
  await press(`[...document.querySelectorAll('.palette-row')].find(r => /关于/.test(r.textContent))`);
  await sleep(900);
  await press(`[...document.querySelectorAll('.side-row')].find(r => r.textContent.trim() === '主目录')`);
  await sleep(700);
  await press(button("注销账号…", "document.querySelector('.dlg-body')"));
  check("中文：确认注销账号", await until(`(${step}?.textContent ?? '').includes('注销你的 Tomrade 账号？')`), await stepText());
  await shot("account-delete-03-confirm-zh");
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
