import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Native CLI/HTTP/store checks against an isolated simulator, not the user's engine.
const cli = fileURLToPath(new URL('../helper/cli.mjs', import.meta.url));
const model = { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', enabled: true, status: 'active' };
const baseline = 'Baseline: disposable native HTTP acceptance fixture';

async function fixture(t) {
  const temporary = realpathSync(tmpdir()), root = mkdtempSync(join(temporary, 'duet-http-'));
  const home = join(root, 'empty-user'), workspace = join(root, 'workspace space & test');
  mkdirSync(join(home, '.local', 'state', 'opencode'), { recursive: true });
  mkdirSync(join(workspace, 'plans'), { recursive: true });
  const plan = join(workspace, 'plans', '001-test.md'), packet = join(workspace, 'packet.txt');
  writeFileSync(plan, baseline); writeFileSync(packet, 'Isolated simulator only: no model execution.');
  const protectedFile = join(workspace, 'owner-dirty.txt'); writeFileSync(protectedFile, 'OWNER_DIRTY_BASELINE\n');
  const statePath = join(home, '.local', 'state', 'code-duet', 'state.json');
  const secret = 'OFFLINE_HTTP_CANARY_006';
  const expectedAuth = 'Basic ' + Buffer.from('opencode:' + secret).toString('base64');
  const calls = [], sessions = new Map();
  const f = { root, home, workspace, plan, packet, statePath, calls, models: [model], fault: null };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== expectedAuth) { response.writeHead(401); response.end(); return; }
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined, route = request.url;
      calls.push({ method: request.method, route });
      const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      if (route === '/api/info') return send({ version: '2.1.4' });
      if (route === '/api/model') return send({ data: f.models });
      if (route === '/api/session/active') return send({ data: {} });
      if (route.endsWith('/form') || route.endsWith('/permission')) return send({ data: [] });
      if (route === '/api/session' && request.method === 'POST') {
        const session = { id: 'ses_http' + (sessions.size + 1), location: body.location, model: body.model };
        sessions.set(session.id, session); return send({ data: session });
      }
      if (route.endsWith('/prompt') && request.method === 'POST') {
        if (f.fault === 'drop') { response.destroy(); return; }
        if (f.fault === 'http429') { response.writeHead(429); response.end(secret); return; }
        return send({ data: { id: body.id, sessionID: route.split('/')[3] } });
      }
      if (route.startsWith('/api/session/')) return send({ data: sessions.get(route.split('/')[3]) });
      response.writeHead(404); response.end();
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    assert.ok(resolve(root).startsWith(temporary + sep));
    rmSync(root, { recursive: true });
  });
  const registration = join(home, '.local', 'state', 'opencode', 'service.json');
  writeFileSync(registration, JSON.stringify({ id: 'offline-http-engine', version: '2.1.4',
    url: 'http://127.0.0.1:' + server.address().port, password: secret }));
  const registrationBefore = readFileSync(registration);
  f.call = (args, chatID = 'offline-http-chat-A') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_THREAD_ID: chatID },
      signal: AbortSignal.timeout(10_000), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      try {
        assert.ok(!stdout.includes(secret) && !stderr.includes(secret), 'Credential leaked in CLI output');
        assert.deepEqual(readFileSync(registration), registrationBefore);
        assert.equal(readFileSync(protectedFile, 'utf8'), 'OWNER_DIRTY_BASELINE\n');
        resolve({ status, result: JSON.parse((stdout || stderr).trim()) });
      } catch (error) { reject(error); }
    });
  });
  f.bindArgs = count => ['bind', workspace, plan, '--correction-count', String(count), '--non-git-baseline', baseline];
  f.submitArgs = ['submit', workspace, plan, 'correction-20', packet, '--kind', 'correction', '--non-git-baseline', baseline];
  f.state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  f.posts = route => calls.filter(call => call.method === 'POST' && call.route === route).length;
  return f;
}

for (const fault of ['drop', 'http429']) test('native CLI ' + fault + ' preserves one possibly delivered correction and refuses retry/new writer', async t => {
  const f = await fixture(t);
  const bound = await f.call(f.bindArgs(19)); assert.equal(bound.status, 0);
  assert.equal((await f.call(f.bindArgs(19))).result.sessionID, bound.result.sessionID);
  assert.equal(f.posts('/api/session'), 1);
  f.fault = fault;
  const failed = await f.call(f.submitArgs); assert.equal(failed.status, 1);
  assert.match(failed.result.error, fault === 'drop' ? /mutation uncertain/ : /HTTP 429/);
  assert.equal(failed.result.retried, false);
  assert.equal(f.state().bindings[0].phase, 'STOPPED');
  assert.equal(f.state().bindings[0].uncertain, 'submit');
  assert.equal(f.state().plans[0].correctionCount, 20);
  const stoppedState = readFileSync(f.statePath);
  assert.equal((await f.call(f.submitArgs)).status, 1);
  assert.equal((await f.call(f.bindArgs(20), 'offline-http-chat-B')).status, 1);
  assert.deepEqual(readFileSync(f.statePath), stoppedState);
  assert.equal(f.posts('/api/session/' + bound.result.sessionID + '/prompt'), 1);
  assert.equal(f.posts('/api/session'), 1);
});

for (const mode of ['disabled-go', 'free-only']) test('native CLI rejects ' + mode + ' without fallback, pair creation or saved state', async t => {
  const f = await fixture(t);
  f.models = mode === 'disabled-go' ? [{ ...model, enabled: false }] : [{ ...model, providerID: 'opencode' }];
  const result = await f.call(['inspect']);
  assert.equal(result.status, 1); assert.match(result.result.error, /Go model unavailable; no fallback/);
  assert.ok(!existsSync(f.statePath));
  assert.ok(f.calls.every(call => call.method === 'GET' && ['/api/info', '/api/model'].includes(call.route)));
});

test('native CLI with imported count 20 stops before a correction POST and preserves the count', async t => {
  const f = await fixture(t); assert.equal((await f.call(f.bindArgs(20))).status, 0);
  const result = await f.call(f.submitArgs);
  assert.equal(result.status, 1); assert.equal(result.result.kind, 'correction-limit');
  assert.equal(result.result.phase, 'STOPPED'); assert.equal(f.state().plans[0].correctionCount, 20);
  assert.ok(!f.calls.some(call => call.route.endsWith('/prompt')));
});
