// Stands in for `codex exec --json`: reads the prompt from stdin and answers with Codex's JSONL events.
import fs from "node:fs";

let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  say({ type: "thread.started", thread_id: "t1" });
  // "HANG <file>": note this process in <file> and never answer.
  const hang = /^HANG (\S+)/m.exec(prompt);
  if (hang) {
    fs.writeFileSync(hang[1], String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes("FAIL")) {
    say({ type: "turn.failed", error: { message: "The model is not supported when using Codex with a ChatGPT account." } });
    process.exit(1);
  }
  say({ type: "item.completed", item: { type: "reasoning", text: "thinking" } });
  say({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ args: process.argv.slice(2), prompt }) } });
  say({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 8, output_tokens: 3 } });
});
