// Disposable native HTTP/SSE engine. Never connects to the user's OpenCode.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const defaultCli = fileURLToPath(new URL('../helper/cli.mjs', import.meta.url));
export const baseline = 'Baseline: disposable native HTTP acceptance fixture';
export const model = { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', enabled: true, status: 'active' };

export async function fixture(t, cli = defaultCli, version = '2.1.4') {
  const temporary = realpathSync(tmpdir()), root = mkdtempSync(join(temporary, 'duet-http-'));
  const home = join(root, 'empty-user'), workspace = join(root, 'workspace space & test');
  mkdirSync(join(home, '.local', 'state', 'opencode'), { recursive: true });
  mkdirSync(join(workspace, 'plans'), { recursive: true });
  const plan = join(workspace, 'plans', '001-test.md'), packet = join(workspace, 'packet.txt');
  writeFileSync(plan, baseline); writeFileSync(packet, 'Isolated simulator only: no model execution.');
  const protectedFile = join(workspace, 'owner-dirty.txt'); writeFileSync(protectedFile, 'OWNER_DIRTY_BASELINE\n');
  const statePath = join(home, '.local', 'state', 'code-duet', 'state.json');
  const secret = 'OFFLINE_HTTP_CANARY_007';
  const expectedAuth = 'Basic ' + Buffer.from('opencode:' + secret).toString('base64');
  const calls = [], sessions = new Map(), streams = new Set(), messages = new Map();
  const f = { root, home, workspace, plan, packet, statePath, calls, sessions, streams, messages,
    models: [model], fault: null, active: {}, forms: [], permissions: [], shells: [], streamOpens: 0 };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== expectedAuth) { response.writeHead(401); response.end(); return; }
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined, route = request.url, sessionID = route.split('/')[3];
      calls.push({ method: request.method, route });
      await f.onRequest?.(route);
      const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      const rejection = f.rejectRequest?.(request.method, route);
      if (rejection) { response.statusCode = 400; return send(rejection); }
      if (route === '/api/info') {
        if (f.fault === 'info-timeout') return;
        if (f.fault === 'bootstrap-offline') { response.writeHead(503); response.end(); return; }
        return send({ version, hostname: 'isolated-fixture' });
      }
      if (route === '/api/model') return send({ data: f.models });
      if (route === '/api/event') {
        if (f.eventFault) {
          response.writeHead(f.eventFault === 'http' ? 429 : f.eventFault === 'redirect' ? 302 : 200,
            { 'Content-Type': 'application/json', Location: 'http://127.0.0.1:' + server.address().port + '/must-not-follow' });
          response.end(secret); return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': connected\n\n');
        f.streamOpens++; streams.add(response); response.on('close', () => streams.delete(response)); return;
      }
      if (route === '/api/session/active') { if (f.fault === 'active-timeout') return; return send({ data: f.active }); }
      if (route.endsWith('/form')) return send({ data: f.forms.filter(item => item.sessionID === sessionID) });
      if (route.endsWith('/permission')) return send({ data: f.permissions.filter(item => item.sessionID === sessionID) });
      if (route.startsWith('/api/shell?')) return send({ data: f.shells });
      if (route.startsWith('/api/session?')) {
        if (f.sessionPage) return send(f.sessionPage);
        const query = new URL(route, 'http://localhost').searchParams;
        const selected = [...sessions.values()].filter(session => session.location.directory === query.get('directory'));
        const offset = Number(query.get('cursor') ?? 0), limit = Number(query.get('limit') ?? 50);
        return send({ data: selected.slice(offset, offset + limit), cursor: { next: String(offset + limit) } });
      }
      if (route === '/api/session' && request.method === 'POST') {
        const session = { id: 'ses_http' + (sessions.size + 1), title: body.title, location: body.location, model: body.model, time: {} };
        sessions.set(session.id, session); return send({ data: session });
      }
      if (route.endsWith('/prompt') && request.method === 'POST') {
        if (f.fault === 'drop') { response.destroy(); return; }
        if (f.fault === 'http429') { response.writeHead(429); response.end(secret); return; }
        messages.set(sessionID, [...(messages.get(sessionID) ?? []), { id: body.id, type: 'user', text: body.text }]);
        f.active[sessionID] = { type: 'running' };
        return send({ data: { id: body.id, sessionID } });
      }
      if (route.endsWith('/reply') && request.method === 'POST') {
        const [, , , , kind, requestID] = route.split('/');
        const pending = kind === 'form' ? f.forms : f.permissions;
        const requestRecord = pending.find(item => item.id === requestID);
        if (requestRecord?.metadata?.tool) {
          const message = (messages.get(sessionID) ?? []).find(item => item.id === requestRecord.metadata.tool.messageID);
          const tool = message?.content?.find(item => item.id === requestRecord.metadata.tool.id);
          if (tool?.state?.status === 'running') {
            tool.state = { ...tool.state, status: 'completed' };
            tool.time = { completed: Date.now() };
            message.time = { ...(message.time ?? {}), completed: tool.time.completed };
          }
        }
        if (kind === 'form') f.forms = f.forms.filter(item => item.id !== requestID);
        else f.permissions = f.permissions.filter(item => item.id !== requestID);
        return send({ data: { id: requestID, sessionID } });
      }
      if (route.includes('/message?')) {
        const query = new URL(route, 'http://localhost').searchParams;
        if (query.has('cursor') && query.has('order')) {
          response.statusCode = 400; return send({ _tag: 'InvalidCursorError', message: secret });
        }
        if (f.messagePage) return send(f.messagePage);
        const reversed = [...(messages.get(sessionID) ?? [])].reverse();
        const offset = Number(query.get('cursor') ?? 0), limit = Number(query.get('limit') ?? 100);
        return send({ data: reversed.slice(offset, offset + limit), cursor: { next: String(offset + limit) } });
      }
      if (route.startsWith('/api/session/')) return send({ data: sessions.get(sessionID) });
      response.writeHead(404); response.end();
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    assert.ok(resolve(root).startsWith(temporary + sep)); rmSync(root, { recursive: true });
  });
  const registration = join(home, '.local', 'state', 'opencode', 'service.json');
  writeFileSync(registration, JSON.stringify({ id: 'offline-http-engine', version,
    url: 'http://127.0.0.1:' + server.address().port, password: secret }));
  const registrationBefore = readFileSync(registration);
  f.call = (args, chatID = 'offline-http-chat-A', timeoutMs = 10_000, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_THREAD_ID: chatID, ...extraEnv },
      signal: AbortSignal.timeout(timeoutMs), stdio: ['ignore', 'pipe', 'pipe'] });
    const running = f.running = { pid: child.pid, stdoutBytes: 0, stderrBytes: 0 };
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; running.stdoutBytes += chunk.length; });
    child.stderr.on('data', chunk => { stderr += chunk; running.stderrBytes += chunk.length; });
    child.on('error', reject);
    child.on('close', status => {
      try {
        assert.ok(!stdout.includes(secret) && !stderr.includes(secret), 'Credential leaked in CLI output');
        assert.deepEqual(readFileSync(registration), registrationBefore);
        assert.equal(readFileSync(protectedFile, 'utf8'), 'OWNER_DIRTY_BASELINE\n');
        resolve({ status, result: JSON.parse((stdout || stderr).trim()), stdout, stderr });
      } catch (error) { reject(error); }
    });
  });
  f.bindArgs = count => ['bind', workspace, plan, '--correction-count', String(count), '--non-git-baseline', baseline];
  f.submitArgs = ['submit', workspace, plan, 'correction-20', packet, '--kind', 'correction', '--non-git-baseline', baseline];
  f.state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  f.posts = route => calls.filter(call => call.method === 'POST' && call.route === route).length;
  f.emit = (type, sessionID) => { for (const stream of streams) stream.write('data: ' + JSON.stringify({ type, data: { sessionID } }) + '\n\n'); };
  f.finish = sessionID => {
    const ended = Date.now();
    messages.get(sessionID).push(
      { id: 'msg_final', type: 'assistant', model, finish: 'stop', time: { completed: ended }, content: [{ type: 'text', text: 'Simulator completed; no background operations.' }] },
      { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: ended } });
    Object.assign(sessions.get(sessionID), { outcome: 'succeeded', time: { idle: ended, updated: ended } });
    delete f.active[sessionID]; f.emit('execution.succeeded', sessionID);
  };
  return f;
}
