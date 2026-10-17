// Stands in for `dsh --profile headless --patch <file> --json -` (DeepSeek Harness 0.2.0): answers with what it was given, or as dsh does without a key.
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.2.0"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  const patch = fs.readFileSync(args[args.indexOf("--patch") + 1], "utf8");
  const quoted = (key) => JSON.parse(patch.match(new RegExp(`${key}: (".*")`))[1]);
  const call = JSON.parse(fs.readFileSync(quoted("call"), "utf8"));
  const sessions = path.join(quoted("root"), "--cwd--", "session-1");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "session.v4.jsonl.zstd"), "");
  say({ type: "session", sessionId: "session-1", cwd: process.cwd() });
  say({ type: "status", phase: "turn_start", turn: 1 });
  if (prompt.includes("SIGNED_OUT") || prompt.includes("FAIL")) {
    const error = prompt.includes("FAIL")
      ? { message: "llm-deepseek: 402 Insufficient Balance", code: "PROVIDER_ERROR" }
      : { message: "llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment", code: "MISSING_CREDENTIAL" };
    say({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error } });
    say({ type: "final", text: "" });
    process.stderr.write(`dsh: ${error.code}: ${error.message}\n`);
    process.exit(1);
  }
  const answer = JSON.stringify({ args, prompt, cwd: process.cwd(), call, patch, plugin: fs.readFileSync(path.join(path.dirname(quoted("call")), "lent.mjs"), "utf8") });
  say({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 1975, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  say({ type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 169, outputTokens: 21, cacheReadTokens: 7040, cacheWriteTokens: 5 } });
  say({ type: "text", text: answer });
  say({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
  say({ type: "final", text: answer });
});
