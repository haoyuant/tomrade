import readline from 'node:readline';
import fs from 'node:fs';
// Answers each message with how many it has seen since the last /clear; CRASH_ONCE exits the first process that reads it.
const log = process.env.TOMRADE_TEST_LOG;
const record = (value) => log && fs.appendFileSync(log, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--version')) { console.log('2.1.301 (Claude Code)'); process.exit(0); }
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: !fs.existsSync(log + '.signed-out') })); process.exit(0); }
record({ spawn: process.pid, args: process.argv.slice(2) });
let seen = 0;
const result = (text) => send({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's', uuid: 'r' + Math.random(),
  total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 5, output_tokens: 2 }, modelUsage: {}, permission_denials: [] });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id,
      response: m.request.subtype === 'initialize' ? { commands: [], models: [], agents: [], output_style: 'default', available_output_styles: [], account: {} } : {} } });
    continue;
  }
  if (m.type !== 'user') continue;
  const content = typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content);
  record({ pid: process.pid, content });
  if (content === '/clear') { seen = 0; result(''); continue; }
  seen += 1;
  if (content.includes('CRASH_ONCE') && !fs.existsSync(log + '.crashed')) { fs.writeFileSync(log + '.crashed', ''); process.exit(1); }
  if (content.includes('WAIT_FOREVER')) continue;
  if (content.includes('SLOW')) await new Promise((r) => setTimeout(r, 300));
  result(JSON.stringify({ seen }));
}
