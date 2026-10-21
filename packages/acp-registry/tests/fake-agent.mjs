// A registry agent as npx would start it: signed in once FAKE_SIGNED exists, which its own `authenticate` writes.
import fs from 'node:fs';

if (process.argv.includes('--version')) { console.log('10.9.0'); process.exit(0); }

const log = process.env.FAKE_LOG;
const signed = () => fs.existsSync(process.env.FAKE_SIGNED);
const record = (value) => { if (log) fs.appendFileSync(log, JSON.stringify(value) + '\n'); };
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const authRequired = (id) => send({ id, error: { code: -32000, message: 'Authentication required' } });
record({ argv: process.argv.slice(2) });

const METHODS = [
  { id: 'browser', name: 'Log in with a browser', description: 'Opens your browser' },
  { id: 'terminal-login', name: 'Log in from the terminal', type: 'terminal', args: ['--login'], env: { FAKE_LOGIN: '1' } },
  { id: 'key', name: 'API key', type: 'env_var', description: 'Set FAKE_KEY' }
];

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(m) {
  if (m.method === undefined) return;
  record({ method: m.method, params: m.params });
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: METHODS } });
    case 'session/new':
      return signed() ? send({ id: m.id, result: { sessionId: 's1' } }) : authRequired(m.id);
    case 'authenticate':
      if (p.methodId !== 'browser') return send({ id: m.id, error: { code: -32602, message: `no method ${p.methodId}` } });
      process.stderr.write('Open https://example.test/login?code=1 to sign in\n');
      return void setTimeout(() => { fs.writeFileSync(process.env.FAKE_SIGNED, 'yes'); send({ id: m.id, result: {} }); }, 100);
    case 'session/prompt':
      if (!signed()) return authRequired(m.id);
      send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } } } });
      return send({ id: m.id, result: { stopReason: 'end_turn' } });
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
}
