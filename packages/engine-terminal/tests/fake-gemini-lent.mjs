// Stands in for `gemini -p "" -o stream-json`: answers with what it was given, or as Gemini CLI 0.64 does signed out.
import fs from "node:fs";
import path from "node:path";
if (process.argv.includes("--version")) {
  console.log("0.64.0");
  process.exit(0);
}
const log = process.env.TOMRADE_TEST_LOG;
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  if (log) fs.appendFileSync(log, JSON.stringify({ args, prompt }) + "\n");
  if (log && fs.existsSync(log + ".personal")) {
    // As 0.64.0 answers a personal Google sign-in now: an ordinary error exit.
    process.stderr.write("Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google\n");
    process.exit(1);
  }
  if (log && fs.existsSync(log + ".signed-out")) {
    process.stderr.write("    at async main (gemini.js:17559:9) {\n  exitCode: 41\n}\n\x1b[31mManual authorization is required but the current session is non-interactive.\x1b[0m\n");
    process.exit(41);
  }
  // Every headless session is saved under the project's short name, as Gemini CLI does.
  const id = "a7fab9b3-b450-4950-8061-f81fce83210a";
  const home = path.join(process.env.GEMINI_CLI_HOME, ".gemini");
  const chats = path.join(home, "tmp", "tomrade-gemini-lent", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: { [process.cwd()]: "tomrade-gemini-lent" } }));
  fs.writeFileSync(path.join(chats, `session-2026-10-16T16-32-${id.slice(0, 8)}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(chats, "session-2026-10-01T09-00-0ther111.jsonl"), "{}\n");
  say({ type: "init", session_id: id, model: "flash" });
  say({ type: "message", role: "user", content: prompt });
  if (prompt.includes("FAIL")) {
    say({ type: "result", status: "error", error: { type: "Error", message: "You have exhausted your daily quota on this model." }, stats: {} });
    process.exit(1);
  }
  const answer = JSON.stringify({
    args,
    prompt,
    system: fs.readFileSync(process.env.GEMINI_SYSTEM_MD, "utf8"),
    env: { NO_BROWSER: process.env.NO_BROWSER, GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE, GEMINI_SANDBOX: process.env.GEMINI_SANDBOX },
    settings: JSON.parse(fs.readFileSync(path.join(process.cwd(), ".gemini", "settings.json"), "utf8"))
  });
  say({ type: "message", role: "assistant", content: answer.slice(0, 20), delta: true });
  say({ type: "message", role: "assistant", content: answer.slice(20), delta: true });
  say({ type: "result", status: "success", stats: { total_tokens: 49, input_tokens: 42, output_tokens: 7, cached: 30, input: 12 } });
});
