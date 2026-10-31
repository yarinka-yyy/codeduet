// Read-only app-server discovery in an already isolated CODEX_HOME.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const [codex, workspace] = process.argv.slice(2);
assert.ok(codex && workspace && process.env.CODEX_HOME);
const args = ['app-server', ...(process.env.DUET_DISABLE_PLUGINS ? ['--disable', 'plugins'] : [])];
const server = spawn(codex, args, { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const closed = once(server, 'close'), pending = new Map();
const lines = createInterface({ input: server.stdout });
let id = 0, stderr = '';
server.stderr.on('data', chunk => { stderr += chunk; });
lines.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const entry = pending.get(message.id);
  if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
});
function request(method, params) {
  const key = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Deadline: ' + method)); }, 45000);
    pending.set(key, { resolve, reject, timer });
    server.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
}
try {
  await request('initialize', { clientInfo: { name: 'code_duet_plugin_test', version: '1.0.0' } });
  server.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const result = await request('skills/list', { cwds: [workspace], forceReload: true });
  const row = result.data[0];
  assert.deepEqual(row.errors, []);
  const matches = row.skills.filter(skill => skill.name.includes('code-duet'));
  assert.equal(matches.length, 1, JSON.stringify(matches));
  assert.equal(matches[0].enabled, true);
  if (process.env.DUET_EXPECT_SKILL) assert.equal(realpathSync(matches[0].path), realpathSync(process.env.DUET_EXPECT_SKILL));
  console.log(JSON.stringify({ kind: 'plugin-discovered', skill: matches[0] }));
} catch (error) { console.error(stderr); throw error; }
finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  server.stdin.end();
  const timer = setTimeout(() => server.kill(), 5000);
  await closed; clearTimeout(timer); lines.close();
}
