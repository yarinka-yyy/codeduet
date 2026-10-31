import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fixture, baseline } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper, preflight } from '../helper/binding.mjs';

const token = '6967c306-e760-4ecc-9339-bff4f7a4cc5c';

async function setup(t) {
  const f = await fixture(t), root = dirname(f.statePath);
  const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const old = helper(client, { stateRoot: root, chatID: 'old-chat' });
  await old.bind(f.workspace, f.plan, baseline, 8);
  await old.submit(f.workspace, f.plan, 'correction-nine', f.packet, baseline, 'correction');
  const binding = f.state().bindings[0];
  const owners = join(root, 'ownership'); mkdirSync(owners, { recursive: true });
  const lease = join(owners, 'owner-' + token + '.lock');
  writeFileSync(lease, JSON.stringify({ schema: 1, token, codexChat: binding.codexChat,
    workspace: binding.workspace, checkout: binding.checkout, sessionID: binding.sessionID,
    assignmentID: binding.assignmentID, operation: 'resume-watch' }));
  return { f, root, binding, lease, client, adapter: helper(client, { stateRoot: root, chatID: 'new-chat' }) };
}

test('preflight identifies the exact legacy candidate without changing state', async t => {
  const { f, root, binding, lease, client } = await setup(t);
  const before = readFileSync(f.statePath), leaseBefore = readFileSync(lease);
  const result = await preflight(client, { stateRoot: root, chatID: 'new-chat', workspace: f.workspace,
    planPath: f.plan, correctionCount: 9, nonGitBaseline: baseline });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.legacyCandidates, [{ token, workspace: binding.workspace, planPath: binding.planPath,
    sessionID: binding.sessionID, assignmentID: binding.assignmentID }]);
  assert.deepEqual(readFileSync(f.statePath), before); assert.deepEqual(readFileSync(lease), leaseBefore);
});

test('legacy retirement preserves count, archives evidence and allows another chat after executor ends', async t => {
  const { f, root, binding, lease, adapter } = await setup(t);
  delete f.active[binding.sessionID];
  const priorPosts = f.calls.filter(call => call.method === 'POST').length;
  const result = await adapter.retireLegacy(f.workspace, f.plan, token);
  assert.equal(result.kind, 'legacy-retired'); assert.equal(result.correctionCount, 9);
  assert.equal(result.taskAccepted, false); assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.state().bindings.length, 0); assert.equal(existsSync(lease), false);
  const archive = JSON.parse(readFileSync(join(root, 'ownership-history', token + '.retired.json')));
  assert.equal(archive.binding.assignmentID, binding.assignmentID);
  assert.ok(existsSync(join(root, 'ownership-history', token + '.retired.lock')));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, priorPosts);
  const replacement = await adapter.bind(f.workspace, f.plan, baseline, 9);
  assert.equal(replacement.phase, 'PREPARING'); assert.notEqual(replacement.sessionID, binding.sessionID);
});

test('legacy retirement refuses a running executor and preserves its binding and lease', async t => {
  const { f, lease, adapter } = await setup(t);
  const state = readFileSync(f.statePath), before = readFileSync(lease);
  await assert.rejects(adapter.retireLegacy(f.workspace, f.plan, token), /Active executor/);
  assert.deepEqual(readFileSync(f.statePath), state); assert.deepEqual(readFileSync(lease), before);
});

test('legacy retirement resumes after the state save but before lease archive', async t => {
  const { f, root, binding, lease, adapter } = await setup(t);
  delete f.active[binding.sessionID];
  const owner = { ...JSON.parse(readFileSync(lease)), path: lease };
  const history = join(root, 'ownership-history'); mkdirSync(history);
  writeFileSync(join(history, token + '.retired.json'), JSON.stringify({ schema: 1,
    kind: 'abandoned-legacy-observation', owner, binding, correctionCount: 9 }));
  const state = f.state(); state.bindings = []; writeFileSync(f.statePath, JSON.stringify(state));
  assert.equal((await adapter.retireLegacy(f.workspace, f.plan, token)).kind, 'legacy-retired');
  assert.equal(f.state().plans[0].correctionCount, 9); assert.equal(existsSync(lease), false);
});

test('legacy retirement refuses running project shells without changing the store', async t => {
  const { f, binding, lease, adapter } = await setup(t);
  delete f.active[binding.sessionID];
  f.shells = [{ status: 'running', time: { started: Date.now() } }];
  const state = readFileSync(f.statePath), before = readFileSync(lease);
  await assert.rejects(adapter.retireLegacy(f.workspace, f.plan, token), /shell is running or unknown/);
  assert.deepEqual(readFileSync(f.statePath), state); assert.deepEqual(readFileSync(lease), before);
});

test('an already running observer cannot restore a retired binding', async t => {
  const { f, root, binding, lease, adapter } = await setup(t);
  unlinkSync(lease);
  const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const old = helper(client, { stateRoot: root, chatID: 'old-chat' });
  const waiting = old.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 5000 });
  waiting.catch(() => {});
  const deadline = Date.now() + 3000;
  while (!f.streamOpens && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(f.streamOpens);
  const oldPath = join(root, 'ownership', readdirSync(join(root, 'ownership'))[0]);
  const original = JSON.parse(readFileSync(oldPath));
  const legacy = { schema: 1, token: original.token, codexChat: original.codexChat,
    workspace: original.workspace, checkout: original.checkout, sessionID: original.sessionID,
    assignmentID: original.assignmentID, operation: original.operation };
  writeFileSync(oldPath, JSON.stringify(legacy));
  delete f.active[binding.sessionID];
  await adapter.retireLegacy(f.workspace, f.plan, original.token);
  f.finish(binding.sessionID);
  await waiting;
  assert.equal(f.state().bindings.length, 0); assert.equal(f.state().plans[0].correctionCount, 9);
});
