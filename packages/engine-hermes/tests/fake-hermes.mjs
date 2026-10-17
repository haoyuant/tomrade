// Stands in for Hermes v0.21.7 as Tomrade drives it: `config set|unset` on $HERMES_HOME/config.yaml (dotted keys),
// `plugins enable|disable`, and `-z PROMPT --usage-file F` answering with what it was given.
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Hermes Agent v0.21.7"); process.exit(0); }
if (process.env.FAKE_FAIL) { console.error("fake failure"); process.exit(1); }
const log = process.env.TOMRADE_TEST_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args }) + "\n");
const file = path.join(process.env.HERMES_HOME ?? ".", "config.yaml");
const read = () => (fs.existsSync(file) ? parse(fs.readFileSync(file, "utf8")) ?? {} : {});
const write = (config) => fs.writeFileSync(file, stringify(config));
if (args[0] === "config" && args[1] === "set") {
  const config = read();
  const keys = args[2].split(".");
  let at = config;
  for (const key of keys.slice(0, -1)) at = at[key] ??= {};
  at[keys.at(-1)] = /^\d+$/.test(args[3]) ? Number(args[3]) : args[3];
  write(config);
} else if (args[0] === "config" && args[1] === "unset") {
  const config = read();
  const keys = args[2].split(".");
  let at = config;
  for (const key of keys.slice(0, -1)) at = at?.[key];
  if (at) delete at[keys.at(-1)];
  write(config);
} else if (args[0] === "plugins") {
  const config = read();
  const enabled = new Set(config.plugins?.enabled ?? []);
  if (!fs.existsSync(path.join(process.env.HERMES_HOME, "plugins", args[2]))) { console.error(`Plugin '${args[2]}' not found`); process.exit(1); }
  if (args[1] === "enable") enabled.add(args[2]); else enabled.delete(args[2]);
  write({ ...config, plugins: { ...config.plugins, enabled: [...enabled] } });
} else if (args[0] === "-z") {
  const prompt = args[1];
  const usageFile = args[args.indexOf("--usage-file") + 1];
  if (prompt.includes("SIGNED_OUT")) {
    console.log("Model 'x' isn't available. Pick a different model with /model (or `hermes model` in a terminal).");
    fs.writeFileSync(usageFile, JSON.stringify({ failed: true, completed: false }));
    process.exit(2);
  }
  if (prompt.includes("FAIL")) {
    console.log("HTTP 500: upstream exploded");
    fs.writeFileSync(usageFile, JSON.stringify({ failed: true }));
    process.exit(2);
  }
  fs.writeFileSync(usageFile, JSON.stringify({ input_tokens: 12, output_tokens: 3, cache_read_tokens: 40, cache_write_tokens: 5, failed: false,
    auxiliary: { input_tokens: 7, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 } }));
  console.log(JSON.stringify({ args: args.slice(2), prompt, cwd: process.cwd() }));
}
