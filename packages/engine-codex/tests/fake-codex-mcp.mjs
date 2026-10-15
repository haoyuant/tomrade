// Stands in for `codex mcp add/remove` as seen live (0.162.1): servers live in $CODEX_HOME/config.toml,
// and adding a name that exists replaces it.
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.162.1"); process.exit(0); }
if (process.env.FAKE_MCP_FAIL) { console.error("fake failure"); process.exit(1); }
const file = path.join(process.env.CODEX_HOME, "config.toml");
const config = fs.existsSync(file) ? parse(fs.readFileSync(file, "utf8")) : {};
const servers = config.mcp_servers ?? {};
if (args[1] === "add") servers[args[2]] = { url: args[4] };
else if (args[1] === "remove") delete servers[args[2]];
fs.writeFileSync(file, stringify({ ...config, mcp_servers: servers }));
