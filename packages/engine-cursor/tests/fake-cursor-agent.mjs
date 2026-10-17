// Stands in for cursor-agent 2026.10.16: `status`, and `-p --output-format json` answering with what it was given.
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2026.10.16-e3cb207"); process.exit(0); }
if (args[0] === "status") { console.log(process.env.FAKE_CURSOR_SIGNED_OUT ? "Not logged in" : "✓ Logged in as someone@example.com"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  if (process.env.FAKE_CURSOR_SIGNED_OUT || prompt.includes("SIGNED_OUT")) {
    console.error("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.");
    process.exit(1);
  }
  const result = JSON.stringify({ args, prompt, cwd: process.cwd() });
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 10, result, session_id: "s-1", usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 3840, cacheWriteTokens: 2 } }));
});
