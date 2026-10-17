// Stands in for `pi -p --mode json`: answers with what it was given, or as pi 1.3 does with no credentials.
import fs from "node:fs";
if (process.argv.includes("--version")) {
  console.log("1.3.0");
  process.exit(0);
}
const log = process.env.TOMRADE_TEST_LOG;
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  if (log) fs.appendFileSync(log, JSON.stringify({ args, prompt }) + "\n");
  say({ type: "session", version: 3, id: "s1", cwd: process.cwd() });
  if (log && fs.existsSync(log + ".signed-out")) {
    process.stderr.write("No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.\n");
    process.exit(1);
  }
  say({ type: "agent_start" });
  say({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  if (prompt.includes("FAIL")) {
    say({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 model not found" } });
    process.exit(0);
  }
  const system = fs.readFileSync(args[args.indexOf("--system-prompt") + 1], "utf8");
  const env = { TOMRADE_MCP_TOKEN: process.env.TOMRADE_MCP_TOKEN ?? null };
  say({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: JSON.stringify({ args, prompt, system, cwd: process.cwd(), env }) }],
    stopReason: "stop", usage: { input: 12, output: 3, cacheRead: 40, cacheWrite: 5, totalTokens: 60 } } });
  say({ type: "agent_end", messages: [] });
});
