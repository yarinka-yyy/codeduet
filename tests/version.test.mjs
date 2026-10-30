import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect, ENGINE_VERSIONS, validateDiagnostic } from '../helper/connection.mjs';
import { helper, preflight } from '../helper/binding.mjs';

const registrationPath = f => join(f.home, '.local/state/opencode/service.json');
const preflightArgs = f => ['preflight', f.workspace, f.plan, '--correction-count', '7', '--non-git-baseline', baseline];

test('supported engine releases are unique and limited to six', () => {
  assert.ok(ENGINE_VERSIONS.length > 0 && ENGINE_VERSIONS.length <= 6);
  assert.equal(new Set(ENGINE_VERSIONS).size, ENGINE_VERSIONS.length);
});

for (const version of ['2.1.4', '2.2.0', '2.2.1', '2.2.2', '2.2.3']) test('validated engine ' + version + ' preserves adoption, SSE completion and correction history', async t => {
  const f = await fixture(t, undefined, version), sessionID = 'ses_versionfixture';
  f.sessions.set(sessionID, { id: sessionID, title: 'Dedicated version fixture',
    location: { directory: f.workspace }, model: { providerID: model.providerID, id: model.id, variant: 'high' }, time: {} });
  const created = Date.now();
  f.messages.set(sessionID, [
    { id: 'msg_prior_user', type: 'user', text: 'Previously completed fixture task' },
    ...Array.from({ length: 105 }, (_, index) => ({ id: 'msg_prior_input' + index,
      type: 'synthetic', text: 'Prior native input', time: { created } })),
    { id: 'msg_prior_compaction', type: 'compaction', status: 'completed', reason: 'auto',
      model, summary: 'Prior fixture summary', time: { created } },
  ]);
  f.finish(sessionID);
  const client = await connect({ registrationPath: registrationPath(f) });
  assert.equal(client.version, version); assert.equal(client.bootstrap.attempts, 1);
  const options = { stateRoot: dirname(f.statePath), chatID: 'version-fixture-chat' };
  const args = { ...options, workspace: f.workspace, planPath: f.plan, sessionID, correctionCount: 7, nonGitBaseline: baseline };
  const snapshot = await preflight(client, args);
  assert.equal(snapshot.status, 'pass', JSON.stringify(snapshot));
  assert.equal(snapshot.connection.version, version); assert.equal(snapshot.nextCommand.command, 'adopt');
  assert.equal(existsSync(f.statePath), false); assert.ok(f.calls.every(call => call.method === 'GET'));
  const adapter = helper(client, options);
  assert.equal((await adapter.adopt(f.workspace, f.plan, sessionID, baseline, 7)).phase, 'PREPARING');
  for (const kind of ['initial', 'correction']) {
    if (kind === 'correction') assert.equal((await adapter.next(f.workspace, f.plan, kind, baseline)).phase, 'PREPARING');
    const result = await adapter.submit(f.workspace, f.plan, 'version-' + kind, f.packet, baseline, kind);
    assert.equal(result.phase, 'EXECUTING');
    f.finish(sessionID);
    assert.equal((await adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 3000 })).phase, 'REVIEWING');
  }
  const finished = await adapter.finish(f.workspace, f.plan, baseline);
  assert.equal(finished.phase, 'FINISHED'); assert.equal(finished.correctionCount, 8);
  assert.equal(f.state().bindings[0].adoption.variant, 'high');
  assert.equal(f.posts('/api/session'), 0); assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 2);
  assert.equal(f.streamOpens, 2);
  const cursorPages = f.calls.filter(call => call.route.includes('/message?') && call.route.includes('cursor='));
  assert.ok(cursorPages.length > 0);
  assert.ok(cursorPages.every(call => !new URL(call.route, 'http://localhost').searchParams.has('order')));
});

test('unvalidated version is a one-attempt read-only preflight blocker with actionable version fields', async t => {
  const f = await fixture(t, undefined, '2.3.0');
  const result = await f.call(preflightArgs(f));
  assert.equal(result.status, 1); assert.equal(result.result.status, 'blocked');
  const diagnostic = result.result.connection.diagnostic;
  assert.equal(diagnostic.category, 'engine-version');
  assert.deepEqual(diagnostic.expectedVersions, ['2.1.4', '2.2.0', '2.2.1', '2.2.2', '2.2.3']);
  assert.equal(diagnostic.observedVersion, '2.3.0'); assert.equal(diagnostic.versionSource, 'registration');
  assert.equal(result.result.connection.attempts, 1); assert.equal(result.result.connection.retried, false);
  const check = result.result.checks.find(item => item.name === 'connection');
  assert.deepEqual(check.diagnostic, diagnostic); assert.match(check.reason, /expected 2\.1\.4 or 2\.2\.0 or 2\.2\.1 or 2\.2\.2 or 2\.2\.3, observed 2\.3\.0/);
  assert.match(result.result.nextStep, /revalidate API compatibility/);
  assert.equal(result.result.nextCommand, null); assert.equal(result.result.taskSent, false);
  assert.equal(result.result.stateChange, 'unchanged'); assert.equal(existsSync(dirname(f.statePath)), false);
  assert.equal(f.calls.length, 0);
});

test('registration and server version must agree even when both releases are supported', async t => {
  const f = await fixture(t, undefined, '2.2.0'), calls = [];
  await assert.rejects(connect({ registrationPath: registrationPath(f), fetchImpl: async url => {
    calls.push(new URL(url).pathname);
    return Response.json(new URL(url).pathname === '/api/info' ? { version: '2.1.4' } : { data: [model] });
  } }), error => {
    assert.deepEqual(error.diagnostic.expectedVersions, ['2.2.0']);
    assert.equal(error.diagnostic.observedVersion, '2.1.4'); assert.equal(error.diagnostic.versionSource, 'server-info');
    assert.equal(error.bootstrap.attempts, 1); return true;
  });
  assert.deepEqual(calls.sort(), ['/api/info', '/api/model']); assert.equal(existsSync(f.statePath), false);
});

test('untrusted registration version values are not reflected in diagnostics', async t => {
  for (const version of ['PRIVATE_VERSION_CANARY', '2.2.0-PRIVATE_VERSION_CANARY', { token: 'PRIVATE_VERSION_CANARY' }, null]) {
    const f = await fixture(t, undefined, version);
    const result = await f.call(preflightArgs(f));
    assert.equal(result.status, 1); assert.equal(result.result.connection.diagnostic.observedVersion, 'unknown');
    assert.ok(!JSON.stringify(result.result).includes('PRIVATE_VERSION_CANARY'));
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.statePath), false);
  }
});

test('version diagnostics reject private strings and preserve existing stopped state without recovery', async t => {
  const valid = { category: 'engine-version', stage: 'connection', elapsedMs: 0, lastEvent: null,
    expectedVersions: [...ENGINE_VERSIONS], observedVersion: '2.3.0', versionSource: 'registration' };
  assert.equal(validateDiagnostic(valid), valid);
  for (const change of [{ observedVersion: 'PRIVATE_DIAGNOSTIC' }, { expectedVersions: ['PRIVATE_DIAGNOSTIC'] },
    { versionSource: 'PRIVATE_DIAGNOSTIC' }, { category: 'unknown' }, { rawBody: 'PRIVATE_DIAGNOSTIC' }]) {
    assert.throws(() => validateDiagnostic({ ...valid, ...change }), /Invalid diagnostic/);
  }
  const f = await fixture(t, undefined, '2.2.0'), client = await connect({ registrationPath: registrationPath(f) });
  const options = { stateRoot: dirname(f.statePath), chatID: 'version-stopped-fixture' }, adapter = helper(client, options);
  await adapter.bind(f.workspace, f.plan, baseline, 7);
  await adapter.submit(f.workspace, f.plan, 'version-active', f.packet, baseline);
  const lost = await adapter.connectionLost(Object.assign(new Error('Unsupported engine version; revalidate API'), { diagnostic: valid }));
  assert.equal(lost.phase, 'STOPPED'); assert.deepEqual(f.state().bindings[0].diagnostic, valid);
  const before = readFileSync(f.statePath);
  const snapshot = await preflight(null, { ...options, workspace: f.workspace, planPath: f.plan,
    correctionCount: 7, nonGitBaseline: baseline,
    connectionError: Object.assign(new Error('Unsupported engine version; revalidate API'), { diagnostic: valid }) });
  assert.equal(snapshot.status, 'blocked'); assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(f.posts('/api/session/' + f.state().bindings[0].sessionID + '/prompt'), 1);
});
