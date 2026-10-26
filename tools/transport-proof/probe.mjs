import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const MODEL = { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' };
const fixture = realpathSync(fileURLToPath(new URL('../../tests/fixtures/transport space & test/', import.meta.url)));
const statePath = resolve(fixture, '.probe-state.json');
const foregroundPath = resolve(fixture, '.probe-foreground.json');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = state => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const emit = value => console.log(JSON.stringify(value));

export function localEndpoint(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Non-loopback engine');
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
  return url.origin;
}

function connection() {
  const registration = read(resolve(homedir(), '.local/state/opencode/service.json'));
  const base = localEndpoint(registration.url);
  assert.equal(registration.version, '2.1.4', 'Revalidate API for changed version');
  const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + registration.password).toString('base64') };
  async function request(route, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    assert.ok(response.ok, `HTTP ${response.status}: ${route}`);
    return response.status === 204 ? undefined : response.json();
  }
  return { registration, base, headers, request };
}

export function decodeFrame(frame) {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  let value = JSON.parse(data);
  if (typeof value === 'string') value = JSON.parse(value);
  assert.ok(value && typeof value.type === 'string', 'Unexpected event envelope');
  return value;
}

function contains(value, target) {
  if (value === target) return true;
  return value !== null && typeof value === 'object' && Object.values(value).some(child => contains(child, target));
}

export function completed(state, session, active, forms, messages) {
  if (active || forms.length || !(session.time.idle >= state.submittedAt)) return null;
  assert.equal(session.outcome, 'succeeded', 'Session did not succeed');
  const userIndex = messages.findIndex(message => message.id === state.messageID && message.type === 'user');
  assert.ok(userIndex >= 0, 'Submitted message missing from bounded history');
  const following = messages.slice(userIndex + 1);
  const assistants = following.filter(message => message.type === 'assistant');
  const last = assistants.at(-1);
  if (!last || last.finish !== 'stop' || !last.time.completed) return null;
  for (const message of assistants) {
    assert.ok(!message.error, 'Assistant error');
    assert.equal(message.model.providerID, MODEL.providerID);
    assert.equal(message.model.id, MODEL.id);
    for (const part of message.content) {
      if (part.type === 'tool') assert.equal(part.state.status, 'completed', 'Unfinished/failed tool');
    }
  }
  const text = last.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.ok(text.includes(state.marker), 'Final response does not identify assignment');
  assert.ok(following.some(message => message.type === 'idle' && message.outcome === 'succeeded'), 'No successful terminal idle message');
  return { messageID: last.id, text, tools: assistants.flatMap(message => message.content.filter(part => part.type === 'tool').map(part => ({ name: part.name, status: part.state.status }))) };
}

export function proofMessages(page) {
  // next is a position cursor, not proof that another page contains messages.
  // shortcut: stop at 50 messages; paginate only if the proof needs a longer history.
  assert.ok(page.data.length < 50, 'Proof history reached bounded page limit');
  return page.data;
}

function bound(state, info, engineID) {
  assert.equal(state.engineID, engineID, 'Engine changed; do not resume automatically');
  assert.equal(info.id, state.sessionID);
  assert.equal(realpathSync(info.location.directory), fixture, 'Wrong physical workspace');
  assert.equal(state.workspace, fixture);
  assert.equal(info.model.providerID, MODEL.providerID);
  assert.equal(info.model.id, MODEL.id);
}

export function questionAnswer(form, mode) {
  assert.ok(['selection', 'custom'].includes(mode));
  assert.equal(form.fields.length, 1, 'Proof expects one question');
  const field = form.fields[0];
  assert.equal(field.type, 'string');
  assert.equal(field.options.length, 4);
  if (mode === 'custom') assert.equal(field.custom, true);
  return { [field.key]: mode === 'custom' ? 'CUSTOM_PROOF_001' : field.options[1].value };
}

async function wait(client, state) {
  assert.equal(state.phase, 'executing', 'No executing assignment');
  const started = Date.now();
  const metrics = { checks: 0, messageReads: 0, eventTypes: [] };
  const controller = new AbortController();
  const stream = await fetch(client.base + '/api/event', { headers: client.headers, signal: controller.signal, redirect: 'error' });
  assert.ok(stream.ok && stream.headers.get('content-type')?.includes('text/event-stream'), 'No SSE stream');
  return new Promise((resolveWait, reject) => {
    let settled = false;
    let checking = false;
    let buffer = '';
    const decoder = new TextDecoder();
    const finish = (error, outcome) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(deadline);
      controller.abort();
      state.waits ??= [];
      state.waits.push({ ...metrics, elapsedMs: Date.now() - started, outcome: error ? 'uncertain' : outcome.kind });
      if (error) state.phase = 'stopped';
      save(state);
      if (error) reject(error); else resolveWait({ ...outcome, wait: state.waits.at(-1) });
    };
    const check = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        metrics.checks++;
        const [info, active, forms] = await Promise.all([
          client.request(`/api/session/${state.sessionID}`),
          client.request('/api/session/active'),
          client.request(`/api/session/${state.sessionID}/form`),
        ]);
        bound(state, info.data, client.registration.id);
        for (const form of forms.data) assert.equal(form.sessionID, state.sessionID);
        if (forms.data.length) {
          assert.equal(forms.data.length, 1);
          state.phase = 'question'; state.formID = forms.data[0].id;
          finish(null, { kind: 'question', sessionID: state.sessionID, form: forms.data[0] });
        } else if (!active.data[state.sessionID] && info.data.time.idle >= state.submittedAt) {
          const messages = await client.request(`/api/session/${state.sessionID}/message?limit=50&order=asc`);
          metrics.messageReads++;
          const result = completed(state, info.data, active.data[state.sessionID], forms.data, proofMessages(messages));
          if (result) {
            if (state.scenario === 'completion') {
              const foreground = read(foregroundPath);
              assert.ok(foreground.startedAt >= state.submittedAt && foreground.finishedAt - foreground.startedAt >= 75_000);
              assert.equal(foreground.marker, 'FOREGROUND_FINISHED');
              let running = false;
              try { process.kill(foreground.pid, 0); running = true; } catch (error) { assert.equal(error.code, 'ESRCH'); }
              if (running) return;
              result.foreground = { durationMs: foreground.finishedAt - foreground.startedAt, exited: true };
            }
            state.phase = 'completed';
            state.results ??= [];
            state.results.push({ scenario: state.scenario, marker: state.marker, ...result });
            finish(null, { kind: 'completed-for-review', sessionID: state.sessionID, ...result });
          }
        }
      } catch (error) { finish(error); } finally { checking = false; }
    };
    const interval = setInterval(check, 5_000);
    const deadline = setTimeout(() => finish(new Error('Wait deadline; executor status uncertain, do not resubmit')), 600_000);
    (async () => {
      for await (const chunk of stream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const event = decodeFrame(frame);
          if (!event) continue;
          assert.ok(!event.type.includes('failure'), 'Event stream failure');
          if (contains(event.data, state.sessionID)) {
            if (!metrics.eventTypes.includes(event.type)) metrics.eventTypes.push(event.type);
            if (/form|idle/.test(event.type)) await check();
          }
        }
      }
      if (!settled) finish(new Error('Event stream ended; connection uncertain'));
    })().catch(error => { if (!settled) finish(error); });
    check();
  });
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const client = connection();
  const api = client.request;
  if (command === 'inspect') {
    const [info, models] = await Promise.all([api('/api/info'), api('/api/model')]);
    const model = models.data.find(model => model.providerID === MODEL.providerID && model.id === MODEL.id);
    assert.ok(model?.enabled && model.status === 'active', 'Required model unavailable');
    emit({ version: info.version, model: MODEL, enabled: model.enabled, node: process.version });
    return;
  }
  if (command === 'create') {
    assert.ok(process.env.CODEX_THREAD_ID, 'No actual Codex chat ID');
    assert.ok(!existsSync(statePath), 'Existing proof binding; inspect instead of creating another session');
    const sessions = await api('/api/session?directory=' + encodeURIComponent(fixture));
    const active = await api('/api/session/active');
    assert.ok(!sessions.data.some(session => active.data[session.id]), 'Existing writer in fixture');
    const { data: session } = await api('/api/session', { title: 'Code Duet 001 transport proof', location: { directory: fixture }, model: MODEL });
    const state = { workspace: fixture, codexChat: process.env.CODEX_THREAD_ID, engineID: client.registration.id, sessionID: session.id, phase: 'created', model: MODEL };
    save(state);
    bound(state, session, client.registration.id);
    emit({ kind: 'created', sessionID: session.id, workspace: fixture, model: session.model });
    return;
  }
  const state = read(statePath);
  assert.equal(state.codexChat, process.env.CODEX_THREAD_ID, 'Wrong Codex chat');
  const { data: info } = await api(`/api/session/${state.sessionID}`);
  bound(state, info, client.registration.id);
  if (command === 'status') {
    const [active, forms] = await Promise.all([api('/api/session/active'), api(`/api/session/${state.sessionID}/form`)]);
    emit({ sessionID: state.sessionID, phase: state.phase, outcome: info.outcome, active: active.data[state.sessionID] ?? null, pendingForms: forms.data.map(form => form.id), waits: state.waits, results: state.results });
  } else if (command === 'submit') {
    assert.ok(['created', 'completed'].includes(state.phase), 'Previous assignment not completed');
    assert.ok(['completion', 'question'].includes(argument));
    const [active, forms] = await Promise.all([api('/api/session/active'), api(`/api/session/${state.sessionID}/form`)]);
    assert.ok(!active.data[state.sessionID] && !forms.data.length, 'Previous executor/request still active');
    state.scenario = argument;
    state.marker = 'CODE_DUET_001_' + randomUUID();
    state.messageID = 'msg_' + randomUUID().replaceAll('-', '');
    state.submittedAt = Date.now();
    state.phase = 'submitting';
    save(state);
    const common = `Authorized Plan 001 fixture experiment only. No edits, installations, git, subagents, other sessions or projects. Use the configured Go DeepSeek model. Assignment marker: ${state.marker}. `;
    const task = argument === 'completion'
      ? `Run the existing wait.mjs in this exact working directory using Node executable ${JSON.stringify(process.execPath)}. It deliberately takes 75 seconds. Use an ordinary foreground shell tool with at least 120 seconds timeout; if the tool yields, wait for its process to exit. Do not background it. Do not read or modify probe state. After observing FOREGROUND_FINISHED and command exit, reply with the assignment marker, that tool's exit result, and whether any background operations remain. Do not merely say you will run it.`
      : `Use your actual question tool (not ordinary text) to ask one single-select question: Which transport proof value should be returned? Exactly four choices: Alpha, Beta, Gamma, Delta with short descriptions. Allow a custom answer. Wait for the form reply, then include the actual answer and assignment marker in your final response. No shell or file work is needed.`;
    const response = await api(`/api/session/${state.sessionID}/prompt`, { id: state.messageID, text: common + task });
    assert.equal(response.data.id, state.messageID);
    assert.equal(response.data.sessionID, state.sessionID);
    state.phase = 'executing'; save(state);
    emit({ kind: 'submitted', scenario: argument, sessionID: state.sessionID, messageID: state.messageID, marker: state.marker });
  } else if (command === 'wait') {
    emit(await wait(client, state));
  } else if (command === 'reply') {
    assert.equal(state.phase, 'question');
    const forms = await api(`/api/session/${state.sessionID}/form`);
    const form = forms.data.find(form => form.id === state.formID && form.sessionID === state.sessionID);
    assert.ok(form, 'Request no longer pending; do not reply');
    const answer = questionAnswer(form, argument);
    state.phase = 'replying'; save(state);
    await api(`/api/session/${state.sessionID}/form/${state.formID}/reply`, { answer });
    state.phase = 'executing'; save(state);
    emit({ kind: 'replied', sessionID: state.sessionID, formID: state.formID, answer });
  } else {
    throw new Error('Usage: probe.mjs inspect | create | submit completion|question | wait | reply selection|custom | status');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(JSON.stringify({ kind: 'stopped', error: error.message, resubmitted: false })); process.exitCode = 1; });
}
