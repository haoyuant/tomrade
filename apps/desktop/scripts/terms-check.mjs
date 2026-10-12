/**
 * Agreeing to the Terms of Service and Privacy Policy, against the real shell
 * and a stand-in for Supabase: the sign-in form asks for the tick before it
 * creates an account or signs in, the account records which version was
 * agreed, an account that never agreed (or agreed to an older version) is asked
 * once and can only agree or sign out, and Settings → About links to both.
 *
 *   pnpm --filter @tomrade/desktop test:terms      (needs the dev server up)
 */
import { app, BrowserWindow, shell } from "electron";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerExtensionResolution } from "../dist/extension-resolve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const WORK = "/tmp/tomrade-terms-check";
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

// No browser opens: the pages the app sends the person to are only recorded.
const opened = [];
shell.openExternal = async (url) => void opened.push(url);

/** Supabase Auth and the two Hub RPCs, for one person. Every other table reads as empty. */
async function fakeSupabase() {
  const state = { user: null, password: null, signUps: [], metaUpdates: [] };
  const jwt = (claims) => [{ alg: "HS256", typ: "JWT" }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".e2e";
  const session = () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return { access_token: jwt({ sub: state.user.id, email: state.user.email, role: "authenticated", exp }), refresh_token: "refresh-e2e", token_type: "bearer", expires_in: 3600, expires_at: exp, user: state.user };
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const url = new URL(req.url, "http://supabase");
      const input = body ? JSON.parse(body) : {};
      if (url.pathname === "/auth/v1/signup") {
        state.signUps.push(input);
        state.user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", aud: "authenticated", role: "authenticated", email: input.email, user_metadata: input.data ?? {}, app_metadata: {}, identities: [{ id: "i" }], created_at: new Date().toISOString() };
        state.password = input.password;
        return json(200, session());
      }
      if (url.pathname === "/auth/v1/token") {
        if (url.searchParams.get("grant_type") === "password" && (input.email !== state.user?.email || input.password !== state.password)) return json(400, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" });
        return json(200, session());
      }
      if (url.pathname === "/auth/v1/user") {
        if (req.method === "PUT") {
          state.metaUpdates.push(input.data);
          state.user = { ...state.user, user_metadata: { ...state.user.user_metadata, ...input.data } };
        }
        return json(200, state.user);
      }
      if (url.pathname === "/auth/v1/logout") return res.writeHead(204).end();
      if (url.pathname === "/rest/v1/rpc/tomrade_ensure_hub") return json(200, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      if (url.pathname === "/rest/v1/rpc/tomrade_mutate_hub") {
        const op = input.p_mutation;
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
  const { TERMS_VERSION } = await import("@tomradex/hub-cloud");
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
  const agreeBox = `document.querySelector('.account-agree input')`;
  const gateText = () => $(`document.querySelector('.account-gate')?.textContent ?? ''`);
  const prompt = `document.querySelector('.terms-prompt')`;
  const promptText = () => $(`${prompt}?.textContent ?? ''`);
  const fillForm = async (email, password) => {
    await typeInto(".account-gate input[type=email]", email);
    await typeInto(".account-gate input[type=password]", password);
    await sleep(200);
  };
  /** What a person who agreed before these terms existed looks like: nothing on the account, nothing on this computer. */
  const forget = async (accepted) => {
    supabase.state.user = { ...supabase.state.user, user_metadata: accepted ? { terms_version: accepted } : {} };
    ctx.cloudHub.cache.data.terms = null;
    ctx.cloudHub.cache.save();
    await ctx.cloudHub.client.auth.refreshSession();
  };

  // ── signing up asks for the tick ─────────────────────────────────────
  check("the sign-in form shows the terms box, unticked", await until(`!!${agreeBox} && !${agreeBox}.checked`), await gateText());
  check("naming both documents", /I agree to the Terms of Service and the Privacy Policy\./.test(await gateText()), await gateText());
  await press(button("Terms of Service", "document.querySelector('.account-agree')"));
  await press(button("Privacy Policy", "document.querySelector('.account-agree')"));
  await sleep(300);
  check("each opens on tomrade.com, without ticking the box", opened.join() === "https://tomrade.com/terms/,https://tomrade.com/privacy/" && !(await $(`${agreeBox}.checked`)), { opened, ticked: await $(`${agreeBox}.checked`) });
  await shot("terms-01-sign-in");

  await fillForm("new@example.test", "long enough");
  await press(button("Create account"));
  await sleep(600);
  check("Create account without the tick says what is missing", (await gateText()).includes("Tick this to agree to the Terms of Service and Privacy Policy first."), await gateText());
  check("and creates nothing", supabase.state.signUps.length === 0);
  check("with the focus on the box", await $(`document.activeElement === ${agreeBox}`));
  await shot("terms-02-not-ticked");

  await press(agreeBox);
  await sleep(200);
  check("ticking it clears the message", !(await gateText()).includes("Tick this"));
  await fillForm("new@example.test", "long enough");
  await press(button("Create account"));
  check("with the tick, the account is created", await until(`!document.querySelector('.account-gate')`), await gateText());
  check("carrying the version agreed to", supabase.state.signUps[0]?.data?.terms_version === TERMS_VERSION, supabase.state.signUps[0]?.data);
  await sleep(1500);
  check("and nothing more is asked", !(await $(`!!${prompt}`)));

  // ── an account from before the terms is asked once ───────────────────
  await forget(null);
  check("an account that never agreed is asked", await until(`!!${prompt}`), await promptText());
  check("saying the terms are new, with both documents to read", (await promptText()).includes("Tomrade now has Terms of Service and a Privacy Policy") && !!(await $(`!!${button("Terms of Service ↗", prompt)} && !!${button("Privacy Policy ↗", prompt)}`)), await promptText());
  check("with Agree holding the focus", (await $(`document.activeElement?.textContent.trim()`)) === "Agree and continue");
  check("and no way to close it but to agree or sign out", !(await $(`!!${prompt}.querySelector('.btn-icon')`)));
  await $(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);
  check("Escape leaves it up", await $(`!!${prompt}`));
  await shot("terms-03-prompt");
  opened.length = 0;
  await press(button("Privacy Policy ↗", prompt));
  await sleep(200);
  check("its links open the documents", opened.join() === "https://tomrade.com/privacy/", opened);
  const updates = supabase.state.metaUpdates.length;
  await press(button("Agree and continue", prompt));
  check("Agree puts it away", await until(`!${prompt}`), await promptText());
  check("and records the version on the account", supabase.state.metaUpdates.length === updates + 1 && supabase.state.metaUpdates.at(-1)?.terms_version === TERMS_VERSION, supabase.state.metaUpdates);
  await win.webContents.reload();
  await sleep(3500);
  check("it doesn't come back after a reload", !(await $(`!!${prompt}`)) && !(await $(`!!document.querySelector('.account-gate')`)));

  // ── changed terms are asked about again; declining signs out ─────────
  await forget("2026-01-01");
  check("an account that agreed to older terms is asked again", await until(`(${prompt}?.textContent ?? '').includes("We've updated the Terms of Service and Privacy Policy")`), await promptText());
  await press(button("Sign out", prompt));
  check("Sign out is the way to decline", await until(`!!document.querySelector('.account-gate')`) && !(await $(`!!${prompt}`)));
  const before = supabase.state.metaUpdates.length;
  await fillForm("new@example.test", "long enough");
  await press(button("Sign in"));
  await sleep(600);
  check("signing in asks for the tick too", (await gateText()).includes("Tick this to agree") && !!(await $(`!!document.querySelector('.account-gate')`)), await gateText());
  await press(agreeBox);
  await fillForm("new@example.test", "long enough");
  await press(button("Sign in"));
  check("ticked, it signs in", await until(`!document.querySelector('.account-gate')`), await gateText());
  await sleep(1500);
  check("records the new version", supabase.state.metaUpdates.length === before + 1 && supabase.state.metaUpdates.at(-1)?.terms_version === TERMS_VERSION, supabase.state.metaUpdates);
  check("and asks nothing more", !(await $(`!!${prompt}`)));

  // ── Settings → About links to both ───────────────────────────────────
  const project = ctx.projects.create({ name: "Terms", keyPrefix: "TM" });
  await ctx.storage.ready;
  await $(`location.hash = '#/p/${project.id}'; true`);
  await sleep(2500);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));true`);
  await sleep(500);
  await typeInto(".palette-input", "About");
  await sleep(400);
  await press(`[...document.querySelectorAll('.palette-row')].find(r => r.textContent.trim() === 'About Tomrade')`);
  await sleep(1000);
  opened.length = 0;
  await press(button("Terms of Service", "document.querySelector('.dlg-body')"));
  await press(button("Privacy Policy", "document.querySelector('.dlg-body')"));
  await sleep(300);
  check("About links to the Terms of Service and the Privacy Policy", opened.join() === "https://tomrade.com/terms/,https://tomrade.com/privacy/", opened);
  await shot("terms-04-about");

  // ── in Chinese ───────────────────────────────────────────────────────
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await forget(null);
  await win.webContents.reload();
  await sleep(3500);
  check("中文：提示用户条款和隐私政策", await until(`(${prompt}?.textContent ?? '').includes('Tomrade 现在有了用户条款和隐私政策')`), await promptText());
  opened.length = 0;
  await press(button("用户条款 ↗", prompt));
  await sleep(200);
  check("中文链接打开中文页面", opened.join() === "https://tomrade.com/zh/terms/", opened);
  await shot("terms-05-prompt-zh");
  await press(button("退出登录", prompt));
  await until(`!!document.querySelector('.account-gate')`);
  // The form rises in after the sunrise; the picture waits for it.
  await sleep(4000);
  check("中文登录表单：我已阅读并同意《用户条款》和《隐私政策》", (await gateText()).includes("我已阅读并同意《用户条款》和《隐私政策》。"), await gateText());
  await shot("terms-06-sign-in-zh");
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
