// Stands in for agy 1.4.0 print mode with stream-json in and out: answers with what it was given, or as agy does signed out.
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.4.0"); process.exit(0); }
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  const message = JSON.parse(input.trim());
  const prompt = message.message.content;
  if (prompt.includes("SIGNED_OUT")) {
    process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\nerror: authentication failed or timed out\n");
    say({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", usage: {} } });
    process.exit(1);
  }
  // Every print-mode conversation is kept, as agy does.
  const id = "6b2e3c6e-b011-4e79-9265-a91df85d7564";
  const dir = path.join(process.env.HOME, ".gemini", "antigravity-cli");
  for (const sub of ["conversations", "annotations", "presence", `brain/${id}`]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, "conversations", `${id}.db`), "");
  fs.writeFileSync(path.join(dir, "conversations", "0ther111-0000-4000-8000-000000000000.db"), "");
  fs.writeFileSync(path.join(dir, "annotations", `${id}.pbtxt`), "");
  fs.writeFileSync(path.join(dir, "presence", `${id}.lock`), "");
  say({ event: "init", conversation_id: id, init: { cwd: process.cwd(), tools: ["view_file", "run_command"], permission_mode: "request-review" } });
  if (prompt.includes("DENIED")) {
    process.stderr.write("jetski: no output produced — a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied.\n");
    say({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "", usage: {}, denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
    return;
  }
  const response = JSON.stringify({ args, event: message.event, role: message.message.role, prompt, cwd: process.cwd() });
  say({ event: "result", result: { conversation_id: id, status: "SUCCESS", response, num_turns: 1, usage: { input_tokens: 11784, output_tokens: 62, thinking_tokens: 61, cache_read_tokens: 40, total_tokens: 11846 } } });
});
