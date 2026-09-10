import readline from 'node:readline';
import fs from 'node:fs';
const log = process.env.TOMRADE_TEST_LOG;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (log) fs.appendFileSync(log, JSON.stringify({ spawn: process.pid }) + '\n');
let n = 0;
let active;
let permissionTurn;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify(m) + '\n');
  if (m.id === 'permission-request' && m.result) {
    send({ method: 'turn/completed', params: { threadId: 'fake-session', turn: { id: permissionTurn, status: 'completed' } } });
  }
  if (m.method === 'config/read') send({ id: m.id, result: { config: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } } });
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'fake-session' }, model: 'fixed-model' } });
  if (m.method === 'turn/start') {
    const id = String(++n); active = id;
    send({ id: m.id, result: { turn: { id } } });
    send({ method: 'turn/started', params: { threadId: 'fake-session', turn: { id } } });
    if (m.params.input[0].text.includes('WAIT_FOREVER')) continue;
    if (m.params.input[0].text.includes('REQUEST_PERMISSION')) {
      permissionTurn = id;
      send({ id: 'permission-request', method: 'item/commandExecution/requestApproval', params: { threadId: 'fake-session', turnId: id, command: 'npm test', cwd: process.cwd() } });
      continue;
    }
    send({ method: 'item/agentMessage/delta', params: { threadId: 'wrong-thread', turnId: id, delta: 'WRONG' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'fake-session', turnId: id, delta: 'hello' } });
    const last = { inputTokens: 10, outputTokens: 3, cachedInputTokens: 7, cacheWriteInputTokens: 1 };
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'fake-session', turnId: id, tokenUsage: { last, total: Object.fromEntries(Object.entries(last).map(([k,v])=>[k,v*n])) } } });
    send({ method: 'item/completed', params: { threadId: 'fake-session', turnId: id, item: { id: 'msg-'+id, type: 'agentMessage', text: 'hello' } } });
    send({ method: 'turn/completed', params: { threadId: 'fake-session', turn: { id, status: 'completed' } } });
  }
  if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'fake-session', turn: { id: active, status: 'interrupted' } } });
  }
}
