// npm as Tomrade uses it here: its global folder is FAKE_NPM_ROOT, and `install -g name@version` puts the package there.
import fs from 'node:fs';
import path from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const root = process.env.FAKE_NPM_ROOT;
if (command === '--version') console.log('10.9.0');
else if (command === 'root') console.log(root);
else if (command === 'install') {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ npm: process.argv.slice(2) }) + '\n');
  const spec = rest.at(-1);
  const at = spec.lastIndexOf('@');
  const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
  console.log(`npm http fetch GET 200 https://registry.npmjs.org/${name} 12ms`);
  // Long enough for the setup's state to be read while it runs.
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, version }));
} else process.exit(1);
