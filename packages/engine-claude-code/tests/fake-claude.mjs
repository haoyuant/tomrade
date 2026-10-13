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
    // cumulative across the turns this process served, as the real SDK reports it
    modelUsage: { 'fixed-model': { inputTokens: 10 * n, outputTokens: 3 * n, cacheReadInputTokens: 20 * n, cacheCreationInputTokens: 4 * n, webSearchRequests: 0, costUSD: n * 0.02, contextWindow: 200000, maxOutputTokens: 8192 } },
    permission_denials: [] });
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
    if (m.message.content.includes('FLAKY')) {
      // an attempt that drops mid-stream, the SDK's retry notice, then one round of Claude Code's own Bash
      send({ type: 'stream_event', session_id: session, parent_tool_use_id: null, uuid: 'dropped-'+n,
        event: { type: 'message_start', message: { id: 'dropped-'+n, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 } } } });
      send({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown', session_id: session, uuid: 'retry-'+n });
      send({ type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: 'tool-'+n,
        message: { id: 'tool-'+n, role: 'assistant', content: [{ type: 'tool_use', id: 'bash-'+n, name: 'Bash', input: { command: 'ls -la', description: 'List files' } }], usage: { input_tokens: 10, output_tokens: 1 } } });
      send({ type: 'user', session_id: session, parent_tool_use_id: null, uuid: 'result-tool-'+n,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-'+n, content: 'total 0', is_error: false }] } });
    }
    send({ type: 'stream_event', session_id: session, parent_tool_use_id: null, uuid: 'start-'+n,
      event: { type: 'message_start', message: { id: 'msg-'+n, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 } } } });
    send({ type: 'stream_event', session_id: session, parent_tool_use_id: null, uuid: 'delta-'+n,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } });
    send({ type: 'stream_event', session_id: session, parent_tool_use_id: null, uuid: 'mdelta-'+n,
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } });
    send({ type: 'stream_event', session_id: session, parent_tool_use_id: null, uuid: 'stop-'+n, event: { type: 'message_stop' } });
    send({ type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: 'msg-'+n,
      message: { id: 'msg-'+n, role: 'assistant', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 10, output_tokens: 1 } } });
    result();
  }
}
