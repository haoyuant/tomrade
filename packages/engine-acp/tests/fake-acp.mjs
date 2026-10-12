// A scripted ACP agent. FAKE_STYLE=hermes answers with modes/models instead of config options.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const log = process.env.TOMRADE_TEST_LOG;
const style = process.env.FAKE_STYLE ?? 'config';
const record = (value) => { if (log) fs.appendFileSync(log, JSON.stringify(value) + '\n'); };
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
record({ spawn: process.pid, argv: process.argv.slice(2) });
process.stdout.write('not json: a log line on stdout\n');

const config = () => [
  { id: 'mode', name: 'Permission Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Always Ask' }, { value: 'bypass', name: 'Bypass' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: '["fake","small"]', options: [{ group: 'fake', name: 'Fake', options: [{ value: '["fake","small"]', name: 'small' }, { value: '["fake","large"]', name: 'Large', description: 'x2 credits' }] }] },
  { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }
];
const sessions = new Map();
let nextRequest = 1000;
const asked = new Map();
let waiting;

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

function opened(sessionId) {
  if (style === 'hermes') return { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'dont_ask', name: "Don't Ask" }] },
    models: { currentModelId: 'openrouter:a', availableModels: [{ modelId: 'openrouter:a', name: 'a', description: 'Provider: OpenRouter • current' }, { modelId: 'openrouter:b', name: 'b' }] } };
  return { configOptions: sessions.get(sessionId).config };
}

function handle(m) {
  record(m);
  if (m.id !== undefined && m.method === undefined) {
    const resolve = asked.get(m.id);
    if (resolve) { asked.delete(m.id); resolve(m.result); }
    return;
  }
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize': {
      const caps = process.env.FAKE_CAPS ? JSON.parse(process.env.FAKE_CAPS)
        : { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } };
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: caps, authMethods: [] } });
    }
    case 'session/new': {
      const sessionId = randomUUID();
      sessions.set(sessionId, { config: config(), turns: 0 });
      // Some agents tell their settings before the session id is out.
      update(sessionId, { sessionUpdate: 'config_option_update', configOptions: config() });
      return send({ id: m.id, result: { sessionId, ...opened(sessionId) } });
    }
    case 'session/resume':
    case 'session/load': {
      if (p.sessionId === 'gone') return send({ id: m.id, ...(m.method === 'session/load' ? { result: null } : { error: { code: -32002, message: 'Resource not found' } }) });
      sessions.set(p.sessionId, { config: config(), turns: 1 });
      // A load replays the history before it answers.
      if (m.method === 'session/load') update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } });
      return send({ id: m.id, result: opened(p.sessionId) });
    }
    case 'session/set_config_option': {
      const session = sessions.get(p.sessionId);
      const option = session.config.find((o) => o.id === p.configId);
      const values = option.options.flatMap((o) => o.options ?? [o]).map((o) => o.value);
      if (!values.includes(p.value)) return send({ id: m.id, error: { code: -32602, message: `no such value ${p.value}` } });
      option.currentValue = p.value;
      return send({ id: m.id, result: { configOptions: session.config } });
    }
    case 'session/set_mode':
    case 'session/set_model':
      return send({ id: m.id, result: {} });
    case 'session/cancel':
      if (waiting) { send({ id: waiting, result: { stopReason: 'cancelled' } }); waiting = undefined; }
      return;
    case 'session/prompt':
      return void prompt(m.id, p).catch((error) => send({ id: m.id, error: { code: -32603, message: String(error) } }));
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
}

function ask(method, params) {
  const id = nextRequest++;
  send({ id, method, params });
  return new Promise((resolve) => asked.set(id, resolve));
}

async function prompt(id, p) {
  const sid = p.sessionId;
  const text = p.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const usage = (input, output, hit) => ({ sessionUpdate: 'usage_update', used: input, size: 1000, cost: { amount: 0.25 * sessions.get(sid).turns, currency: 'USD' },
    _meta: { usage: { prompt_tokens: input, completion_tokens: output, prompt_cache_hit_tokens: hit } } });
  sessions.get(sid).turns++;
  if (text.includes('WAIT_FOREVER')) { waiting = id; return; }
  if (text.includes('CRASH')) process.exit(3);
  if (text.includes('FAIL')) return send({ id, error: { code: -32000, message: 'Authentication required' } });
  if (text.includes('REFUSE_SAYING')) return send({ id, result: { stopReason: 'refusal', _meta: { reason: 'upstream said no' } } });
  if (text.includes('REFUSE')) return send({ id, result: { stopReason: 'refusal' } });
  if (text.includes('SILENT')) {
    // As Hermes does: a call starts and is asked about, and its end is never reported.
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'write: /work/tomrade-next/notes.md', kind: 'edit', rawInput: { path: 'notes.md' } });
    await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't3', title: 'write: /work/tomrade-next/notes.md', kind: 'edit' }, options: [
      { optionId: 'yes', name: 'Allow edit', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (text.includes('TOOL')) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run npm test', name: 'Bash', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
    // As dsh does: the permission request names the call by id alone.
    const said = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't1' }, options: [
      { optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
    const allowed = said.outcome.outcome === 'selected' && said.outcome.optionId !== 'no';
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed' });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'mcp__tomrade__list_items', kind: 'other', status: 'pending' });
    const mcp = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't2', title: 'mcp__tomrade__list_items' }, options: [
      { optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: mcp.outcome.optionId === 'yes' ? 'completed' : 'failed' });
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm3', content: { type: 'text', text: allowed ? 'ran it' : 'skipped it' } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hel' } });
  update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' lo' } });
  update(sid, usage(100, 3, 60));
  update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'bye' } });
  update(sid, usage(120, 2, 100));
  const turns = sessions.get(sid).turns;
  return send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 50 * turns, outputTokens: 5 * turns, totalTokens: 55 * turns, cachedReadTokens: 10 * turns } } });
}
