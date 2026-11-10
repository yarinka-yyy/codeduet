import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { observer, wakeHint } from '../helper/observer.mjs';
import { processOwner } from '../helper/process-owner.mjs';
import { fileURLToPath } from 'node:url';

const chatID = '00000000-0000-4000-8000-000000000017';
async function setup(t, deliver = async () => ({ status: 'sent', exitCode: 0 })) {
  const f = await fixture(t, undefined, '2.2.1'), stateRoot = dirname(f.statePath);
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const client = await connectEngine(), adapter = helper(client, { stateRoot, chatID });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'observer-correction-nine', f.packet, baseline, 'correction');
  const sent = [];
  let running;
  const o = observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
    deliver: async value => { sent.push(value); return deliver(value); },
    launch: async id => { running = o.worker(id); },
  });
  t.after(async () => { if (o.status().id) await o.cancel(o.status().id); await running; });
  return Object.assign(f, { o, adapter, sent, stateRoot, client,
    arm: options => o.arm(f.workspace, f.plan, { codexExe: process.execPath, nonGitBaseline: baseline, timeoutMs: 10000, ...options }),
    end: () => running,
    session: f.state().bindings[0].sessionID });
}

test('detached contract: arm returns ready, waits without a model, one completion hint, fresh consume and no repeat/count reset', async t => {
  const f = await setup(t), from = f.calls.length;
  const armed = await f.arm();
  assert.equal(armed.kind, 'observer-armed'); assert.equal(armed.ready, true); assert.equal(armed.endTurn, true);
  assert.equal(f.sent.length, 0); assert.equal(f.state().plans[0].correctionCount, 9);
  await assert.rejects(f.arm(), /EEXIST/);
  f.emit('step.ended', 'ses_unrelated'); f.emit('tool.success', f.session);
  await new Promise(done => setTimeout(done, 60)); assert.equal(f.sent.length, 0);
  f.finish(f.session); await f.end();
  assert.equal(f.sent.length, 1); assert.equal(f.o.status().result.kind, 'completed-for-review');
  const consumed = await f.o.consume(armed.id);
  assert.equal(consumed.kind, 'completed-for-review'); assert.equal(consumed.taskSent, false);
  assert.equal((await f.o.consume(armed.id)).kind, 'already-consumed');
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(from).every(call => call.method === 'GET'));
  assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
  assert.equal(f.o.status().state, 'absent');
  assert.ok(!JSON.stringify(f.o.status(armed.id)).includes('Simulator completed'));
});

test('completion available during arm goes to that turn without a second wake', async t => {
  const f = await setup(t);
  f.finish(f.session);
  const terminal = await f.arm();
  await f.end();
  assert.equal(terminal.kind, 'observer-terminal');
  assert.equal(terminal.endTurn, false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.o.status(terminal.id).attempted, false);
  assert.equal((await f.o.consume(terminal.id)).kind, 'completed-for-review');
  assert.equal((await f.o.consume(terminal.id)).kind, 'already-consumed');
  assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
});

test('consume rereads a changed shell registry without stopping or spending the receipt', async t => {
  const f = await setup(t);
  f.finish(f.session);
  const terminal = await f.arm();
  await f.end();
  assert.equal(terminal.kind, 'observer-terminal');
  const before = readFileSync(f.statePath), from = f.calls.length, now = Date.now();
  let reads = 0;
  f.onRequest = route => {
    if (!route.startsWith('/api/shell?')) return;
    if (++reads === 1) f.shells = [{ id: 'sh_ending', status: 'running', time: { started: now } }];
    if (reads === 2) f.shells = [{ id: 'sh_ending', status: 'exited', exit: 0, time: { started: now, completed: now + 1 } }];
  };
  const retryable = await f.o.consume(terminal.id);
  assert.equal(retryable.kind, 'retryable-read');
  assert.match(retryable.error, /Project shells changed/);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.deepEqual(retryable.manualCommand.args, [terminal.id]);
  assert.equal((await f.o.consume(terminal.id)).kind, 'completed-for-review');
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(from).every(call => call.method === 'GET'));
  assert.equal(f.posts('/api/session/' + f.session + '/prompt'), 1);
});

for (const stage of ['handoff', 'publication', 'publication timeout']) test(`temporary state lock during observer ${stage}`, async t => {
  const f = await setup(t), beforeHandoff = stage === 'handoff', timeout = stage === 'publication timeout';
  let armed = beforeHandoff ? null : await f.arm();
  const lock = join(f.stateRoot, 'state.lock'), unlink = fs.unlinkSync;
  const record = JSON.stringify({ schema: 1, token: randomUUID(), process: processOwner() });
  let contention;
  const hook = t.mock.method(fs, 'unlinkSync', path => {
    unlink(path);
    if (path !== lock || contention) return;
    if (beforeHandoff ? !f.o.status().ready : f.state().bindings[0].phase !== 'REVIEWING' ||
      fs.readdirSync(join(f.stateRoot, 'ownership')).length !== 0) return;
    fs.writeFileSync(lock, record, { flag: 'wx' });
    contention = new Promise(done => setTimeout(() => {
      assert.equal(readFileSync(lock, 'utf8'), record);
      unlink(lock);
      done();
    }, timeout ? 3500 : 450));
  });
  syncBuiltinESMExports();
  try {
    if (beforeHandoff) armed = await f.arm();
    assert.equal(armed.kind, 'observer-armed');
    f.finish(f.session);
    await f.end();
    assert.ok(contention);
    assert.equal(f.sent.length, timeout ? 0 : 1);
    assert.equal(f.o.status(armed.id).notification.status, timeout ? 'not-sent' : 'sent');
    await contention;
    const consumed = await f.o.consume(armed.id);
    assert.equal(consumed.kind, 'completed-for-review');
    assert.equal(consumed.correctionCount, 9);
    assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
  } finally {
    await contention;
    hook.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cancel at readiness never tells the arming turn to wait for a wake', async t => {
  const f = await setup(t), unlink = fs.unlinkSync, lock = join(f.stateRoot, 'state.lock');
  let cancellation;
  const hook = t.mock.method(fs, 'unlinkSync', path => {
    unlink(path);
    if (path !== lock || cancellation) return;
    const status = f.o.status();
    if (status.ready && !status.cancelled) cancellation = Promise.resolve().then(() => f.o.cancel(status.id));
  });
  syncBuiltinESMExports();
  try {
    const outcome = await f.arm();
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.endTurn, false);
    assert.equal(outcome.consumeRequired, false);
    assert.equal((await cancellation).exited, true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const fault of ['history-truncated', 'bootstrap-offline']) test('a transient observation read keeps the delivery: ' + fault, async t => {
  const f = await setup(t);
  f.fault = fault;
  const first = await f.arm();
  await f.end();
  assert.equal(f.o.status(first.id).result.kind, 'retryable-read');
  assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  assert.equal((await f.o.consume(first.id)).kind, 'retryable-read');
  f.fault = null;
  const observed = await f.o.consume(first.id);
  assert.equal(observed.kind, 'observing');
  assert.equal(observed.rearm, true);
  assert.equal(observed.correctionCount, 9);
  const next = await f.arm();
  f.finish(f.session);
  await f.end();
  assert.equal((await f.o.consume(next.id)).kind, 'completed-for-review');
  assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
});

test('a resumed receipt can recover a transient read while the same delivery is still STOPPED', async t => {
  const f = await setup(t);
  await f.adapter.connectionLost(new Error('First observation stopped'));
  f.fault = 'history-truncated';
  const first = await f.arm({ resume: true });
  await f.end();
  assert.equal(f.o.status(first.id).result.kind, 'retryable-read');
  assert.equal(f.state().bindings[0].phase, 'STOPPED');
  f.fault = null;
  f.finish(f.session);
  const outcome = await f.o.consume(first.id);
  assert.equal(outcome.kind, 'completed-for-review');
  assert.equal(outcome.correctionCount, 9);
  assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
});

test('bound wait and observer use a four-hour default while invalid deadlines leave state unchanged', async t => {
  const f = await setup(t), before = readFileSync(f.statePath), from = f.calls.length;
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 14_400_001]) {
    await assert.rejects(f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs }), /timeout/);
    await assert.rejects(f.arm({ timeoutMs }), /deadline/);
  }
  assert.deepEqual(readFileSync(f.statePath), before); assert.equal(f.calls.length, from);
  const durations = [], original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { durations.push(milliseconds); return original(milliseconds); });
  assert.equal((await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true })).kind, 'observing');
  assert.ok(durations.includes(14_400_000)); durations.length = 0;
  const armed = await f.arm({ timeoutMs: undefined }); assert.equal(armed.kind, 'observer-armed');
  assert.ok(durations.includes(14_400_000)); assert.equal(f.sent.length, 0);
  f.finish(f.session); await f.end();
  assert.equal(f.sent[0].timeoutMs, 14_400_000);
  assert.equal((await f.o.consume(armed.id)).kind, 'completed-for-review');
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
});

test('question wakes once, revalidates pending request, then can rearm after a scoped reply', async t => {
  const f = await setup(t), armed = await f.arm();
  f.messages.get(f.session).push({ id: 'msg_tool', type: 'assistant', model, time: { created: Date.now() },
    content: [{ id: 'call_question', type: 'tool', name: 'question', time: { created: Date.now() }, state: { status: 'running', input: {} } }] });
  f.forms = [{ id: 'frm_question', sessionID: f.session, metadata: { kind: 'question', tool: { messageID: 'msg_tool', id: 'call_question' } },
    title: 'PRIVATE_QUESTION_CANARY', fields: [{ key: 'answer', type: 'string', required: true }] }];
  f.emit('form.created', f.session); await f.end();
  assert.equal(f.sent.length, 1); assert.equal(f.o.status().result.kind, 'question');
  const result = await f.o.consume(armed.id);
  assert.equal(result.kind, 'question'); assert.equal(result.request.id, 'frm_question');
  assert.ok(!JSON.stringify(f.o.status(armed.id)).includes('PRIVATE_QUESTION_CANARY'));
  await f.adapter.reply(f.workspace, f.plan, 'question', 'frm_question', { answer: { answer: 'fixture' } }, baseline);
  const next = await f.arm(); assert.notEqual(next.id, armed.id);
  f.finish(f.session); await f.end(); assert.equal(f.sent.length, 2);
});

test('cancel stops only observation, sends no hint, preserves delivered task/count and releases observer slot', async t => {
  const f = await setup(t), armed = await f.arm();
  const status = await f.o.cancel(armed.id); await f.end();
  assert.equal(status.cancelled, true); assert.equal(status.exited, true); assert.equal(f.sent.length, 0);
  assert.equal(f.state().bindings[0].phase, 'STOPPED'); assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.active[f.session].type, 'running');
  await assert.rejects(f.o.consume(armed.id), /cancelled/);
});

test('uncertain queue has one durable attempt and cannot be replayed by restarting worker', async t => {
  const f = await setup(t, async () => { throw new Error('PRIVATE_NOTIFICATION_FAILURE'); }), armed = await f.arm();
  f.finish(f.session); await f.end();
  assert.equal(f.o.status().notification.status, 'uncertain'); assert.equal(f.sent.length, 1);
  await assert.rejects(f.o.worker(armed.id), /EEXIST/);
  assert.equal(f.sent.length, 1); assert.ok(!JSON.stringify(f.o.status()).includes('PRIVATE_NOTIFICATION_FAILURE'));
  assert.equal((await f.o.consume(armed.id)).kind, 'completed-for-review');
});

test('stale receipt/wrong owner or counter never consumes current state or sends another assignment', async t => {
  const f = await setup(t), armed = await f.arm(); f.finish(f.session); await f.end();
  const other = observer({ stateRoot: f.stateRoot, chatID: '00000000-0000-4000-8000-000000000018' });
  await assert.rejects(other.consume(armed.id), /ENOENT|another chat/);
  const state = f.state(); state.plans[0].correctionCount = 10; writeFileSync(f.statePath, JSON.stringify(state));
  const before = readFileSync(f.statePath);
  await assert.rejects(f.o.consume(armed.id), /pins\/count/);
  assert.deepEqual(readFileSync(f.statePath), before); assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
});

test('once recheck returns observing for a stale question without waiting or stopping the assignment', async t => {
  const f = await setup(t);
  const result = await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true });
  assert.equal(result.kind, 'observing'); assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  assert.equal(f.state().plans[0].correctionCount, 9);
});

test('hints carry only a validated receipt, never private question/result/commands', () => {
  const hint = wakeHint(chatID);
  assert.ok(hint.includes('$code-duet')); assert.ok(hint.includes('consume ' + chatID));
  assert.ok(hint.includes('grants no new authority'));
  assert.ok(!hint.includes('updated skill')); assert.ok(!hint.includes('authorized notification'));
  assert.throws(() => wakeHint('x; private payload'), /Invalid/);
});

test('known rejected edit does not block an authorized correlated reply or spend another correction', async t => {
  const f = await setup(t), path = join(f.workspace, 'edit-target.txt'), now = Date.now();
  writeFileSync(path, 'fixture');
  f.messages.get(f.session).push({ id: 'msg_edit', type: 'assistant', model, time: { completed: now }, content: [
    { id: 'call_edit', type: 'tool', name: 'edit', time: { ran: now, completed: now }, state: { status: 'error',
      input: { path, oldString: 'old', newString: 'new' }, error: { type: 'tool.execution',
        message: `Could not find oldString in ${path}. It must match exactly, including whitespace and indentation.` } } },
  ] }, { id: 'msg_question', type: 'assistant', model, content: [
    { id: 'call_question', type: 'tool', name: 'question', state: { status: 'running' } },
  ] });
  f.forms = [{ id: 'frm_question', sessionID: f.session, metadata: { kind: 'question',
    tool: { messageID: 'msg_question', id: 'call_question' } }, fields: [{ key: 'answer', type: 'string' }] }];
  assert.equal((await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true })).kind, 'question');
  const result = await f.adapter.reply(f.workspace, f.plan, 'question', 'frm_question', { answer: { answer: 'fixture' } }, baseline);
  assert.equal(result.kind, 'replied'); assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
  assert.equal(f.posts(`/api/session/${f.session}/form/frm_question/reply`), 1);
});

test('permission events retain tool correlation and only notify; no approval or engine mutation', async t => {
  const f = await setup(t), armed = await f.arm(), from = f.calls.length;
  f.messages.get(f.session).push({ id: 'msg_tool', type: 'assistant', model, time: { created: Date.now() },
    content: [{ id: 'call_permission', type: 'tool', name: 'shell', time: { created: Date.now() }, state: { status: 'running', input: {} } }] });
  f.permissions = [{ id: 'per_permission', sessionID: f.session, action: 'shell', resources: ['fixture-only'],
    source: { type: 'tool', messageID: 'msg_tool', id: 'call_permission' } }];
  f.emit('permission.created', f.session); await f.end();
  assert.equal(f.sent.length, 1); assert.equal((await f.o.consume(armed.id)).kind, 'permission');
  assert.equal(f.permissions.length, 1); assert.ok(f.calls.slice(from).every(call => call.method === 'GET'));
});

test('a lost established stream completes through HTTP and wakes once without reconnecting', async t => {
  const f = await setup(t), armed = await f.arm(), opens = f.streamOpens;
  for (const stream of f.streams) stream.end();
  f.finish(f.session);
  await f.end();
  assert.equal(f.sent.length, 1); assert.equal(f.streamOpens, opens);
  assert.equal(f.state().bindings[0].phase, 'REVIEWING');
  assert.equal((await f.o.consume(armed.id)).kind, 'completed-for-review');
  assert.equal(f.state().plans[0].correctionCount, 9);
});

test('consume releases a failed read reservation and returns the same result after recovery', async t => {
  const f = await setup(t), armed = await f.arm();
  f.finish(f.session); await f.end();
  const before = f.state();
  f.fault = 'history-truncated';
  assert.equal((await f.o.consume(armed.id)).kind, 'retryable-read');
  assert.equal(f.o.status(armed.id).consumed, false);
  assert.deepEqual(f.state(), before);
  f.fault = null;
  assert.equal((await f.o.consume(armed.id)).kind, 'completed-for-review');
  assert.equal((await f.o.consume(armed.id)).kind, 'already-consumed');
  assert.equal(f.sent.length, 1);
  assert.equal(f.posts(`/api/session/${f.session}/prompt`), 1);
});

test('explicit resume observes the same stopped delivery; uncertain mutations remain forbidden', async t => {
  const f = await setup(t);
  await f.adapter.connectionLost(new Error('test observation interruption'));
  await assert.rejects(f.arm(), /explicit resume/);
  const armed = await f.arm({ resume: true }); f.finish(f.session); await f.end();
  assert.equal((await f.o.consume(armed.id)).kind, 'completed-for-review');
  const state = f.state(); state.bindings[0].phase = 'STOPPED'; state.bindings[0].uncertain = 'submit';
  writeFileSync(f.statePath, JSON.stringify(state));
  const before = readFileSync(f.statePath);
  await assert.rejects(f.arm({ resume: true }), /eligible delivered/);
  assert.deepEqual(readFileSync(f.statePath), before); assert.equal(f.sent.length, 1);
});

test('packaged observer CLI status is read-only; invalid commands do not connect or create state', async t => {
  const f = await fixture(t, fileURLToPath(new URL('../helper/observer.mjs', import.meta.url)));
  const status = await f.call(['status'], chatID);
  assert.equal(status.result.state, 'absent'); assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.statePath), false);
  for (const args of [['status', '--resume'], ['worker', 'invalid'], ['consume', '../another-chat']]) {
    assert.equal((await f.call(args, chatID)).status, 1);
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.statePath), false);
  }
});

test('a resolved question receipt is consumed as observing without waiting, STOPPED or duplicate delivery', async t => {
  const f = await setup(t), armed = await f.arm();
  f.messages.get(f.session).push({ id: 'msg_tool', type: 'assistant', model, time: { created: Date.now() },
    content: [{ id: 'call_question', type: 'tool', name: 'question', time: { created: Date.now() }, state: { status: 'running', input: {} } }] });
  f.forms = [{ id: 'frm_question', sessionID: f.session, metadata: { kind: 'question', tool: { messageID: 'msg_tool', id: 'call_question' } },
    fields: [{ key: 'answer', type: 'string' }] }];
  f.emit('form.created', f.session); await f.end();
  await f.adapter.reply(f.workspace, f.plan, 'question', 'frm_question', { answer: { answer: 'fixture' } }, baseline);
  const result = await f.o.consume(armed.id);
  assert.equal(result.kind, 'observing'); assert.equal(result.rearm, true);
  assert.equal(f.state().bindings[0].phase, 'EXECUTING'); assert.equal(f.sent.length, 1);
});

test('an acknowledged receipt releases only its own leftover slot and never a newer observer', async t => {
  const f = await setup(t), armed = await f.arm(); f.finish(f.session); await f.end();
  const folder = join(f.stateRoot, 'observers', (await import('node:crypto')).createHash('sha256').update(chatID).digest('hex'));
  writeFileSync(join(folder, armed.id, 'consumed.json'), JSON.stringify({ kind: 'completed-for-review' }));
  assert.equal((await f.o.consume(armed.id)).kind, 'already-consumed');
  assert.equal(existsSync(join(folder, 'active')), false);
  writeFileSync(join(folder, 'active'), JSON.stringify({ id: '00000000-0000-4000-8000-000000000019' }));
  assert.equal((await f.o.consume(armed.id)).kind, 'already-consumed');
  assert.equal(JSON.parse(readFileSync(join(folder, 'active'), 'utf8')).id, '00000000-0000-4000-8000-000000000019');
  // This file is only a simulator sentinel; remove it before the fixture cleanup callback.
  (await import('node:fs')).unlinkSync(join(folder, 'active'));
});
