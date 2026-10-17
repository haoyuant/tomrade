// Stands in for `codebuddy mcp add/remove --scope user` as seen live (2.155.0): user servers live in
// $CODEBUDDY_CONFIG_DIR/.mcp.json, adding a name that exists replaces it, removing a missing one fails.
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.155.0"); process.exit(0); }
if (process.env.FAKE_MCP_FAIL) { console.error("fake failure"); process.exit(1); }
const file = path.join(process.env.CODEBUDDY_CONFIG_DIR, ".mcp.json");
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const servers = config.mcpServers ?? {};
const name = args.at(args[1] === "add" ? -2 : -1);
if (args[1] === "add") {
  servers[name] = { args: [], print: true, url: args.at(-1), type: "http" };
} else if (args[1] === "remove") {
  if (!servers[name]) { console.error(`No user-scoped MCP server found with name: ${name}`); process.exit(1); }
  delete servers[name];
}
fs.writeFileSync(file, JSON.stringify({ ...config, mcpServers: servers, disabledMcpServers: config.disabledMcpServers ?? [] }, null, 2));
