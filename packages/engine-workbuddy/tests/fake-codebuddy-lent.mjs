// Stands in for `codebuddy -p --output-format stream-json`: answers with what it was given, or as CodeBuddy 2.155 does signed out.
import fs from "node:fs";
if (process.argv.includes("--version")) {
  console.log("2.155.0");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  console.log("  --model <model>  Currently supported: (default-model, deepseek-v4.1-flash)");
  process.exit(0);
}
const log = process.env.TOMRADE_TEST_LOG;
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  if (log) fs.appendFileSync(log, JSON.stringify({ args, prompt }) + "\n");
  say({ type: "system", subtype: "init", session_id: "s1", tools: ["Read", "Bash"] });
  if (log && fs.existsSync(log + ".signed-out")) {
    const words = "Authentication required. Please use /login command to sign in to your account";
    say({ type: "assistant", message: { content: [{ type: "text", text: words }] } });
    say({ type: "result", subtype: "error_during_execution", is_error: true, result: null, errors: [words] });
    process.exit(0);
  }
  if (prompt.includes("FAIL")) {
    say({ type: "result", subtype: "error_during_execution", is_error: true, result: null, errors: ["400 model [nope] service info not found"] });
    process.exit(0);
  }
  const system = fs.readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("CODEBUDDY_")));
  say({ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } });
  say({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ args, prompt, system, env }), usage: { input_tokens: 52, output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 12 } });
});
