import readline from "node:readline";
import fs from "node:fs";
// FAKE_MODE: custom | openai-none | openai-signed | old | hang | stubborn; LOST_ROLLOUT=1 fails every thread/resume.
const mode = process.env.FAKE_MODE ?? "custom";
const log = process.env.TOMRADE_TEST_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ spawn: process.pid, argv: process.argv.slice(2) }) + "\n");
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (mode === "stubborn") process.on("SIGTERM", () => {});
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let n = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify(m) + "\n");
  if (mode === "hang" || mode === "stubborn") continue;
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "account/read") {
    if (mode === "old") send({ id: m.id, error: { code: -32601, message: "method not found" } });
    else send({ id: m.id, result: { account: mode === "openai-signed" ? { type: "apiKey" } : null, requiresOpenaiAuth: mode !== "custom" } });
  }
  if (m.method === "model/list") {
    if (mode === "old") send({ id: m.id, error: { code: -32601, message: "method not found" } });
    else send({ id: m.id, result: { data: [{ id: "m-1", model: "m-1", displayName: "Model One", hidden: false }, { id: "m-hidden", model: "m-hidden", hidden: true }] } });
  }
  if (m.method === "config/read") send({ id: m.id, result: { config: {} } });
  if (m.method === "thread/resume" && process.env.LOST_ROLLOUT) send({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${m.params.threadId}` } });
  else if (m.method === "thread/start" || m.method === "thread/resume") send({ id: m.id, result: { thread: { id: m.method === "thread/start" ? "new-session" : m.params.threadId }, model: "m-1" } });
  if (m.method === "turn/start") {
    const id = String(++n);
    send({ id: m.id, result: { turn: { id } } });
    // As Codex does: without it the client learns the turn's id only after awaiting the reply, and a
    // turn/completed read in the same chunk would go by first.
    send({ method: "turn/started", params: { threadId: "new-session", turn: { id } } });
    send({ method: "item/completed", params: { threadId: "new-session", turnId: id, item: { id: "msg-" + id, type: "agentMessage", text: "ok" } } });
    send({ method: "turn/completed", params: { threadId: "new-session", turn: { id, status: "completed" } } });
  }
}
