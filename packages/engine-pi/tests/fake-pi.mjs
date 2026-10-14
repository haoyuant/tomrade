import fs from 'node:fs';
const log = process.env.TOMRADE_TEST_LOG;
const record = (value) => { if (log) fs.appendFileSync(log, JSON.stringify(value) + '\n'); };
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
record({ spawn: process.pid, argv: process.argv.slice(2), bridge: fs.readFileSync(process.argv[process.argv.indexOf('-e') + 1], 'utf8') });
const usage = (input, output) => ({ input, output, cacheRead: 7, cacheWrite: 1, totalTokens: input + output + 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } });
const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], provider: 'fake', model: 'fixed-model', usage: usage(10, 3), stopReason: 'stop', ...extra });
let waiting;
let dialog;
// STEER_HOLD keeps a steer queued (as pi does mid-tool); STEER_TAKE reads it right away
let steerMode;
let queued = [];
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

function settle(aborted = false) { send({ type: 'agent_end', messages: [], willRetry: false }); send({ type: 'agent_settled', aborted }); }

function handle(m) {
  record(m);
  if (m.type === 'extension_ui_response' && m.id === dialog) {
    send({ type: 'tool_execution_end', toolCallId: 'call-bash', toolName: 'bash', result: { content: [] }, isError: !m.confirmed, durationMs: 4 });
    send({ type: 'message_end', message: assistant(m.confirmed ? 'ran it' : 'skipped it') });
    settle();
  }
  if (m.type === 'steer') {
    send({ id: m.id, type: 'response', command: 'steer', success: true, data: { disposition: 'queued' } });
    if (steerMode === 'hold') { queued.push(m.message); return; }
    send({ type: 'message_start', message: { role: 'user', content: m.message, timestamp: Date.now() } });
    send({ type: 'message_end', message: { role: 'user', content: m.message, timestamp: Date.now() } });
    send({ type: 'message_end', message: assistant('took: ' + m.message) });
    waiting = undefined; steerMode = undefined;
    settle();
    return;
  }
  if (m.type === 'clear_queue') {
    send({ id: m.id, type: 'response', command: 'clear_queue', success: true, data: { steering: queued, followUp: [] } });
    queued = [];
    return;
  }
  if (m.type === 'abort') {
    send({ id: m.id, type: 'response', command: 'abort', success: true });
    if (waiting) { waiting = undefined; settle(true); }
  }
  if (m.type !== 'prompt') return;
  send({ id: m.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  send({ type: 'agent_start' });
  if (m.message.includes('WAIT_FOREVER')) { waiting = m.id; return; }
  if (m.message.includes('STEER_TAKE') || m.message.includes('STEER_HOLD')) { waiting = m.id; steerMode = m.message.includes('STEER_HOLD') ? 'hold' : 'take'; return; }
  if (m.message.includes('REQUEST_PERMISSION')) {
    dialog = 'ui-' + m.id;
    send({ type: 'tool_execution_start', toolCallId: 'call-bash', toolName: 'bash', args: { command: 'npm test' } });
    send({ type: 'extension_ui_request', id: dialog, method: 'confirm', title: 'Pi wants to use bash', message: '{"command":"npm test"}' });
    return;
  }
  if (m.message.includes('FLAKY')) {
    send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' });
    send({ type: 'auto_retry_end', success: true, attempt: 2 });
  }
  if (m.message.includes('FAIL')) {
    send({ type: 'message_end', message: assistant('', { stopReason: 'error', errorMessage: '401 invalid api key', content: [] }) });
    settle();
    return;
  }
  send({ type: 'message_update', usage: usage(10, 1), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel\u2028lo' } });
  send({ type: 'message_end', message: assistant('hel\u2028lo') });
  settle();
}
