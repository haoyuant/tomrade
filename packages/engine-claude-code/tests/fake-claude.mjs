import readline from 'node:readline';
import fs from 'node:fs';
const log = process.env.TOMRADE_TEST_LOG;
const session = 'fake-claude-session';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (log) fs.appendFileSync(log, JSON.stringify({ spawn: process.pid, args: process.argv.slice(2) }) + '\n');
let n = 0;
function result() {
  send({ type: 'result', subtype: 'success', is_error: false, result: 'hello', session_id: session,
    uuid: 'result-'+n, total_cost_usd: n*0.02, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 },
    modelUsage: {}, permission_denials: [] });
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify(m) + '\n');
  if (m.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id,
      response: m.request.subtype === 'initialize' ? { commands: [], models: [], agents: [], output_style: 'default', available_output_styles: [], account: {} } : {} } });
    if (m.request.subtype === 'interrupt') result();
  }
  if (m.type === 'user') {
    n++;
    send({ type: 'system', subtype: 'init', session_id: session, model: 'fixed-model', tools: [], mcp_servers: [], uuid: 'init-'+n });
    if (m.message.content.includes('WAIT_FOREVER')) continue;
    send({ type: 'stream_event', session_id: session, parent_tool_use_id: null, uuid: 'delta-'+n,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } });
    send({ type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: 'msg-'+n,
      message: { id: 'msg-'+n, role: 'assistant', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 10, output_tokens: 1 } } });
    result();
  }
}
