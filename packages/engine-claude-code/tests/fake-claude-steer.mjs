// Stands in for the Claude Code CLI the way it handles messages queued mid-turn (seen live, 2026-10-14 and
// 2026-10-30): a "next" message queued while a tool runs joins the next request of the same turn, and the turn's
// result lists it in user_message_uuids; one that misses the last request runs as its own turn right after,
// stamped on its first frame. An interrupt cuts a running tool: its result comes back as an error and the turn
// ends as error_during_execution, naming only what it answered; a "now" message then runs as its own turn.
import readline from 'node:readline';
import fs from 'node:fs';
const log = process.env.TOMRADE_TEST_LOG;
const session = 'fake-claude-session';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (log) fs.appendFileSync(log, JSON.stringify({ spawn: process.pid }) + '\n');
let n = 0;
let busy = false;
let cut;
const queued = [];
const text = (m) => (typeof m.message.content === 'string' ? m.message.content : m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
const said = (t, stamp) => send({ type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: 'a-' + Math.random(), ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}),
  message: { id: 'm-' + Math.random(), role: 'assistant', content: [{ type: 'text', text: t }], usage: { input_tokens: 10, output_tokens: 1 } } });
const result = (uuids, t, failed) => {
  n++;
  send({ type: 'result', ...(failed ? { subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] } : { subtype: 'success', is_error: false, result: t }), session_id: session, uuid: 'r-' + n, total_cost_usd: n * 0.02, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: { m: { inputTokens: 10 * n, outputTokens: 3 * n, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: n * 0.02, contextWindow: 200000, maxOutputTokens: 8192 } },
    permission_denials: [], user_message_uuid: uuids.at(-1), user_message_uuids: uuids });
};
async function late() {
  for (const late = queued.splice(0); late.length; late.length = 0) {
    send({ type: 'system', subtype: 'init', session_id: session, model: 'fixed-model', tools: [], mcp_servers: [], uuid: 'init-late' });
    said('only the addition: ' + text(late[0]).split('\n')[0], late.map((l) => l.uuid));
    result(late.map((l) => l.uuid), 'addition');
  }
}
async function run(m) {
  busy = true;
  const prompt = text(m);
  send({ type: 'system', subtype: 'init', session_id: session, model: 'fixed-model', tools: [], mcp_servers: [], uuid: 'init-' + n });
  if (prompt.includes('TOOL_STEER') || prompt.includes('HOLD_STEER')) {
    send({ type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: 'tool', user_message_uuid: m.uuid, user_message_uuids: [m.uuid],
      message: { id: 'tool', role: 'assistant', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sleep 1' } }], usage: { input_tokens: 10, output_tokens: 1 } } });
    if (prompt.includes('HOLD_STEER')) return; // the tool never ends; only a stop gets out
    if (await Promise.race([sleep(400).then(() => false), new Promise((r) => { cut = () => r(true); })])) {
      send({ type: 'user', session_id: session, parent_tool_use_id: null, uuid: 'tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: "The user doesn't want to proceed with this tool use.", is_error: true }] } });
      send({ type: 'user', session_id: session, parent_tool_use_id: null, uuid: 'cut', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
      result([m.uuid], '', true);
      await late();
      busy = false;
      return;
    }
    cut = undefined;
    const joined = queued.splice(0);
    send({ type: 'user', session_id: session, parent_tool_use_id: null, uuid: 'tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'ok', is_error: false }] } });
    said(joined.length ? 'took: ' + text(joined[0]).split('\n')[0] : 'no steer');
    result([m.uuid, ...joined.map((j) => j.uuid)], 'done');
  } else if (prompt.includes('LATE_STEER')) {
    said('first answer', [m.uuid]);
    await sleep(400);
    result([m.uuid], 'first answer');
    await late();
  } else {
    said(m.priority === 'now' ? 'took: ' + prompt.split('\n')[0] : 'hello', [m.uuid]);
    result([m.uuid], 'hello');
  }
  busy = false;
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify(m) + '\n');
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') { cut?.(); cut = undefined; }
  if (m.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id,
      response: m.request.subtype === 'initialize' ? { commands: [], models: [], agents: [], output_style: 'default', available_output_styles: [], account: {} } : {} } });
  }
  if (m.type === 'user') {
    if (busy) queued.push(m);
    else void run(m);
  }
}
