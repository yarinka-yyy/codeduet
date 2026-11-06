import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { baseline, fixture, model } from './http-fixture.mjs';

test('native CLI reads a long history and reports an incomplete HTTP body as a read failure', async t => {
  const f = await fixture(t, undefined, '2.2.5');
  const { status, result: { sessionID } } = await f.call(f.bindArgs(0));
  assert.equal(status, 0);
  f.messages.set(sessionID, [
    { id: 'msg_user', type: 'user', text: 'Existing fixture request' },
    { id: 'msg_long', type: 'assistant', model,
      content: [{ type: 'text', text: 'Строка журнала\n'.repeat(50_000) }] },
  ]);
  const args = ['preflight', f.workspace, f.plan, '--non-git-baseline', baseline];
  const saved = readFileSync(f.statePath), from = f.calls.length;
  const complete = await f.call(args);
  assert.match(complete.result.checks.find(check => check.name === 'history').reason, /Untracked history/);
  f.fault = 'history-truncated';
  const incomplete = await f.call(args);
  assert.equal(incomplete.status, 1);
  assert.equal(incomplete.result.taskSent, false);
  const diagnostic = incomplete.result.checks.find(check => check.name === 'history').diagnostic;
  assert.equal(diagnostic.category, 'request-read');
  assert.equal(diagnostic.operation, 'session.message.list');
  assert.equal(diagnostic.page, 'first');
  assert.deepEqual(readFileSync(f.statePath), saved);
  assert.ok(f.calls.slice(from).every(call => call.method === 'GET'));
});

test('an incomplete create response preserves uncertainty and does not retry the POST', async t => {
  const f = await fixture(t);
  f.fault = 'create-truncated';
  const failed = await f.call(f.bindArgs(0));
  assert.equal(failed.status, 1);
  assert.equal(failed.result.diagnostic.category, 'request-read');
  assert.equal(failed.result.diagnostic.operation, 'session.create');
  assert.match(failed.result.error, /mutation uncertain/);
  assert.equal(f.state().bindings[0].phase, 'STOPPED');
  assert.equal(f.state().bindings[0].uncertain, 'create');
  assert.equal(f.state().plans[0].correctionCount, 0);
  assert.equal((await f.call(f.bindArgs(0))).status, 1);
  assert.equal(f.posts('/api/session'), 1);
  assert.equal(f.sessions.size, 1);
});

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
  assert.equal(result.result.phase, 'PREPARING'); assert.equal(result.result.stateChange, 'unchanged');
  assert.equal(f.state().bindings[0].phase, 'PREPARING'); assert.equal(f.state().plans[0].correctionCount, 20);
  assert.ok(!f.calls.some(call => call.route.endsWith('/prompt')));
});
