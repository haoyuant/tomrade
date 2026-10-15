// Stands in for `claude mcp add/remove --scope user` as seen live (2.1.300): user servers live in
// $CLAUDE_CONFIG_DIR/.claude.json, and adding a name that exists fails.
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (process.env.FAKE_MCP_FAIL) { console.error("fake failure"); process.exit(1); }
const file = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const servers = config.mcpServers ?? {};
const name = args.at(args[1] === "add" ? -2 : -1);
if (args[1] === "add") {
  if (servers[name]) { console.error(`MCP server ${name} already exists in user config`); process.exit(1); }
  servers[name] = { type: "http", url: args.at(-1) };
} else if (args[1] === "remove") {
  if (!servers[name]) { console.error(`No MCP server named "${name}" in user scope`); process.exit(1); }
  delete servers[name];
}
fs.writeFileSync(file, JSON.stringify({ ...config, mcpServers: servers }, null, 2));
