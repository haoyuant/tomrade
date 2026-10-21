/**
 * One-click agent setup (TOM-509): on the first-run screen each unready agent
 * has one Set up button that runs install → sign in → test message as a step
 * list. A scripted agent walks the four ways it can go: an install that fails
 * (network), a sign-in that waits on the browser, a test message the agent
 * cannot answer, and the full chain ending ready with the reply shown. Two
 * agents that run only in a terminal end on a check they can pass: one answer
 * from the model one lends, and found-and-signed-in for one that lends none.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:setup-chain
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boot } from "../dist/boot.js";
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-setup-chain-"));
app.setPath("userData", work);
quietStarters(work);
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// The scripted agent: not installed until the fake npm writes it; signed in once the flag says so;
// answers a prompt with "pong" only while its state flag says it works.
const signinFlag = path.join(work, "signin-state");
const stateFlag = path.join(work, "agent-state");
fs.writeFileSync(signinFlag, "out");
fs.writeFileSync(stateFlag, "broken");
const agentJs = path.join(work, "fake-agent.mjs");
fs.writeFileSync(
  agentJs,
  `import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("fake-agent 1.0.0"); process.exit(0); }
if (process.argv.includes("login")) {
  console.log("Open https://auth.example.test/device?code=XYZ in your browser to sign in");
  const until = Date.now() + 60_000;
  const poll = () => {
    if (fs.readFileSync(${JSON.stringify(signinFlag)}, "utf8").trim() === "in") process.exit(0);
    if (Date.now() > until) process.exit(1);
    setTimeout(poll, 100);
  };
  poll();
} else {
  const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
      const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } });
      else if (m.method === "session/new") {
        if (fs.readFileSync(${JSON.stringify(stateFlag)}, "utf8").trim() !== "works") send({ id: m.id, error: { code: -32603, message: "Model not found: default-model" } });
        else send({ id: m.id, result: { sessionId: "s1", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }] } });
      } else if (m.method === "session/prompt") {
        send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } } });
        send({ id: m.id, result: { stopReason: "end_turn" } });
      } else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "not here" } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
`
);
const bin = path.join(work, "bin", "fake-agent");
fs.mkdirSync(path.dirname(bin), { recursive: true });
// The terminal-only agents: any CLI answering --version will do, since Tomrade never drives one.
const termBins = { "fake-term": path.join(work, "bin", "fake-term"), "fake-term-quiet": path.join(work, "bin", "fake-term-quiet") };

// The fake npm: installing fake-agent writes the CLI; anything else fails the way a cut line does.
const npmJs = path.join(work, "fake-npm.mjs");
const npmRuns = path.join(work, "npm-runs");
fs.writeFileSync(
  npmJs,
  `import fs from "node:fs";
const pkg = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(npmRuns)}, process.argv.slice(2).join(" ") + "\\n");
if (pkg === "fake-agent") {
  console.error("npm http fetch GET 200 https://registry.npmjs.org/fake-agent 120ms (cache miss)");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  fs.writeFileSync(${JSON.stringify(bin)}, "#!/bin/sh\\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${agentJs}' \\"$@\\"\\n", { mode: 0o755 });
  console.log("added 1 package");
} else if (${JSON.stringify(Object.keys(termBins))}.includes(pkg)) {
  const bins = ${JSON.stringify(termBins)};
  fs.writeFileSync(bins[pkg], "#!/bin/sh\\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${agentJs}' \\"$@\\"\\n", { mode: 0o755 });
  console.log("added 1 package");
} else {
  console.error("npm ERR! code ENOTFOUND\\nnpm ERR! network request to https://registry.npmjs.org failed");
  process.exit(1);
}
`
);
const fakeNpm = path.join(work, "fake-npm");
fs.writeFileSync(fakeNpm, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${npmJs}' "$@"\n`, { mode: 0o755 });

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    // Only the scripted agents can answer: this machine's own stay out.
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-claude-code", "engine-codex", "engine-pi", "engine-pi-builtin"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", agent: { ...settings.agent, engines: { ...settings.agent?.engines, "fake-agent": { command: bin }, "fake-term": { command: termBins["fake-term"] }, "fake-term-quiet": { command: termBins["fake-term-quiet"] } } } });
  // Installers run through the fake npm, never the machine's.
  ctx.agentSetup.host = {
    platform: process.platform,
    env: process.env,
    answers: async () => false,
    npm: async () => ({ file: fakeNpm, argv: (args) => ({ command: fakeNpm, args }), env: (base = process.env) => base })
  };
  const signedIn = () => fs.readFileSync(signinFlag, "utf8").trim() === "in";
  ctx.localAgents.register({
    id: "fake-agent",
    title: "Fake Agent",
    cli: { name: "fake-agent" },
    install: "install Fake Agent",
    setup: { install: [{ npm: "fake-agent" }], signIn: "fake-agent login", signInRun: { args: ["login"] }, suggested: true },
    signedIn: { ask: () => (signedIn() ? true : false), reason: "Fake Agent is not signed in — run `fake-agent login`" },
    options: z.object({ command: z.string().optional() }),
    acp: { permissionModes: { default: "ask", choices: [{ value: "ask", label: "Ask" }] }, args: () => ["--acp"] },
    lend: { ask: async () => ({ text: "pong", inputTokens: 1, outputTokens: 1 }) }
  });
  // A second agent whose install can only fail: the registry is unreachable.
  ctx.localAgents.register({
    id: "bad-cli",
    title: "Bad CLI",
    cli: { name: "tomrade-no-such-bad-cli" },
    install: "install Bad CLI",
    setup: { install: [{ npm: "bad-cli" }], suggested: true }
  });

  // Terminal-only agents (Cursor, Antigravity): no ACP, so a test message would be a turn they never take.
  const termAsks = [];
  ctx.localAgents.register({
    id: "fake-term",
    title: "Fake Terminal",
    cli: { name: "tomrade-no-such-fake-term" },
    install: "install Fake Terminal",
    setup: { install: [{ npm: "fake-term" }], suggested: true },
    // The lending's own sign-in ping is not the test; only the test is counted.
    lend: { ask: async (request) => (request.transcript !== "ping" && termAsks.push(request.transcript), { text: "OK", inputTokens: 1, outputTokens: 1 }) }
  });
  ctx.localAgents.register({
    id: "fake-term-quiet",
    title: "Quiet Terminal",
    cli: { name: "tomrade-no-such-fake-term-quiet" },
    install: "install Quiet Terminal",
    setup: { install: [{ npm: "fake-term-quiet" }], suggested: true }
  });

  const win = new BrowserWindow({ width: 1280, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  const click = (selector) => $(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const wait = async (cond, what, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const stepState = (engine, step) => $(`document.querySelector('[data-testid="chain-${engine}"] [data-step="${step}"]')?.dataset.state ?? null`);
  const shot = async (name) => {
    await sleep(600);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };

  // ── the screen offers one button per unready agent, commands behind a disclosure ──
  check("the first run opens on connecting an AI", await wait(() => has('[data-testid="first-run-setup"]'), "first-run setup"));
  check("an unready agent has one Set up button", await wait(() => has('[data-testid="setup-run-fake-agent"]'), "set up button"));
  check("a missing agent from npm is also offered Tomrade's own copy", /Tomrade's own copy/.test((await text('[data-testid="setup-managed-fake-agent"]')) ?? ""), await text('[data-testid="setup-managed-fake-agent"]'));
  check("but not one that runs only in a terminal, which no test message reaches", !(await has('[data-testid="setup-managed-bad-cli"]')));
  check("the commands moved behind a Manual setup disclosure", (await $(`document.querySelector('[data-testid="manual-fake-agent"]')?.open ?? null`)) === false);
  await $(`document.querySelector('[data-testid="manual-fake-agent"]').open = true`);
  check("opened, the disclosure still offers the command and the terminal", await wait(() => has('[data-testid="install-fake-agent"]'), "manual install command"));
  await shot("setup-chain-01-buttons");

  // ── an install that fails says what went wrong, concretely ─────────────
  await click('[data-testid="setup-run-bad-cli"]');
  check("a failed install shows the step failed", await wait(async () => (await stepState("bad-cli", "install")) === "failed", "bad-cli install failed"), await stepState("bad-cli", "install"));
  const badError = await text('[data-testid="chain-error-install"]');
  check("and says the network was the problem", /network/i.test(badError ?? ""), badError);
  check("offering a retry through a reachable registry", await has('[data-testid="chain-error-install"] [data-testid="chain-retry-mirror"]'));
  await $(`document.querySelector('[data-testid="chain-bad-cli"]').scrollIntoView({ block: "center" })`);
  await shot("setup-chain-02-install-failed");
  await click('[data-testid="chain-bad-cli"] [data-testid="chain-retry-mirror"]');
  const lastNpm = () => fs.readFileSync(npmRuns, "utf8").trim().split("\n").at(-1);
  check("the mirror retry runs npm again with --registry only", await wait(() => lastNpm() === "install -g --loglevel http --registry https://registry.npmmirror.com bad-cli", "mirror run"), lastNpm());
  check("and fails again without offering the mirror twice", await wait(async () => (await stepState("bad-cli", "install")) === "failed" && !(await has('[data-testid="chain-bad-cli"] [data-testid="chain-retry-mirror"]')), "mirror run failed"));

  // ── the good agent: install runs, sign-in waits on the browser ─────────
  await click('[data-testid="setup-run-fake-agent"]');
  check("the running install shows npm's latest line", await wait(async () => /npm http fetch GET 200/.test((await text('[data-testid="chain-live-line"]')) ?? ""), "live line"));
  await $(`document.querySelector('[data-testid="chain-fake-agent"]').scrollIntoView({ block: "center" })`);
  await shot("setup-chain-03-installing");
  check("the install step finishes", await wait(async () => (await stepState("fake-agent", "install")) === "done", "install done"), await stepState("fake-agent", "install"));
  check("the sign-in step waits", await wait(async () => (await stepState("fake-agent", "sign-in")) === "waiting", "sign-in waiting"), await stepState("fake-agent", "sign-in"));
  check("with the address it caught from the agent", await wait(() => has('[data-testid="chain-signin-link"]'), "sign-in link"));
  await shot("setup-chain-04-signin-waiting");

  // ── signed in, but the agent cannot answer: the test message fails ─────
  fs.writeFileSync(signinFlag, "in");
  check("signing in moves the chain on", await wait(async () => (await stepState("fake-agent", "sign-in")) === "done", "sign-in done"), await stepState("fake-agent", "sign-in"));
  check("the test message fails with the agent's own words", await wait(() => has('[data-testid="chain-error-test"]'), "test error", 300), await stepState("fake-agent", "test"));
  const testError = await text('[data-testid="chain-error-test"]');
  check("naming the missing model", /Model not found/.test(testError ?? ""), testError);
  check("the agent does not count as configured", !(await has('[data-testid="setup-done"]')));
  check("its own copy failed the test, so Tomrade's own copy is offered", await has('[data-testid="setup-managed-fake-agent"]'));
  check("and the chain says the person's own copy is the one in use", (await $(`document.querySelector('[data-testid="chain-copy-fake-agent"]')?.dataset.copy ?? null`)) === "own");
  await shot("setup-chain-05-test-failed");

  // ── still broken: only a second test failure hands over to the troubleshooter ──
  check("one failure does not yet offer the troubleshooter", !(await has('[data-testid="chain-troubleshoot-fake-agent"]')));
  await click('[data-testid="setup-run-fake-agent"]');
  check("a retry that fails again offers the troubleshooter", await wait(() => has('[data-testid="chain-troubleshoot-fake-agent"]'), "troubleshoot link", 300));
  await shot("setup-chain-06-troubleshoot");

  // ── a terminal-only agent that lends a model: its test is one answer from it ──
  const health = (engine) => $(`document.querySelector('[data-engine="${engine}"]')?.dataset.health ?? null`);
  await click('[data-testid="setup-run-fake-term"]');
  check("a terminal-only agent's chain installs it", await wait(async () => (await stepState("fake-term", "install")) === "done", "fake-term install", 300), await stepState("fake-term", "install"));
  check("and ends on a test its lent model answers", await wait(async () => (await stepState("fake-term", "test")) === "done", "fake-term test", 300), await stepState("fake-term", "test"));
  check("asked once, outside any turn", termAsks.length === 1, termAsks);
  check("with the reply shown", ((await text('[data-testid="chain-fake-term"] [data-testid="chain-reply"]')) ?? "").includes("OK"), await text('[data-testid="chain-fake-term"]'));
  check("and the word that it runs in a terminal", await has('[data-testid="chain-fake-term"] [data-testid="chain-terminal-ready"]'));
  check("the row is ready for terminal tickets", (await health("fake-term")) === "works" && /terminal/i.test((await text('[data-engine="fake-term"] .setup-name')) ?? ""), [await health("fake-term"), await text('[data-engine="fake-term"] .setup-name')]);
  check("and never shows a failed test", !(await has('[data-testid="chain-fake-term"] [data-testid="chain-error-test"]')));
  await $(`document.querySelector('[data-testid="chain-fake-term"]').scrollIntoView({ block: "center" })`);
  await shot("setup-chain-07-terminal-lends");

  // ── one that lends none: found and signed in is the check, no test message at all ──
  await click('[data-testid="setup-run-fake-term-quiet"]');
  check("a terminal-only agent lending nothing ends on found and signed in", await wait(async () => (await stepState("fake-term-quiet", "terminal")) === "done", "fake-term-quiet terminal", 300), await stepState("fake-term-quiet", "terminal"));
  check("saying it runs in a terminal", await has('[data-testid="chain-fake-term-quiet"] [data-testid="chain-terminal-ready"]'));
  check("with no test step to fail", !(await has('[data-testid="chain-fake-term-quiet"] [data-step="test"]')) && !(await has('[data-testid="chain-fake-term-quiet"] [data-testid="chain-error-test"]')));
  check("and its row is ready", (await health("fake-term-quiet")) === "works", await health("fake-term-quiet"));
  check("neither counts as configured: neither can chat", !(await has('[data-testid="setup-done"]')));
  await $(`document.querySelector('[data-testid="chain-fake-term-quiet"]').scrollIntoView({ block: "center" })`);
  await shot("setup-chain-08-terminal-found");

  // ── fixed: retry runs only what is left and ends ready with the reply ──
  fs.writeFileSync(stateFlag, "works");
  await click('[data-testid="setup-run-fake-agent"]');
  check("the retry skips install and sign-in", await wait(async () => (await stepState("fake-agent", "test")) === "active" || (await stepState("fake-agent", "test")) === "done", "test running", 300));
  check("only now is Tomrade set", await wait(() => has('[data-testid="setup-done"]'), "done panel", 300));
  check("with the test reply visible", await wait(() => has('[data-testid="setup-done-reply"]'), "reply", 50), await text('[data-testid="setup-done"]'));
  check("and the reply is the agent's", ((await text('[data-testid="setup-done-reply"]')) ?? "").includes("pong"), await text('[data-testid="setup-done-reply"]'));
  await shot("setup-chain-09-ready");
  console.log(`screenshots in ${shots}`);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error(err);
    check("the check ran to the end", false);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed < results.length) console.log(`failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(" | ")}`);
  app.exit(passed === results.length ? 0 : 1);
});
