// Stands in for `codex exec --json`: reads the prompt from stdin and answers with Codex's JSONL events.
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  say({ type: "thread.started", thread_id: "t1" });
  if (prompt.includes("FAIL")) {
    say({ type: "turn.failed", error: { message: "The model is not supported when using Codex with a ChatGPT account." } });
    process.exit(1);
  }
  say({ type: "item.completed", item: { type: "reasoning", text: "thinking" } });
  say({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ args: process.argv.slice(2), prompt }) } });
  say({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } });
});
