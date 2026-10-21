/**
 * An agent Tomrade installed itself, on a machine without Node (TOM-533): the
 * borrowed npm installs a stand-in Pi into Tomrade's own prefix, and the
 * terminal sign-in that follows runs it in a terminal whose PATH has neither
 * that prefix nor a node: the located file, with node through Tomrade's shims.
 * The terminal is faked: the script it is handed runs in bash with the PATH a
 * person's terminal has. Needs the bundled npm (`pnpm --filter @tomrade/desktop fetch:npm`).
 *
 *   pnpm build:backend   then
 *   pnpm --filter @tomrade/desktop test:terminal-signin
 */
import { app } from "electron";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminalApp } from "@tomradex/code-link";
import { boot } from "../dist/boot.js";
import { setUpBorrowedNode } from "../dist/borrowed-node.js";
import { nodeRuntime } from "../dist/node-runtime.js";
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-terminal-signin-"));
app.setPath("userData", work);
quietStarters(work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// A person's terminal on a machine without Node: the system folders and nothing else.
const BARE_PATH = "/usr/bin:/bin";
process.env.PATH = BARE_PATH;
const npmDir = path.join(dir, "../vendor/npm");
const borrowed = setUpBorrowedNode({ userData: work, npmDir, runtime: nodeRuntime() });

// The stand-in Pi: an npm package whose bin is a node script, as Pi's is; signing in leaves a flag.
const name = "tomrade-stand-in-pi";
const flag = path.join(work, "signed-in");
const pkg = path.join(work, "stand-in-pi");
fs.mkdirSync(pkg);
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, version: "1.0.0", bin: { [name]: "cli.js" } }));
fs.writeFileSync(
  path.join(pkg, "cli.js"),
  `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("${name} 1.0.0"); process.exit(0); }
if (process.argv[2] === "login") { fs.writeFileSync(${JSON.stringify(flag)}, "in"); console.log("signed in"); }
`,
  { mode: 0o755 }
);

const run = async () => {
  check("this machine's bare PATH has no node", !BARE_PATH.split(":").some((d) => fs.existsSync(path.join(d, "node"))));
  check("the bundled npm is here", !borrowed.problem, borrowed.problem);
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-claude-code", "engine-codex", "engine-pi", "engine-pi-builtin"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  // The system terminal, never herdr: the fake below stands in for it.
  ctx.settings.set({ ...settings, language: "en", codeLink: { ...settings.codeLink, terminal: "Terminal" } });
  ctx.localAgents.register({
    id: "stand-in-pi",
    title: "Stand-in Pi",
    cli: { name },
    install: "install Stand-in Pi",
    setup: { install: [{ npm: pkg }], signIn: `${name} login`, signInRuns: true, suggested: true },
    signedIn: { ask: () => fs.existsSync(flag), reason: "Stand-in Pi is not signed in" }
  });
  await sleep(200);

  // ── install with the borrowed npm, as one-click setup does ─────────────
  ctx.agentSetup.start("stand-in-pi", "install");
  const settled = async (step) => {
    for (let i = 0; i < 600; i++) {
      const state = ctx.agentSetup.state("stand-in-pi");
      if (state?.step === step && (state.phase === "done" || state.phase === "failed")) return state;
      await sleep(100);
    }
    return ctx.agentSetup.state("stand-in-pi");
  };
  const installed = await settled("install");
  check("the borrowed npm installs it", installed?.phase === "done", installed);
  const bin = path.join(borrowed.prefixBin, name);
  check("into Tomrade's own prefix", fs.existsSync(bin), fs.readdirSync(borrowed.prefixBin));
  const bare = spawnSync("/bin/bash", ["-c", `${name} login`], { encoding: "utf8", env: { HOME: work, PATH: BARE_PATH } });
  check("where the person's terminal finds no command of that name", bare.status === 127 && /not found/.test(bare.stderr), bare);

  // ── sign in through the terminal ───────────────────────────────────────
  const opened = [];
  terminalApp.open = async (terminal, script) => void opened.push({ terminal, script });
  const { launched, command } = await ctx.codeLink.setupInTerminal("stand-in-pi", "signIn");
  check("the sign-in opens in the terminal", launched && opened.length === 1, { launched, opened });
  check("running the file Tomrade located, not the bare name", command === `'${bin}' login`, command);
  const script = opened[0]?.script;
  const out = script ? spawnSync("/bin/bash", [script], { encoding: "utf8", env: { HOME: work, PATH: BARE_PATH, SHELL: "/usr/bin/true" } }) : null;
  check("in a terminal with no Node, the command is found and runs", out?.status === 0 && /signed in/.test(out.stdout) && !/not found/.test(out.stderr), out && { status: out.status, stdout: out.stdout, stderr: out.stderr });
  check("and it signed in", fs.existsSync(flag));
  const written = script ? fs.readFileSync(script, "utf8") : "";
  check("node comes from Tomrade's shims, behind the terminal's own PATH", written.includes(`:"$PATH":'${borrowed.binDir}'`), written);
  const node = script ? execFileSync("/bin/bash", ["-c", `${written.split("\n").find((l) => l.startsWith("export PATH="))}; command -v node`], { encoding: "utf8", env: { PATH: BARE_PATH } }).trim() : "";
  check("so the node that runs it is the borrowed one", node === path.join(borrowed.binDir, "node"), node);

  // ── and setup sees it signed in ────────────────────────────────────────
  ctx.agentSetup.start("stand-in-pi", "sign-in");
  const signedIn = await settled("sign-in");
  check("one-click setup counts the sign-in done", signedIn?.phase === "done", signedIn);
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
