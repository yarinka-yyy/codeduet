// Explicit metadata/GET-only smoke; no threads, turns, pair creation or prompt submission.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { packageSkill } from '../tools/package.mjs';

const [codex, evidenceRoot] = process.argv.slice(2);
assert.ok(process.argv.length === 4 && isAbsolute(codex) && isAbsolute(evidenceRoot),
  'Usage: node tests/package-smoke.mjs <absolute-codex-exe> <absolute-new-evidence-directory>');
assert.ok(!existsSync(evidenceRoot), 'Use a new evidence directory, never overwrite an earlier run');
mkdirSync(evidenceRoot);
const workspace = join(evidenceRoot, 'isolated space & test');
const skillsRoot = join(workspace, '.agents', 'skills'); mkdirSync(skillsRoot, { recursive: true });
const destination = join(skillsRoot, 'code-duet');
const statePath = join(homedir(), '.local', 'state', 'code-duet', 'state.json');
const digest = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const stateBefore = digest(statePath);
const registrationPath = join(homedir(), '.local', 'state', 'opencode', 'service.json');
const registrationBefore = digest(registrationPath);
const configPath = join(homedir(), '.codex', 'config.toml'), configBefore = digest(configPath);
const packaged = packageSkill(destination);
const codexHome = join(evidenceRoot, 'isolated-codex-home'); mkdirSync(codexHome);
const server = spawn(codex, ['app-server'], { cwd: workspace,
  env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const closed = once(server, 'close');
const lines = createInterface({ input: server.stdout });
let stderr = ''; server.stderr.on('data', chunk => { stderr += chunk; });
const pending = new Map(); let sequence = 0;
lines.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const waiting = pending.get(message.id);
  if (waiting) { pending.delete(message.id); clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error))); else waiting.resolve(message.result); }
});
function request(method, params) {
  assert.ok(['initialize', 'skills/list'].includes(method), 'No mutating app-server methods in this smoke');
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('App-server request deadline: ' + method)); }, 45_000);
    pending.set(id, { resolve, reject, timer });
    server.stdin.write(JSON.stringify({ method, id, params }) + '\n');
  });
}
let report;
try {
  const initialized = await request('initialize', { clientInfo: { name: 'code_duet_package_smoke', version: '0.1.0' } });
  server.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const result = await request('skills/list', { cwds: [workspace], forceReload: true });
  const row = result.data.find(item => realpathSync(item.cwd) === realpathSync(workspace));
  assert.ok(row, 'Missing workspace skill result');
  assert.deepEqual(row.errors, [], 'Host skill validation errors');
  const matches = row.skills.filter(skill => skill.name === 'code-duet');
  assert.equal(matches.length, 1);
  const skill = matches[0];
  assert.equal(realpathSync(skill.path), realpathSync(join(destination, 'SKILL.md')));
  assert.equal(skill.enabled, true);
  assert.ok(typeof skill.description === 'string' && skill.description.length > 20);
  report = { packaged, discovered: skill, host: initialized, appServerMethods: ['initialize', 'initialized', 'skills/list'],
    invocationPolicy: 'Explicit-only configured in agents/openai.yaml; not exposed by skills/list, behavioral acceptance pending' };
} catch (error) {
  writeFileSync(join(evidenceRoot, 'load-failure.json'), JSON.stringify({ error: error.message, stderr }, null, 2));
  throw error;
} finally {
  for (const entry of pending.values()) { clearTimeout(entry.timer); }
  server.stdin.end();
  const timer = setTimeout(() => server.kill(), 5_000);
  await closed; clearTimeout(timer); lines.close();
}
const inspect = spawnSync(process.execPath, [join(destination, 'helper', 'cli.mjs'), 'inspect'],
  { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 25_000 });
assert.equal(inspect.status, 0, inspect.stderr || inspect.error?.message);
report.inspect = JSON.parse(inspect.stdout.trim());
assert.equal(report.inspect.kind, 'connected');
assert.equal(report.inspect.version, '2.1.4');
assert.deepEqual(report.inspect.model, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
assert.equal(digest(statePath), stateBefore, 'Unexpected binding state mutation');
assert.equal(digest(registrationPath), registrationBefore, 'Unexpected engine registration mutation');
assert.equal(digest(configPath), configBefore, 'Unexpected global Codex config mutation');
report.preserves = { bindingState: true, engineRegistration: true, codexConfig: true };
writeFileSync(join(evidenceRoot, 'package-smoke.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ kind: 'package-smoke-passed', package: destination, files: packaged.files,
  discovered: { name: report.discovered.name, enabled: true }, invocationPolicy: report.invocationPolicy,
  inspect: report.inspect, preserves: report.preserves, modelCalls: 0, chatMutations: 0 }));
