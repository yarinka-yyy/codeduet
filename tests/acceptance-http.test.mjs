import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { baseline, fixture, model } from './http-fixture.mjs';

test('submit rechecks a fresh pair if a manual exchange followed preflight', async t => {
  const f = await fixture(t, undefined, '2.2.6');
  const { result: { sessionID } } = await f.call(f.bindArgs(0));
  const args = ['--non-git-baseline', baseline];
  assert.equal((await f.call(['preflight', f.workspace, f.plan, ...args])).status, 0);
  f.messages.get(sessionID).push({ id: 'msg_manual', type: 'user', text: 'Untracked work' });
  f.finish(sessionID);
  const saved = readFileSync(f.statePath);
  const outcome = await f.call(['submit', f.workspace, f.plan, 'first', f.packet, ...args]);
  assert.equal(outcome.status, 1);
  assert.match(outcome.result.error, /Untracked history/);
  assert.deepEqual(readFileSync(f.statePath), saved);
  assert.equal(f.posts(`/api/session/${sessionID}/prompt`), 0);
});

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
  const checked = await f.call(['reconcile', f.workspace, f.plan, '--non-git-baseline', baseline]);
  assert.equal(checked.result.kind, 'mutation-reconciled', JSON.stringify(checked.result));
  assert.equal(checked.result.sessionID, [...f.sessions.keys()][0]);
  assert.equal(checked.result.phase, 'PREPARING');
  assert.equal(f.posts('/api/session'), 1);
});

test('reconcile accepts an exact prompt after a lost ACK and spends its correction once', async t => {
  const f = await fixture(t);
  const pair = await f.call(f.bindArgs(2));
  f.fault = 'prompt-ack-lost';
  assert.equal((await f.call(f.submitArgs)).status, 1);
  const { messageID, sessionID } = f.state().bindings[0], args = ['reconcile', f.workspace, f.plan, '--non-git-baseline', baseline];
  const prompt = f.messages.get(sessionID)[0], original = prompt.text;
  prompt.text += '\nEdited';
  assert.equal((await f.call(args)).status, 1);
  assert.equal(f.state().bindings[0].uncertain, 'submit');
  prompt.text = original;
  const result = await f.call(args);
  assert.equal(result.result.kind, 'mutation-reconciled', JSON.stringify(result.result));
  assert.equal(result.result.messageID, messageID);
  assert.equal(result.result.correctionCount, 3);
  assert.equal(result.result.phase, 'EXECUTING');
  assert.equal(f.posts(`/api/session/${pair.result.sessionID}/prompt`), 1);
});

test('accepted delivery identifies a partial Markdown checkpoint and a moved plan', async t => {
  const f = await fixture(t), args = ['--non-git-baseline', baseline];
  const pair = await f.call(f.bindArgs(0));
  const admitted = await f.call(f.submitArgs);
  const messageID = admitted.result.messageID;
  f.finish(pair.result.sessionID);
  assert.equal((await f.call(['wait', f.workspace, f.plan, ...args])).result.kind, 'completed-for-review');
  assert.equal((await f.call(['finish', f.workspace, f.plan, ...args])).result.phase, 'FINISHED');
  const moved = join(dirname(f.plan), '001-accepted.md'), target = join(dirname(f.plan), '002-test.md'), index = join(dirname(f.plan), 'README.md');
  renameSync(f.plan, moved);
  writeFileSync(target, baseline);
  writeFileSync(index, '| [001](001-accepted.md) | Fixture | ACTIVE |\n');
  const check = () => f.call(['acceptance-status', f.workspace, moved, messageID, '--index', index]);
  const before = (await check()).result;
  assert.equal(before.runtimeRecorded, true); assert.equal(before.checkpointRecorded, false); assert.equal(before.indexStatus, 'ACTIVE');
  writeFileSync(moved, readFileSync(moved, 'utf8') + `\n\n## Review checkpoint\n\n<!-- code-duet-accepted ${messageID} -->\n`);
  assert.equal((await check()).result.checkpointRecorded, true);
  const transition = await f.call(['transition', f.workspace, target, messageID, 'accepted', '--moved-prior-plan', moved, ...args]);
  assert.equal(transition.result.kind, 'transition-prepared', JSON.stringify(transition.result));
  assert.equal(transition.result.taskSent, false);
  assert.equal((await check()).result.correctionCount, 1);
  writeFileSync(f.packet, 'Code Duet packet: ' + JSON.stringify({ planPath: moved, assignmentID: 'new-block', kind: 'initial' }) + '\nFixture body');
  const wrong = await f.call(['submit', f.workspace, target, 'new-block', f.packet, ...args]);
  assert.match(wrong.result.error, /different plan/);
  assert.equal(f.posts(`/api/session/${pair.result.sessionID}/prompt`), 1);
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
  const result = await f.call(f.bindArgs(0));
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
