import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { fixture, baseline, model } from './http-fixture.mjs';

function seed(f, id = 'ses_existing', title = 'Existing fixture', empty = false) {
  const session = { id, title, location: { directory: f.workspace }, model: { ...model, variant: 'default' }, time: {} };
  delete session.model.enabled; delete session.model.status;
  f.sessions.set(id, session); f.messages.set(id, []);
  if (!empty) {
    const ended = Date.now() - 1000;
    f.messages.set(id, [
      { id: 'msg_priorUser', type: 'user', text: 'PRIVATE_PRIOR_TRANSCRIPT_008' },
      { id: 'msg_priorFinal', type: 'assistant', model, finish: 'stop', time: { completed: ended },
        content: [{ type: 'text', text: 'PRIVATE_PRIOR_RESULT_008' }] },
      { id: 'msg_priorIdle', type: 'idle', outcome: 'succeeded', time: { created: ended } },
    ]);
    Object.assign(session, { outcome: 'succeeded', time: { idle: ended, updated: ended } });
  }
  return session;
}
const adoptArgs = (f, id = 'ses_existing', count = 19) => ['adopt', f.workspace, f.plan, id,
  ...(count === undefined ? [] : ['--correction-count', String(count)]), '--non-git-baseline', baseline];
const submitArgs = (f, id = 'adopted-correction', kind = 'correction') => ['submit', f.workspace, f.plan, id, f.packet,
  '--kind', kind, '--non-git-baseline', baseline];
const waitArgs = f => ['wait', f.workspace, f.plan, '--timeout-ms', '3000', '--non-git-baseline', baseline];
async function streamed(f, waiting) {
  waiting.catch(() => {});
  const deadline = Date.now() + 2500;
  while (!f.streams.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!f.streams.size) { await waiting; assert.fail('Wait never opened its stream'); }
}

test('native discovery is read-only, paged, physical-directory scoped and never selects a recipient', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 51; i++) seed(f, 'ses_candidate' + i, 'Same title');
  const first = await f.call(['sessions', f.workspace], '');
  assert.equal(first.status, 0); assert.equal(first.result.sessions.length, 50);
  assert.equal(first.result.recipientSelected, false); assert.equal(first.result.snapshotOnly, true);
  assert.equal(first.result.exhausted, false);
  const second = await f.call(['sessions', f.workspace, '--cursor', first.result.nextCursor], '');
  assert.equal(second.result.sessions.length, 1); assert.equal(second.result.exhausted, false);
  const last = await f.call(['sessions', f.workspace, '--cursor', second.result.nextCursor], '');
  assert.equal(last.result.exhausted, true); assert.equal(last.result.sessions.length, 0);
  assert.ok(!existsSync(dirname(f.statePath)));
  assert.ok(f.calls.every(call => call.method === 'GET' && !call.route.includes('/message?')));
});

test('native discovery rejects ambiguous or malformed page identity and does not repair a store', async t => {
  const f = await fixture(t), candidate = seed(f);
  for (const page of [
    { data: [candidate, candidate], cursor: {} },
    { data: [{ ...candidate, location: { directory: dirname(f.workspace) } }], cursor: {} },
    { data: [candidate] },
    { data: [candidate], cursor: { next: 42 } },
    { data: [candidate], cursor: [] },
  ]) {
    f.sessionPage = page;
    assert.equal((await f.call(['sessions', f.workspace])).status, 1);
    assert.ok(!existsSync(dirname(f.statePath)));
  }
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('native adoption preserves existing history/title/model and is idempotent without any engine POST', async t => {
  const f = await fixture(t), session = seed(f), history = structuredClone(f.messages.get(session.id));
  const before = structuredClone(session);
  const adopted = await f.call(adoptArgs(f));
  assert.equal(adopted.status, 0); assert.equal(adopted.result.kind, 'adopted');
  assert.equal(adopted.result.phase, 'PREPARING'); assert.equal(adopted.result.correctionCount, 19);
  assert.deepEqual(session, before); assert.deepEqual(f.messages.get(session.id), history);
  const state = readFileSync(f.statePath), repeatArgs = adoptArgs(f, session.id);
  repeatArgs.splice(repeatArgs.indexOf('--correction-count'), 2);
  const repeated = await f.call(repeatArgs);
  assert.equal(repeated.status, 0); assert.equal(repeated.result.kind, 'reused');
  assert.deepEqual(readFileSync(f.statePath), state);
  const stored = state.toString();
  assert.ok(!stored.includes('PRIVATE_PRIOR_') && !adopted.stdout.includes('PRIVATE_PRIOR_'));
  assert.equal(f.state().bindings[0].adoption.lastMessageID, 'msg_priorIdle');
  assert.ok(f.calls.every(call => call.method === 'GET'));
  const inspected = await f.call(['inspect', f.workspace]);
  assert.equal(inspected.result.session.id, session.id);
  assert.equal(inspected.result.session.model.variant, 'default');
});

test('an empty explicitly selected existing fixture can be adopted with an explicit new-plan zero', async t => {
  const f = await fixture(t); seed(f, 'ses_empty', 'Empty', true);
  const result = await f.call(adoptArgs(f, 'ses_empty', 0));
  assert.equal(result.status, 0);
  assert.deepEqual(f.state().bindings[0].adoption, { variant: 'default', lastMessageID: null, idleAt: null });
  assert.equal((await f.call(submitArgs(f, 'new-plan', 'initial'))).status, 0);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('adoption refuses missing/invalid/conflicting correction counts without inventing or resetting zero', async t => {
  const f = await fixture(t); seed(f);
  const missing = adoptArgs(f); missing.splice(missing.indexOf('--correction-count'), 2);
  assert.equal((await f.call(missing)).status, 1); assert.ok(!existsSync(f.statePath));
  for (const count of [-1, 21, 'unknown']) {
    assert.equal((await f.call(adoptArgs(f, 'ses_existing', count))).status, 1);
    assert.ok(!existsSync(f.statePath));
  }
  assert.equal((await f.call(adoptArgs(f))).status, 0);
  const before = readFileSync(f.statePath);
  assert.equal((await f.call(adoptArgs(f, 'ses_existing', 0))).status, 1);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

const unsafe = {
  running: (f, s) => { f.active[s.id] = { type: 'running' }; },
  form: f => { f.forms = [{ id: 'frm_old' }]; },
  permission: f => { f.permissions = [{ id: 'per_old' }]; },
  shell: f => { f.shells = [{ status: 'running' }]; },
  unknownShell: f => { f.shells = [{ status: 'unknown' }]; },
  model: (f, s) => { s.model.providerID = 'opencode'; },
  options: (f, s) => { s.model.settings = { temperature: 1 }; },
  directory: (f, s) => { s.location.directory = dirname(f.workspace); },
  archived: (f, s) => { s.time.archived = Date.now(); },
  failed: (f, s) => { s.outcome = 'failed'; },
  interrupted: f => { f.messages.get('ses_existing').at(-1).outcome = 'interrupted'; },
  unfinishedTool: f => { f.messages.get('ses_existing')[1].content.push({ id: 'call_old', type: 'tool', name: 'edit', state: { status: 'running' } }); },
  detachedTool: f => { f.messages.get('ses_existing')[1].content.push({ id: 'call_old', type: 'tool', name: 'background', state: { status: 'completed' }, time: { completed: Date.now() - 2000 } }); },
  history: f => { f.messagePage = { data: [{ id: 'msg_unknown', type: 'unknown' }], cursor: {} }; },
};
for (const [name, mutate] of Object.entries(unsafe)) test('native adoption refuses unsafe ' + name + ' without saving a pair or POST', async t => {
  const f = await fixture(t), session = seed(f);
  mutate(f, session);
  const result = await f.call(adoptArgs(f));
  assert.equal(result.status, 1, name);
  assert.ok(!existsSync(f.statePath));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('a race during adoption rechecks active state before the atomic local binding', async t => {
  const f = await fixture(t), session = seed(f);
  f.onRequest = route => { if (route.includes('/message?limit=1&')) f.active[session.id] = { type: 'running' }; };
  assert.equal((await f.call(adoptArgs(f))).status, 1);
  assert.ok(!existsSync(f.statePath)); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('foreign binding, STOPPED, a changed engine and invalid state do not permit adoption takeover', async t => {
  const f = await fixture(t); seed(f); seed(f, 'ses_other');
  await f.call(adoptArgs(f));
  const before = readFileSync(f.statePath);
  assert.equal((await f.call(adoptArgs(f, 'ses_other'))).status, 1);
  assert.equal((await f.call(adoptArgs(f), 'offline-chat-B')).status, 1);
  assert.deepEqual(readFileSync(f.statePath), before);
  for (const mutate of [
    state => { state.bindings[0].phase = 'STOPPED'; state.bindings[0].uncertain = 'submit'; },
    state => { state.bindings[0].engineID = 'changed'; },
    state => { state.bindings[0].adoption.extra = 'not allowed'; },
  ]) {
    const state = JSON.parse(before); mutate(state);
    writeFileSync(f.statePath, JSON.stringify(state)); const exact = readFileSync(f.statePath);
    assert.equal((await f.call(adoptArgs(f))).status, 1);
    assert.deepEqual(readFileSync(f.statePath), exact);
  }
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('a foreign state lock survives rejected adoption unchanged', async t => {
  const f = await fixture(t); seed(f);
  mkdirSync(dirname(f.statePath)); const lock = join(dirname(f.statePath), 'state.lock');
  writeFileSync(lock, 'OTHER_OWNER');
  assert.equal((await f.call(adoptArgs(f))).status, 1);
  assert.equal(readFileSync(lock, 'utf8'), 'OTHER_OWNER'); assert.ok(!existsSync(f.statePath));
});

test('an active sibling in the same Git checkout blocks existing-session adoption', async t => {
  const f = await fixture(t); seed(f);
  execFileSync('git', ['init', '--quiet'], { cwd: f.root, windowsHide: true });
  const sibling = join(f.root, 'sibling'); mkdirSync(sibling);
  f.sessions.set('ses_sibling', { id: 'ses_sibling', location: { directory: sibling } });
  f.active.ses_sibling = { type: 'running' };
  assert.equal((await f.call(adoptArgs(f))).status, 1);
  assert.ok(!existsSync(f.statePath)); assert.ok(f.calls.every(call => call.method === 'GET'));
});

for (const name of ['variant', 'history', 'running']) test('adopted submit rejects changed ' + name + ' before sending a prompt or spending a cycle', async t => {
  const f = await fixture(t), session = seed(f); await f.call(adoptArgs(f));
  const before = readFileSync(f.statePath);
  if (name === 'variant') session.model.variant = 'another';
  if (name === 'running') f.active[session.id] = { type: 'running' };
  if (name === 'history') {
    f.messages.get(session.id).push({ id: 'msg_external', type: 'user', text: 'Outside task' }); f.finish(session.id);
  }
  assert.equal((await f.call(submitArgs(f))).status, 1);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('adopted 19->20 uses the common wait/review/next/new-plan workflow and ignores old final messages', async t => {
  const f = await fixture(t), session = seed(f), old = structuredClone(f.messages.get(session.id));
  await f.call(adoptArgs(f));
  const admitted = await f.call(submitArgs(f));
  assert.equal(admitted.status, 0); assert.equal(admitted.result.correctionCount, 20);
  assert.deepEqual(f.messages.get(session.id).slice(0, old.length), old);
  const waiting = f.call(waitArgs(f)); await streamed(f, waiting);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.running.stdoutBytes, 0); assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  f.finish(session.id);
  assert.equal((await waiting).result.kind, 'completed-for-review');
  assert.equal((await f.call(['next', f.workspace, f.plan, 'block', '--non-git-baseline', baseline])).status, 0);
  assert.equal((await f.call(submitArgs(f, 'next-block', 'block'))).status, 0);
  const again = f.call(waitArgs(f)); await streamed(f, again); f.finish(session.id); assert.equal((await again).status, 0);
  assert.equal((await f.call(['finish', f.workspace, f.plan, '--non-git-baseline', baseline])).status, 0);
  const secondPlan = join(dirname(f.plan), '002-next.md'); writeFileSync(secondPlan, baseline);
  const switched = await f.call(['bind', f.workspace, secondPlan, '--correction-count', '0', '--non-git-baseline', baseline]);
  assert.equal(switched.status, 0); assert.equal(switched.result.sessionID, session.id);
  const args = submitArgs(f, 'new-plan-block', 'initial'); args[2] = secondPlan;
  assert.equal((await f.call(args)).status, 0);
  assert.deepEqual(f.state().plans.map(plan => plan.correctionCount), [20, 0]);
  assert.equal(f.posts('/api/session'), 0);
});

test('an old pending request after an adopted submit cannot be answered as a new assignment request', async t => {
  const f = await fixture(t), session = seed(f); await f.call(adoptArgs(f));
  await f.call(submitArgs(f));
  const waiting = f.call(waitArgs(f)); await streamed(f, waiting);
  f.forms = [{ id: 'frm_old', sessionID: session.id, metadata: { kind: 'question', tool: { messageID: 'msg_priorFinal', id: 'call_old' } }, fields: [] }];
  f.emit('form.created', session.id);
  const stopped = await waiting;
  assert.equal(stopped.status, 1); assert.equal(stopped.result.phase, 'STOPPED');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('an uncertain adopted correction spends cycle 20 exactly once and cannot be adopted or submitted again', async t => {
  const f = await fixture(t); seed(f); await f.call(adoptArgs(f)); f.fault = 'drop';
  assert.equal((await f.call(submitArgs(f))).status, 1);
  assert.equal(f.state().plans[0].correctionCount, 20); assert.equal(f.state().bindings[0].uncertain, 'submit');
  assert.equal((await f.call(adoptArgs(f, 'ses_existing', 20))).status, 1);
  assert.equal((await f.call(submitArgs(f))).status, 1);
  assert.equal(f.posts('/api/session/ses_existing/prompt'), 1);
});

test('an adopted plan already at 20 refuses corrective submission without a 21st prompt', async t => {
  const f = await fixture(t); seed(f); await f.call(adoptArgs(f, 'ses_existing', 20));
  const stopped = await f.call(submitArgs(f));
  assert.equal(stopped.result.kind, 'correction-limit'); assert.equal(stopped.result.correctionCount, 20);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('long prior exchange uses bounded pagination without importing older tasks', async t => {
  const f = await fixture(t), session = seed(f);
  const messages = f.messages.get(session.id), ended = session.time.idle;
  messages.splice(1, 0, ...Array.from({ length: 105 }, (_, index) => ({ id: 'msg_step' + index,
    type: 'assistant', model, finish: 'stop', time: { completed: ended - 1 }, content: [] })));
  assert.equal((await f.call(adoptArgs(f))).status, 0);
  assert.ok(f.calls.some(call => call.route.includes('/message?limit=100&cursor=')));
  assert.ok(!f.calls.some(call => call.route.includes('/message?') && call.route.includes('cursor=') && call.route.includes('order=')));
  assert.equal(f.state().bindings[0].adoption.lastMessageID, 'msg_priorIdle');
  assert.ok(!readFileSync(f.statePath, 'utf8').includes('PRIVATE_PRIOR_'));
});

test('truncated discovery titles are marked and invalid exact IDs never reach the engine', async t => {
  const f = await fixture(t); seed(f, 'ses_existing', 'A'.repeat(201));
  const result = await f.call(['sessions', f.workspace]);
  assert.equal(result.result.sessions[0].titleTruncated, true);
  assert.equal(result.result.sessions[0].title.length, 200);
  const before = f.calls.length;
  assert.equal((await f.call(adoptArgs(f, '../another-route'))).status, 1);
  assert.ok(f.calls.slice(before).every(call => ['/api/info', '/api/model'].includes(call.route)));
  assert.ok(!existsSync(f.statePath));
});

test('a request that appears during adopted-submit validation prevents dispatch and count reservation', async t => {
  const f = await fixture(t); seed(f); await f.call(adoptArgs(f));
  const before = readFileSync(f.statePath);
  f.onRequest = route => { if (route.includes('/message?limit=1&')) f.permissions = [{ id: 'per_racing' }]; };
  assert.equal((await f.call(submitArgs(f))).status, 1);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

const adoptFailures = [
  ['initial active check', '/api/session/active', 1, 'session.active'],
  ['session identity', '/api/session/ses_existing', 1, 'session.get'],
  ['forms', '/api/session/ses_existing/form', 1, 'session.form.list'],
  ['permissions', '/api/session/ses_existing/permission', 1, 'session.permission.list'],
  ['first history page', '/message?limit=100&order=desc', 1, 'session.message.list', 'first'],
  ['cursor history page', '/message?limit=100&cursor=', 1, 'session.message.list', 'cursor'],
  ['shell check', '/api/shell?', 1, 'shell.list'],
  ['latest head', '/message?limit=1&order=desc', 1, 'session.message.list', 'first'],
  ['confirmed identity', '/api/session/ses_existing', 2, 'session.get'],
  ['last active check', '/api/session/active', 4, 'session.active'],
];
for (const [name, routePart, occurrence, operation, page] of adoptFailures) {
  test('adopt HTTP 400 at ' + name + ' preserves binding state/counter and sends no POST', async t => {
    const f = await fixture(t), session = seed(f);
    if (page === 'cursor') {
      f.messages.get(session.id).splice(1, 0, ...Array.from({ length: 105 }, (_, index) => ({
        id: 'msg_priorStep' + index, type: 'assistant', model, finish: 'stop',
        time: { completed: session.time.idle - 1 }, content: [],
      })));
    }
    // Keep an existing record/count to prove failures don't replace the store.
    assert.equal((await f.call(f.bindArgs(7))).status, 0);
    const before = readFileSync(f.statePath), start = f.calls.length;
    let matches = 0, rejected = 0;
    f.rejectRequest = (_method, route) => {
      const match = routePart.startsWith('/api/session/ses_existing') || routePart === '/api/session/active' ?
        route === routePart : route.includes(routePart);
      if (match && ++matches === occurrence) {
        rejected++;
        return { _tag: page === 'cursor' ? 'InvalidCursorError' : 'InvalidRequestError',
          message: 'OFFLINE_HTTP_CANARY_007', path: 'PRIVATE_SERVER_PATH' };
      }
    };
    const outcome = await f.call(adoptArgs(f, session.id, 7), 'offline-http-chat-B');
    assert.equal(outcome.status, 1); assert.equal(rejected, 1);
    assert.equal(outcome.result.diagnostic.httpStatus, 400);
    assert.equal(outcome.result.diagnostic.operation, operation);
    assert.equal(outcome.result.diagnostic.method, 'GET');
    assert.equal(outcome.result.diagnostic.page, page);
    assert.equal(outcome.result.diagnostic.errorCode, page === 'cursor' ? 'InvalidCursorError' : 'InvalidRequestError');
    assert.deepEqual(outcome.result.adoption, { bindingState: 'unchanged', engineMutation: 'none' });
    assert.equal(outcome.result.retried, false);
    assert.deepEqual(readFileSync(f.statePath), before);
    assert.ok(!existsSync(join(dirname(f.statePath), 'state.lock')));
    assert.ok(f.calls.slice(start).every(call => call.method === 'GET'));
    assert.ok(!JSON.stringify(outcome.result).includes(session.id) && !JSON.stringify(outcome.result).includes('PRIVATE_'));
  });
}

test('adopt HTTP 400 before its first save leaves no binding file', async t => {
  const f = await fixture(t); seed(f);
  f.rejectRequest = (_method, route) => route.includes('/message?') ?
    { _tag: 'InvalidRequestError', message: 'OFFLINE_HTTP_CANARY_007' } : undefined;
  const result = await f.call(adoptArgs(f));
  assert.equal(result.status, 1);
  assert.deepEqual(result.result.adoption, { bindingState: 'unchanged', engineMutation: 'none' });
  assert.ok(!existsSync(f.statePath)); assert.ok(f.calls.every(call => call.method === 'GET'));
});

for (const variant of ['unknown-tag', 'oversized-body']) test('HTTP diagnostic drops ' + variant + ' and private server text', async t => {
  const f = await fixture(t); seed(f);
  f.rejectRequest = (_method, route) => route.includes('/message?') ?
    { _tag: variant === 'unknown-tag' ? 'PRIVATE_SERVER_TAG' : 'InvalidCursorError',
      message: 'OFFLINE_HTTP_CANARY_007'.repeat(variant === 'oversized-body' ? 1000 : 1) } : undefined;
  const outcome = await f.call(adoptArgs(f));
  assert.equal(outcome.status, 1); assert.equal(outcome.result.diagnostic.operation, 'session.message.list');
  assert.equal(outcome.result.diagnostic.errorCode, undefined);
  assert.ok(!JSON.stringify(outcome.result).includes('PRIVATE_'));
  assert.ok(!existsSync(f.statePath)); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('HTTP 400 on adopted prompt keeps one uncertain correction and refuses resubmission/adoption', async t => {
  const f = await fixture(t); seed(f); assert.equal((await f.call(adoptArgs(f))).status, 0);
  f.rejectRequest = (method, route) => method === 'POST' && route.endsWith('/prompt') ?
    { _tag: 'InvalidRequestError', message: 'OFFLINE_HTTP_CANARY_007' } : undefined;
  const failed = await f.call(submitArgs(f));
  assert.equal(failed.status, 1); assert.equal(failed.result.diagnostic.operation, 'session.prompt');
  assert.equal(failed.result.diagnostic.method, 'POST');
  assert.equal(failed.result.diagnostic.errorCode, 'InvalidRequestError');
  assert.equal(failed.result.adoption, undefined);
  const before = readFileSync(f.statePath);
  assert.equal(f.state().bindings[0].phase, 'STOPPED'); assert.equal(f.state().bindings[0].uncertain, 'submit');
  assert.equal(f.state().plans[0].correctionCount, 20);
  assert.equal((await f.call(submitArgs(f))).status, 1);
  assert.equal((await f.call(adoptArgs(f, 'ses_existing', 20))).status, 1);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(f.posts('/api/session/ses_existing/prompt'), 1);
});

for (const written of [false, true]) test('adopt persistence failure reports unconfirmed binding even when rename ' + (written ? 'completed' : 'did not run'), async t => {
  const f = await fixture(t), session = seed(f);
  const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: 'offline-http-chat-A' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (args[1] !== f.statePath) return rename(...args);
    if (written) rename(...args);
    throw Object.assign(new Error('PRIVATE_SERVER_PATH'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(adapter.adopt(f.workspace, f.plan, session.id, baseline, 7), error => {
      assert.equal(error.adoptionState, 'unconfirmed');
      assert.equal(error.diagnostic.stage, 'state-write');
      assert.equal(error.diagnostic.errorCode, 'EIO');
      assert.ok(!error.message.includes('PRIVATE_')); return true;
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(existsSync(f.statePath), written);
  if (written) { assert.equal(f.state().bindings[0].phase, 'PREPARING'); assert.equal(f.state().plans[0].correctionCount, 7); }
  assert.ok(!existsSync(join(dirname(f.statePath), 'state.lock')));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
