import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, baseline } from './http-fixture.mjs';

async function waitForStream(f, waiting) {
  waiting.catch(() => {});
  const deadline = Date.now() + 2000;
  while (!f.streams.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!f.streams.size) { await waiting; assert.fail('CLI did not open its SSE stream'); }
}

for (const kind of ['question', 'permission']) test('native quiet wait returns only the correlated ' + kind, async t => {
  const f = await fixture(t), bound = await f.call(f.bindArgs(0)), sessionID = bound.result.sessionID;
  await f.call(['submit', f.workspace, f.plan, 'initial', f.packet, '--non-git-baseline', baseline]);
  const waiting = f.call(['wait', f.workspace, f.plan, '--non-git-baseline', baseline, '--timeout-ms', '2000']);
  await waitForStream(f, waiting);
  f.messages.get(sessionID).push({ id: 'msg_tool', type: 'assistant', model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' },
    content: [{ id: 'call_pending', type: 'tool', name: kind, state: { status: 'running' } }] });
  if (kind === 'question') f.forms = [{ id: 'frm_pending', sessionID, metadata: { kind: 'question', tool: { messageID: 'msg_tool', id: 'call_pending' } },
    fields: [{ key: 'q', type: 'string', title: 'Choice', options: [{ value: 'A', label: 'A' }], custom: true }] }];
  else f.permissions = [{ id: 'per_pending', sessionID, action: 'shell', resources: ['fixture-only'],
    source: { type: 'tool', messageID: 'msg_tool', id: 'call_pending' } }];
  f.emit(kind === 'question' ? 'form.created' : 'permission.created', sessionID);
  const outcome = await waiting;
  assert.equal(outcome.status, 0); assert.equal(outcome.result.kind, kind);
  assert.equal(outcome.result.phase, 'WAITING_FOR_ANSWER');
  assert.equal(outcome.stdout.trim().split('\n').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
});

for (const fault of ['http', 'redirect', 'content-type']) test('native SSE rejects ' + fault + ' without follow/retry or body leak', async t => {
  const f = await fixture(t); await f.call(f.bindArgs(0));
  await f.call(['submit', f.workspace, f.plan, 'initial', f.packet, '--non-git-baseline', baseline]);
  f.eventFault = fault;
  const outcome = await f.call(['wait', f.workspace, f.plan, '--non-git-baseline', baseline, '--timeout-ms', '2000']);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.result.diagnostic.category, fault === 'content-type' ? 'event-content-type' : 'event-http');
  if (fault !== 'content-type') assert.equal(outcome.result.diagnostic.httpStatus, fault === 'http' ? 429 : 302);
  assert.equal(outcome.result.phase, 'STOPPED');
  assert.equal(f.calls.filter(call => call.route === '/api/event').length, 1);
  assert.ok(!f.calls.some(call => call.route === '/must-not-follow'));
});

test('native HTTP request deadline is distinct from long SSE lifetime and preserves no bootstrap', async t => {
  const f = await fixture(t); f.fault = 'info-timeout';
  const outcome = await f.call(['inspect'], undefined, 25_000);
  assert.equal(outcome.status, 1); assert.equal(outcome.result.diagnostic.category, 'request-timeout');
  assert.equal(outcome.result.diagnostic.stage, 'request');
  assert.ok(outcome.result.diagnostic.elapsedMs >= 19_900);
  assert.ok(!existsSync(dirname(f.statePath)));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('native inspect supports no thread ID and unbound workspace without bootstrap/POST', async t => {
  const f = await fixture(t);
  const unknown = await f.call(['inspect'], '');
  assert.equal(unknown.status, 0); assert.equal(unknown.result.binding.status, 'unknown');
  assert.equal(unknown.result.session, null);
  const unbound = await f.call(['inspect', f.workspace]);
  assert.equal(unbound.result.binding.status, 'unbound');
  assert.equal(unbound.result.workspace.directory, f.workspace);
  assert.equal(unbound.result.session, null);
  assert.ok(!existsSync(dirname(f.statePath)));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('native inspect shows bound title/project/model/options/counter and preserves a foreign lock', async t => {
  const f = await fixture(t), bound = await f.call(f.bindArgs(7));
  const session = f.sessions.get(bound.result.sessionID); session.model.variant = 'high';
  const before = readFileSync(f.statePath), callsBefore = f.calls.length;
  const lock = join(dirname(f.statePath), 'state.lock'); writeFileSync(lock, 'OWNED_BY_ANOTHER_PROCESS');
  const outcome = await f.call(['inspect', f.workspace]);
  assert.equal(outcome.status, 0); assert.equal(outcome.result.kind, 'connected');
  assert.equal(outcome.result.binding.status, 'bound'); assert.equal(outcome.result.binding.correctionCount, 7);
  assert.equal(outcome.result.session.title, session.title);
  assert.equal(outcome.result.session.directory, f.workspace);
  assert.equal(outcome.result.session.model.variant, 'high');
  assert.equal(outcome.result.live.verified, true); assert.equal(outcome.result.live.active, false);
  assert.equal(outcome.result.live.outcome, 'unknown'); assert.equal(outcome.result.snapshotOnly, true);
  assert.equal(outcome.result.stateLocked, true);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(readFileSync(lock, 'utf8'), 'OWNED_BY_ANOTHER_PROCESS');
  assert.ok(f.calls.slice(callsBefore).every(call => call.method === 'GET' && !call.route.includes('/message?')));
});

for (const ending of ['end', 'destroy']) test('native SSE ' + ending + ' retains STOP diagnostic through offline inspection', async t => {
  const f = await fixture(t), bound = await f.call(f.bindArgs(0));
  assert.equal((await f.call(['submit', f.workspace, f.plan, 'initial', f.packet, '--non-git-baseline', baseline])).status, 0);
  const waiting = f.call(['wait', f.workspace, f.plan, '--non-git-baseline', baseline, '--timeout-ms', '2000']);
  await waitForStream(f, waiting);
  f.emit('execution.started', bound.result.sessionID);
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const stream of f.streams) stream[ending]();
  const stopped = await waiting;
  assert.equal(stopped.result.diagnostic.category, ending === 'end' ? 'event-eof' : 'event-read');
  if (ending === 'destroy') assert.equal(stopped.result.diagnostic.errorCode, 'ECONNRESET');
  const before = readFileSync(f.statePath);
  const online = await f.call(['inspect']);
  assert.equal(online.result.binding.phase, 'STOPPED');
  assert.deepEqual(online.result.binding.diagnostic, stopped.result.diagnostic);
  f.models = [];
  const offline = await f.call(['inspect']);
  assert.equal(offline.status, 1); assert.equal(offline.result.connection.verified, false);
  assert.equal(offline.result.binding.sessionID, bound.result.sessionID);
  assert.equal(offline.result.live.verified, false);
  assert.deepEqual(offline.result.binding.diagnostic, stopped.result.diagnostic);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
});

for (const failure of ['workspace', 'directory', 'model', 'active', 'shell', 'store', 'diagnostic']) {
  test('native inspect refuses ' + failure + ' uncertainty without repair/mutation', async t => {
    const f = await fixture(t), bound = await f.call(f.bindArgs(0));
    const other = join(f.root, 'other'); mkdirSync(other);
    if (failure === 'directory') f.sessions.get(bound.result.sessionID).location.directory = other;
    if (failure === 'model') f.sessions.get(bound.result.sessionID).model.id = 'unselected-model';
    if (failure === 'active') f.active = { [bound.result.sessionID]: { type: 'PRIVATE_UNKNOWN_STATUS_007' } };
    if (failure === 'shell') f.shells = [{ status: 'exited', time: {} }];
    if (failure === 'store') writeFileSync(f.statePath, 'PRIVATE_INVALID_STORE_007');
    if (failure === 'diagnostic') {
      const state = f.state();
      state.bindings[0].phase = 'STOPPED';
      state.bindings[0].diagnostic = { category: 'event-read', stage: 'stream', elapsedMs: 1, lastEvent: null, rawBody: 'PRIVATE_DIAGNOSTIC_007' };
      writeFileSync(f.statePath, JSON.stringify(state));
    }
    const before = readFileSync(f.statePath), callsBefore = f.calls.length;
    const outcome = await f.call(['inspect', failure === 'workspace' ? other : f.workspace]);
    assert.equal(outcome.status, 1); assert.equal(outcome.result.kind, 'stopped');
    assert.equal(outcome.result.live.verified, false); assert.equal(outcome.result.retried, false);
    assert.ok(!JSON.stringify(outcome).includes('PRIVATE_'));
    assert.deepEqual(readFileSync(f.statePath), before);
    assert.ok(f.calls.slice(callsBefore).every(call => call.method === 'GET'));
  });
}

test('missing registration does not discard local binding or create a lock', async t => {
  const f = await fixture(t); await f.call(f.bindArgs(3));
  const before = readFileSync(f.statePath);
  unlinkSync(join(f.home, '.local', 'state', 'opencode', 'service.json'));
  // No server requests means the fixture's registration invariant is not applicable.
  const { inspect } = await import('../helper/binding.mjs');
  const outcome = await inspect(null, { stateRoot: dirname(f.statePath), chatID: 'offline-http-chat-A',
    connectionError: new Error('Missing or invalid engine registration') });
  assert.equal(outcome.binding.correctionCount, 3); assert.equal(outcome.connection.verified, false);
  assert.equal(outcome.live.verified, false); assert.deepEqual(readFileSync(f.statePath), before);
  assert.ok(!existsSync(join(dirname(f.statePath), 'state.lock')));
});

test('inspect during a real CLI wait does not steal its lock or poll history', async t => {
  const f = await fixture(t), bound = await f.call(f.bindArgs(0));
  await f.call(['submit', f.workspace, f.plan, 'initial', f.packet, '--non-git-baseline', baseline]);
  const waiting = f.call(['wait', f.workspace, f.plan, '--non-git-baseline', baseline, '--timeout-ms', '3000']);
  try {
    const deadline = Date.now() + 2000;
    while (!f.calls.some(call => call.route.includes('/message?')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const before = readFileSync(f.statePath), historyBefore = f.calls.filter(call => call.route.includes('/message?')).length;
    assert.equal(historyBefore, 1);
    const outcome = await f.call(['inspect', f.workspace]);
    assert.equal(outcome.result.live.active, true); assert.equal(outcome.result.stateLocked, true);
    assert.ok(outcome.result.blockers.includes('Bound session is running'));
    assert.deepEqual(readFileSync(f.statePath), before);
    assert.ok(existsSync(join(dirname(f.statePath), 'state.lock')));
    assert.equal(f.calls.filter(call => call.route.includes('/message?')).length, historyBefore);
  } finally {
    f.finish(bound.result.sessionID);
    assert.equal((await waiting).result.kind, 'completed-for-review');
  }
});
