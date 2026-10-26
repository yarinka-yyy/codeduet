import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { helper } from '../helper/binding.mjs';
import { MODEL } from '../helper/connection.mjs';
import { assignmentMessages, decodeFrame } from '../helper/interaction.mjs';

test('discovery failure between invocations persists STOP without a transport or mutation', async t => {
  const f = await setup(t);
  const offline = helper(null, { stateRoot: resolve(f.adapter.statePath, '..'), chatID: 'offline-chat-only' });
  assert.equal((await offline.connectionLost()).kind, 'connection-uncertain');
  f.client.finish(); assert.equal((await f.wait()).kind, 'stopped');
  assert.equal(f.posts().length, 2);
});

test('native nested form.created wakes promptly; stale same-session failure is not terminal proof', async t => {
  const f = await setup(t); const waiting = f.wait({ timeoutMs: 500 });
  await new Promise(resolve => setTimeout(resolve, 15));
  f.client.event('session.execution.failed'); // An old event cannot fail a newer active assignment.
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.state().phase, 'EXECUTING');
  f.client.question();
  f.client.controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'form.created', data: { form: f.client.forms[0] } }) + '\n\n'));
  const result = await waiting;
  assert.equal(result.kind, 'question'); assert.notEqual(result.phase, 'STOPPED');
});

test('user answers while helper validates history: last pending recheck prevents duplicate POST', async t => {
  const f = await setup(t); f.client.question(); await f.wait();
  const request = f.client.request.bind(f.client);
  f.client.request = async (route, body) => {
    const result = await request(route, body);
    if (route.includes('/message?')) f.client.forms = [];
    return result;
  };
  assert.equal((await f.reply('question', 'frm_question', { answer: { q0: 'Beta' } })).kind, 'stale-request');
  assert.equal(f.posts().length, 2);
});

test('foreground PowerShell call with quoted spaces and ampersand is accepted; tracked background must have ended', async t => {
  for (const tracked of [false, true]) {
    const f = await setup(t); f.client.question(); f.client.forms = []; f.client.finish();
    const tool = f.client.messages[1].content[0]; tool.name = 'shell';
    tool.state.input = { command: '& "C:/Program Files/node.exe" "C:/space & test/wait.mjs"', background: tracked };
    tool.state.metadata = tracked ? { status: 'backgrounded', shellID: 'sh_tracked' } : { status: 'completed', exit: 0 };
    if (tracked) f.client.shells = [{ id: 'sh_tracked', status: 'exited', time: { completed: Date.now() } }];
    assert.equal((await f.wait()).kind, 'completed-for-review');
    assert.ok(f.client.calls.some(call => call.route === '/api/shell?location[directory]=' + encodeURIComponent(f.workspace)));
  }
});

test('untracked shell background result and uncompleted assistant cannot transfer ownership', async t => {
  for (const unsafe of ['background', 'assistant']) {
    const f = await setup(t); f.client.question(); f.client.forms = []; f.client.finish();
    if (unsafe === 'background') {
      const tool = f.client.messages[1].content[0]; tool.name = 'shell';
      tool.state.input = { command: 'build', background: false }; tool.state.metadata = { status: 'backgrounded', shellID: 'sh_unknown' };
    } else delete f.client.messages[1].time.completed;
    assert.equal((await f.wait()).phase, 'STOPPED');
  }
});

test('invalid multi/custom choices fail without an API mutation', async t => {
  for (const value of [['Alpha', 'Alpha'], ['Unoffered'], 'Alpha']) {
    const f = await setup(t); f.client.question('multiselect'); f.client.forms[0].fields[0].custom = false;
    await f.wait();
    assert.equal((await f.reply('question', 'frm_question', { answer: { q0: value } })).phase, 'STOPPED');
    assert.equal(f.posts().length, 2);
  }
});


async function setup(t) {
  const temporary = realpathSync(tmpdir()), root = mkdtempSync(join(temporary, 'duet-interaction-'));
  t.after(() => { assert.ok(resolve(root).startsWith(temporary + sep)); rmSync(root, { recursive: true }); });
  const workspace = join(root, 'project space & test'); mkdirSync(workspace);
  const plan = join(workspace, '001.md'), packet = join(workspace, 'packet.txt');
  const baseline = 'Baseline: offline fixture'; writeFileSync(plan, baseline); writeFileSync(packet, 'No-op');
  const client = {
    engineID: 'offline-engine', calls: [], active: {}, forms: [], permissions: [], messages: [], shells: [], lostReply: false,
    async request(route, body) {
      this.calls.push({ route, body });
      if (route === '/api/session' && body) {
        this.session = { id: 'ses_test', model: MODEL, location: body.location, time: {} };
        return { data: structuredClone(this.session) };
      }
      if (route.endsWith('/prompt')) {
        this.messages = [{ id: body.id, type: 'user', text: body.text, time: { created: Date.now() } }];
        this.active = { ses_test: { type: 'running' } };
        return { data: { id: body.id, sessionID: 'ses_test' } };
      }
      if (route.endsWith('/reply')) {
        if (this.lostReply) throw new Error('Engine mutation uncertain; do not retry');
        if (route.includes('/form/')) this.forms = [];
        else this.permissions = [];
        return;
      }
      if (route.endsWith('/form')) return { data: structuredClone(this.forms) };
      if (route.endsWith('/permission')) return { data: structuredClone(this.permissions) };
      if (route.includes('/message?')) return { data: structuredClone(this.messages).reverse(), cursor: {} };
      if (route.startsWith('/api/shell?')) return { data: structuredClone(this.shells) };
      if (route === '/api/session/active') return { data: structuredClone(this.active) };
      if (route === '/api/session/ses_test') return { data: structuredClone(this.session) };
      throw new Error('Unexpected fixture route');
    },
    async events(signal) {
      const stream = new ReadableStream({
        start: controller => {
          this.controller = controller;
          const abort = () => { try { controller.error(new Error('Aborted')); } catch {} };
          signal.addEventListener('abort', abort, { once: true });
          this.detach = () => signal.removeEventListener('abort', abort);
        },
        cancel: () => this.detach?.(),
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    },
    event(type, sessionID = 'ses_test') { this.controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type, data: { sessionID } }) + '\n\n')); },
    question(type = 'string') {
      this.messages.push({ id: 'msg_tool', type: 'assistant', model: MODEL, time: { created: Date.now() },
        content: [{ id: 'call_question', type: 'tool', name: 'question', time: { created: Date.now() }, state: { status: 'running', input: {} } }] });
      this.forms = [{ id: 'frm_question', sessionID: 'ses_test', title: 'Choice',
        metadata: { kind: 'question', tool: { messageID: 'msg_tool', id: 'call_question' } },
        fields: [{ key: 'q0', type, title: 'Select', options: ['Alpha', 'Beta', 'Gamma', 'Delta'].map(value => ({ value, label: value, description: value + ' details' })), custom: true }] }];
    },
    finish() {
      const ended = Date.now() + 1;
      for (const message of this.messages) if (message.type === 'assistant') {
        message.time.completed = ended;
        for (const tool of message.content.filter(part => part.type === 'tool')) { tool.state.status = 'completed'; tool.time.completed = ended; }
      }
      this.messages.push({ id: 'msg_final', type: 'assistant', model: MODEL, finish: 'stop', time: { created: ended, completed: ended },
        content: [{ type: 'text', text: 'Finished; no background operations.' }] },
      { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: ended } });
      this.active = {}; this.session.outcome = 'succeeded'; this.session.time = { idle: ended, updated: ended };
    },
  };
  const adapter = helper(client, { stateRoot: join(root, 'state'), chatID: 'offline-chat-only' });
  await adapter.bind(workspace, plan, baseline);
  await adapter.submit(workspace, plan, 'assignment-1', packet, baseline);
  return { client, adapter, workspace, plan, baseline,
    wait: (extra = {}) => adapter.wait(workspace, plan, { nonGitBaseline: baseline, timeoutMs: 500, ...extra }),
    reply: (kind, id, payload) => adapter.reply(workspace, plan, kind, id, payload, baseline),
    state: () => JSON.parse(readFileSync(adapter.statePath, 'utf8')).bindings[0],
    posts: () => client.calls.filter(call => call.body !== undefined),
  };
}

test('correlated final, terminal idle, ended tools and shells transfer ownership; no resubmit', async t => {
  const f = await setup(t); f.client.question(); f.client.forms = []; f.client.finish();
  const result = await f.wait();
  assert.equal(result.kind, 'completed-for-review'); assert.equal(result.phase, 'REVIEWING');
  assert.equal(result.result.assistantID, 'msg_final'); assert.equal(result.result.tools[0].status, 'completed');
  assert.equal(f.posts().length, 2); assert.equal(f.state().phase, 'REVIEWING');
});

test('final text while engine still active never transfers ownership; deadline persists STOP', async t => {
  const f = await setup(t); f.client.finish(); f.client.active = { ses_test: { type: 'running' } };
  const result = await f.wait({ timeoutMs: 40 });
  assert.equal(result.kind, 'connection-uncertain'); assert.equal(result.phase, 'STOPPED');
  f.client.active = {};
  assert.equal((await f.wait()).kind, 'stopped');
  assert.equal(f.posts().length, 2); assert.equal(result.executorStopped, false);
});

for (const unsafe of ['running-tool', 'running-shell', 'unknown-shell', 'detached', 'extra-user', 'stale-idle', 'unknown-history', 'changed-during-confirmation']) {
  test(unsafe + ' cannot release the checkout', async t => {
    const f = await setup(t); f.client.question(); f.client.forms = []; f.client.finish();
    const tool = f.client.messages[1].content[0];
    if (unsafe === 'running-tool') tool.state.status = 'running';
    if (unsafe === 'running-shell') f.client.shells = [{ status: 'running', time: { started: Date.now() } }];
    if (unsafe === 'unknown-shell') f.client.shells = [{ status: 'exited', time: {} }];
    if (unsafe === 'detached') { tool.name = 'exec'; tool.state.input = { command: 'Start-Process helper.exe' }; tool.state.metadata = { status: 'completed' }; }
    if (unsafe === 'extra-user') f.client.messages.splice(-1, 0, { id: 'msg_foreign', type: 'user', text: 'Other task' });
    if (unsafe === 'stale-idle') f.client.session.time.idle = 1;
    if (unsafe === 'unknown-history') f.client.messages.splice(-1, 0, { id: 'msg_compact', type: 'compaction' });
    if (unsafe === 'changed-during-confirmation') {
      const request = f.client.request.bind(f.client);
      f.client.request = async (route, body) => {
        if (route.startsWith('/api/shell?')) f.client.forms = [{ id: 'frm_late' }];
        return request(route, body);
      };
    }
    const result = await f.wait({ timeoutMs: 40 });
    assert.equal(result.phase, 'STOPPED'); assert.notEqual(result.kind, 'completed-for-review'); assert.equal(f.posts().length, 2);
  });
}

for (const value of ['Beta', 'CUSTOM_003', ['Alpha', 'CUSTOM_003']]) {
  test('question preserves exact options, descriptions and answer ' + JSON.stringify(value), async t => {
    const f = await setup(t); f.client.question(Array.isArray(value) ? 'multiselect' : 'string');
    const result = await f.wait();
    assert.equal(result.kind, 'question'); assert.equal(result.request.fields[0].options.length, 4);
    assert.equal(result.request.fields[0].options[1].description, 'Beta details');
    assert.equal((await f.reply('question', 'frm_question', { answer: { q0: value } })).kind, 'replied');
    assert.deepEqual(f.posts().at(-1).body, { answer: { q0: value } });
    assert.equal((await f.reply('question', 'frm_question', { answer: { q0: 'Alpha' } })).kind, 'stale-request');
    assert.equal(f.posts().length, 3);
    f.client.finish(); assert.equal((await f.wait()).phase, 'REVIEWING');
  });
}

test('request answered directly by user is not answered again', async t => {
  const f = await setup(t); f.client.question(); await f.wait(); f.client.forms = [];
  assert.equal((await f.reply('question', 'frm_question', { answer: { q0: 'Beta' } })).kind, 'stale-request');
  assert.equal(f.posts().length, 2); assert.equal(f.state().phase, 'EXECUTING');
});

test('foreign, changed and old-assignment requests cannot be answered', async t => {
  for (const unsafe of ['foreign', 'changed', 'old']) {
    const f = await setup(t); f.client.question();
    if (unsafe === 'foreign') f.client.forms[0].sessionID = 'ses_foreign';
    if (unsafe === 'old') f.client.forms[0].metadata.tool.messageID = 'msg_old';
    const pending = await f.wait();
    if (unsafe === 'changed') {
      assert.equal(pending.kind, 'question'); f.client.forms[0].fields[0].title = 'Different operation';
      assert.equal((await f.reply('question', 'frm_question', { answer: { q0: 'Beta' } })).phase, 'STOPPED');
    } else assert.equal(pending.phase, 'STOPPED');
    assert.equal(f.posts().length, 2);
  }
});

test('permission uses its own exact route, once decision and operation details', async t => {
  const f = await setup(t); f.client.question(); f.client.forms = [];
  f.client.permissions = [{ id: 'per_test', sessionID: 'ses_test', action: 'exec', resources: ['safe command'], metadata: { command: 'echo proof' }, source: { type: 'tool', messageID: 'msg_tool', id: 'call_question' } }];
  const result = await f.wait(); assert.equal(result.kind, 'permission'); assert.equal(result.request.metadata.command, 'echo proof');
  assert.equal((await f.reply('permission', 'per_test', { decision: 'once' })).kind, 'replied');
  assert.equal(f.posts().at(-1).route, '/api/session/ses_test/permission/per_test/reply');
  assert.deepEqual(f.posts().at(-1).body, { decision: 'once' });
});

for (const decision of ['always', 'reject']) test('permission ' + decision + ' stops coordination without blanket allow', async t => {
  const f = await setup(t); f.client.question(); f.client.forms = [];
  f.client.permissions = [{ id: 'per_test', sessionID: 'ses_test', action: 'exec', resources: ['proof'], source: { type: 'tool', messageID: 'msg_tool', id: 'call_question' } }];
  await f.wait();
  const result = await f.reply('permission', 'per_test', { decision });
  assert.equal(result.phase, 'STOPPED'); assert.equal(f.posts().length, decision === 'always' ? 2 : 3);
});

test('uncertain reply is written ahead and is never retried', async t => {
  const f = await setup(t); f.client.question(); await f.wait(); f.client.lostReply = true;
  const result = await f.reply('question', 'frm_question', { answer: { q0: 'Beta' } });
  assert.equal(result.phase, 'STOPPED'); assert.equal(f.state().uncertain, 'reply');
  f.client.lostReply = false;
  assert.equal((await f.reply('question', 'frm_question', { answer: { q0: 'Beta' } })).kind, 'stopped');
  assert.equal(f.posts().length, 3);
});

for (const failure of ['provider-limit', 'tool-error', 'interrupted', 'stream-gap', 'failure-event', 'advisor-interrupted']) {
  test(failure + ' stays failed even after late successful idle', async t => {
    const f = await setup(t);
    if (failure === 'provider-limit') { f.client.finish(); f.client.messages[1].error = { message: 'Quota exhausted' }; }
    if (failure === 'tool-error') { f.client.question(); f.client.forms = []; f.client.finish(); f.client.messages[1].content[0].state.status = 'error'; }
    if (failure === 'interrupted') { f.client.finish(); f.client.messages.at(-1).outcome = 'interrupted'; }
    const controller = new AbortController();
    const waiting = f.wait({ signal: controller.signal });
    if (['stream-gap', 'failure-event', 'advisor-interrupted'].includes(failure)) {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (failure === 'stream-gap') f.client.controller.close();
      if (failure === 'failure-event') {
        f.client.messages.push({ id: 'msg_failure', type: 'assistant', model: MODEL, content: [], finish: 'error', time: { created: Date.now(), completed: Date.now() }, error: { message: 'Provider failed' } });
        f.client.event('session.execution.failed');
      }
      if (failure === 'advisor-interrupted') controller.abort();
    }
    const result = await waiting; assert.equal(result.phase, 'STOPPED'); assert.equal(result.executorStopped, false);
    if (failure === 'failure-event') assert.equal(result.kind, 'failed');
    f.client.finish(); assert.equal((await f.wait()).kind, 'stopped'); assert.equal(f.posts().length, 2);
  });
}

test('foreign/old events and token deltas are hints only; current assignment state decides', async t => {
  const f = await setup(t);
  const waiting = f.wait({ timeoutMs: 500 });
  await new Promise(resolve => setTimeout(resolve, 15));
  for (let i = 0; i < 100; i++) f.client.event('session.text.delta');
  f.client.event('session.execution.failed', 'ses_other');
  f.client.event('session.execution.succeeded'); // Old event: engine remains active.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state().phase, 'EXECUTING');
  f.client.finish(); f.client.event('session.execution.succeeded');
  assert.equal((await waiting).kind, 'completed-for-review');
  assert.equal(f.client.calls.filter(call => call.route.includes('/message?')).length, 2);
  assert.equal(f.posts().length, 2);
});

test('pagination stops at current prompt, supports short pages with next cursor and rejects ambiguity', async () => {
  const binding = { sessionID: 'ses_test', messageID: 'msg_user', assignmentID: 'block' };
  let calls = 0;
  const client = { request: async () => ++calls === 1 ? { data: [{ id: 'msg_final' }], cursor: { next: 'opaque' } } :
    { data: [{ id: 'msg_user', type: 'user', text: 'Assignment ID: block\nTask' }], cursor: {} } };
  assert.deepEqual((await assignmentMessages(client, binding)).map(message => message.id), ['msg_user', 'msg_final']); assert.equal(calls, 2);
  await assert.rejects(assignmentMessages({ request: async () => ({ data: [{ id: 'msg_duplicate' }], cursor: { next: 'same' } }) }, binding), /Ambiguous|absent/);
  assert.equal(decodeFrame(': heartbeat\n'), null);
  assert.equal(decodeFrame('data: {"type":"session.execution.succeeded","data":{}}\r\n').type, 'session.execution.succeeded');
  assert.throws(() => decodeFrame('data: invalid'), /Invalid/);
});
