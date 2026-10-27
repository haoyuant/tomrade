import { spawn } from "node:child_process";
import fs from "node:fs";
import { readConfig, runCli } from "./cli.js";

// The `tomrade` command, run as Node by the app's own binary (tomrade-command.ts writes its launcher). What it starts must not run as Node too.
delete process.env.ELECTRON_RUN_AS_NODE;
/** The folder as the shell names it ($PWD), not the one symlinks resolve to: the person sees, and their projects name, that one. */
const here = () => {
  const pwd = process.env.PWD;
  try {
    if (pwd && fs.realpathSync(pwd) === fs.realpathSync(process.cwd())) return pwd;
  } catch {
    // a folder gone meanwhile
  }
  return process.cwd();
};
const isDir = (dir: string) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

process.exitCode = await runCli(process.argv.slice(2), {
  config: () => readConfig(process.env.TOMRADE_CLI_CONFIG),
  cwd: here(),
  platform: process.platform,
  env: process.env,
  fetch,
  spawn,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isDir
});
