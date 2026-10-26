import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fixture, model } from './http-fixture.mjs';

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
