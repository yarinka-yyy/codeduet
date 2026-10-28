import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, basename } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { observer } from '../helper/observer.mjs';
import { selectExternal, externalOutcome } from '../helper/external-observation.mjs';

const chatID = '00000000-0000-4000-8000-000000000024';
async function setup(t, external = false) {
  const f = await fixture(t, undefined, '2.2.0'), stateRoot = dirname(f.statePath);
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const client = await connectEngine(), adapter = helper(client, { stateRoot, chatID });
  let sessionID, messageID;
  if (external) {
    sessionID = 'ses_manual'; messageID = 'msg_manual';
    f.sessions.set(sessionID, { id: sessionID, location: { directory: f.workspace },
      model: { providerID: model.providerID, id: model.id }, time: {} });
    f.messages.set(sessionID, [{ id: messageID, type: 'user', text: 'Implement ' + basename(f.plan) }]);
    f.active[sessionID] = { type: 'running' };
  } else {
    await adapter.bind(f.workspace, f.plan, baseline, 8);
    await adapter.submit(f.workspace, f.plan, 'audit-correction-nine', f.packet, baseline, 'correction');
    ({ sessionID, messageID } = f.state().bindings[0]);
  }
  let running;
  const sent = [], o = observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
    deliver: async pin => { sent.push(pin.id); return { status: 'sent', exitCode: 0 }; },
    launch: async id => { running = o.worker(id); } });
  t.after(async () => { if (o.status().id) await o.cancel(o.status().id); await running; });
  const folder = join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex'));
  return Object.assign(f, { client, adapter, o, sent, stateRoot, sessionID, messageID, folder,
    end: () => running,
    arm: () => o.arm(f.workspace, f.plan, { codexExe: process.execPath, timeoutMs: 5000,
      ...(external ? { sessionID, messageID } : { nonGitBaseline: baseline }) }) });
}

function failTool(f, name) {
  f.messages.get(f.sessionID).push({ id: 'msg_error', type: 'assistant', model, time: { completed: Date.now() },
    content: [{ type: 'tool', id: 'call_error', name, time: { completed: Date.now() },
      state: { status: 'error', error: { type: 'tool.execution', message: 'PRIVATE_ERROR_CREDENTIAL' } } }] });
}

for (const external of [true, false]) for (const name of ['webfetch', 'read', 'shell', 'edit']) {
  test(`${external ? 'passive' : 'bound'} ${name} error during running stays watched; idle failure stays failed`, async t => {
    const f = await setup(t, external); failTool(f, name);
    const started = await f.arm();
    assert.equal(started.kind, 'observer-armed');
    assert.equal(f.sent.length, 0);
    if (external) {
      const pin = await selectExternal(f.client, f.stateRoot, f.workspace, f.plan, f.sessionID, f.messageID);
      const outcome = await externalOutcome(f.client, f.stateRoot, pin);
      assert.equal(outcome.kind, 'observing'); assert.equal(outcome.exchangeOutcome, 'failed');
      assert.equal(outcome.exchangeFailure.reason, 'tool-error'); assert.equal(outcome.reviewAllowed, false);
    }
    f.finish(f.sessionID); await f.end();
    assert.equal(f.sent.length, 1);
    const saved = f.o.status(started.id).result;
    assert.equal(saved.kind, 'failed'); assert.equal(saved.exchangeFailure.reason, 'tool-error');
    assert.equal(saved.exchangeFailure.toolID, 'call_error');
    assert.ok(!JSON.stringify(saved).includes('PRIVATE_ERROR_CREDENTIAL'));
    const consumed = await f.o.consume(started.id);
    assert.equal(consumed.kind, external ? 'failed' : 'stopped');
    assert.equal(f.posts(`/api/session/${f.sessionID}/prompt`), external ? 0 : 1);
    if (!external) assert.equal(f.state().plans[0].correctionCount, 9);
  });
}

test('ordinary wait rejects unknown activity and does not claim readiness', async t => {
  const f = await setup(t); f.active[f.sessionID] = { type: 'unknown' };
  const outcome = await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true });
  assert.equal(outcome.phase, 'STOPPED'); assert.match(outcome.error, /Unknown active/);
});

test('ordinary wait preserves concurrently changed count and does not write a stale phase', async t => {
  const f = await setup(t); let changed = false;
  f.onRequest = route => {
    if (!changed && route === '/api/session/active') {
      changed = true;
      const state = f.state(); state.plans[0].correctionCount = 10;
      writeFileSync(f.statePath, JSON.stringify(state)); f.finish(f.sessionID);
    }
  };
  const outcome = await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true });
  assert.notEqual(outcome.kind, 'completed-for-review');
  assert.match(outcome.error, /count|assignment changed/i);
  assert.equal(f.state().plans[0].correctionCount, 10);
  assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  assert.equal(readFileSync(f.statePath, 'utf8').includes('audit-correction-nine'), true);
});

for (const external of [true, false]) for (const reason of ['message-error', 'retry-record', 'failed-compaction', 'interrupted-idle']) {
  test(`${external ? 'passive' : 'bound'} ${reason} retains failure and a later correlated question`, async t => {
    const f = await setup(t, external), now = Date.now();
    const failed = { id: 'msg_failure', type: 'assistant', model, content: [], time: { completed: now } };
    if (reason === 'message-error') failed.error = { type: 'provider', message: 'PRIVATE_PROVIDER_ERROR' };
    if (reason === 'retry-record') failed.retry = { attempt: 1 };
    if (reason === 'failed-compaction') {
      delete failed.content;
      Object.assign(failed, { type: 'compaction', status: 'failed', reason: 'auto', time: { created: now } });
    }
    if (reason === 'interrupted-idle') Object.assign(failed, { type: 'idle', outcome: 'interrupted' });
    f.messages.get(f.sessionID).push(failed);
    const started = await f.arm(); assert.equal(started.kind, 'observer-armed');
    f.messages.get(f.sessionID).push({ id: 'msg_question', type: 'assistant', model, content: [
      { type: 'tool', id: 'call_question', name: 'question', state: { status: 'running' } }] });
    f.forms = [{ id: 'frm_question', sessionID: f.sessionID, metadata: { kind: 'question',
      tool: { messageID: 'msg_question', id: 'call_question' } }, fields: [{ key: 'answer', type: 'string' }] }];
    f.emit('form.created', f.sessionID); await f.end();
    const consumed = await f.o.consume(started.id); assert.equal(consumed.kind, 'question');
    assert.equal(consumed.exchangeOutcome, reason === 'interrupted-idle' ? 'interrupted' : 'failed');
    assert.equal(consumed.exchangeFailure.reason, reason); assert.equal(consumed.reviewAllowed, false);
    if (!external) {
      const answer = await f.adapter.reply(f.workspace, f.plan, 'question', 'frm_question', { answer: { answer: 'fixture' } }, baseline);
      assert.equal(answer.kind, 'replied'); assert.equal(f.state().plans[0].correctionCount, 9);
    }
  });
}

test('bound pin drift still sends one error hint, but consume refuses the stale count', async t => {
  const f = await setup(t), armed = await f.arm();
  const state = f.state(); state.plans[0].correctionCount = 10; writeFileSync(f.statePath, JSON.stringify(state));
  f.emit('tool.success', f.sessionID); await f.end();
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.o.consume(armed.id), /pins\/count/);
  assert.equal(f.state().plans[0].correctionCount, 10);
  assert.equal(f.posts(`/api/session/${f.sessionID}/prompt`), 1);
});

for (const external of [true, false]) test(`${external ? 'passive' : 'bound'} failure is confirmed after fresh activity; a resumed executor stays observed`, async t => {
  const f = await setup(t, external); failTool(f, 'webfetch');
  const pin = external ? await selectExternal(f.client, f.stateRoot, f.workspace, f.plan, f.sessionID, f.messageID) : null;
  f.finish(f.sessionID);
  let activeReads = 0;
  f.onRequest = route => {
    if (route === '/api/session/active' && ++activeReads === 2) f.active[f.sessionID] = { type: 'running' };
  };
  const result = external ? await externalOutcome(f.client, f.stateRoot, pin) :
    await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true });
  assert.equal(result.kind, 'observing'); assert.equal(result.exchangeOutcome, 'failed');
  assert.equal(result.executorActivity, 'running'); assert.equal(result.reviewAllowed, false);
  assert.ok(activeReads >= 2);
});

for (const external of [true, false]) for (const kind of ['question', 'permission']) {
  test(`${external ? 'passive' : 'bound'} correlated ${kind} remains actionable with failed history and no running entry`, async t => {
    const f = await setup(t, external); failTool(f, 'webfetch');
    f.messages.get(f.sessionID).push({ id: 'msg_pending', type: 'assistant', model, content: [
      { type: 'tool', id: 'call_pending', name: kind === 'question' ? 'question' : 'shell', state: { status: 'running' } }] });
    const request = kind === 'question' ? { id: 'frm_pending', sessionID: f.sessionID,
      metadata: { kind: 'question', tool: { messageID: 'msg_pending', id: 'call_pending' } },
      fields: [{ key: 'answer', type: 'string' }] } : { id: 'per_pending', sessionID: f.sessionID,
      source: { type: 'tool', messageID: 'msg_pending', id: 'call_pending' }, action: 'shell', resources: ['fixture'] };
    if (kind === 'question') f.forms = [request]; else f.permissions = [request];
    delete f.active[f.sessionID];
    const outcome = external ? await externalOutcome(f.client, f.stateRoot,
      await selectExternal(f.client, f.stateRoot, f.workspace, f.plan, f.sessionID, f.messageID)) :
      await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true, timeoutMs: 500 });
    assert.equal(outcome.kind, kind); assert.equal(outcome.exchangeOutcome, 'failed');
    assert.equal(outcome.reviewAllowed, false); assert.equal(outcome.dispatchAllowed, false);
    if (!external) {
      const answer = await f.adapter.reply(f.workspace, f.plan, kind, request.id,
        kind === 'question' ? { answer: { answer: 'fixture' } } : { decision: 'once' }, baseline);
      assert.equal(answer.kind, 'replied'); assert.equal(f.state().plans[0].correctionCount, 9);
    }
  });
}
