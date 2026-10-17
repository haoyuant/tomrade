// Stands in for `opencode run --format json` (1.19.3): answers with what it was given, or with an error event.
import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("1.19.3"); process.exit(0); }
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify({ timestamp: 1, sessionID: "ses_1", ...event }) + "\n");
  say({ type: "step_start", part: { type: "step-start" } });
  if (prompt.includes("SIGNED_OUT")) { say({ type: "error", error: { name: "ProviderAuthError", data: { message: "No API key found for provider anthropic" } } }); process.exit(1); }
  if (prompt.includes("FAIL")) { say({ type: "error", error: { name: "UnknownError", data: { message: "Unexpected server error" } } }); process.exit(0); }
  const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
  const agent = config.agent["tomrade-worker"];
  const system = fs.readFileSync(agent.prompt.slice("{file:".length, -1), "utf8");
  say({ type: "text", part: { type: "text", text: JSON.stringify({ args, prompt, system, permission: agent.permission, cwd: process.cwd() }) } });
  say({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { total: 60, input: 12, output: 3, reasoning: 0, cache: { read: 40, write: 5 } } } });
});
