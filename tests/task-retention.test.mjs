import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fixture, baseline } from './http-fixture.mjs';
import { maintainTasks, observationContext } from '../helper/binding.mjs';

const period = 30 * 24 * 60 * 60 * 1000;
async function setup(t, phase = null) {
  const f = await fixture(t), root = dirname(f.statePath), other = join(f.workspace, 'plans', '002-test.md');
  writeFileSync(other, baseline);
  const ctx = observationContext(f.workspace, f.plan);
  const plans = [{ workspace: ctx.workspace, planPath: ctx.planPath, correctionCount: 9 },
    { workspace: ctx.workspace, planPath: other, correctionCount: 0 }];
  const bindings = phase ? [{ codexChat: 'fixture', ...ctx, engineID: 'fixture-engine',
    sessionID: 'ses_test', phase, ...(phase === 'EXECUTING' ?
      { assignmentID: 'assignment', messageID: 'msg_test', submittedAt: 1 } : {}) }] : [];
  mkdirSync(root, { recursive: true }); writeFileSync(f.statePath, JSON.stringify({ schema: 1, bindings, plans }));
  const run = (path, now) => maintainTasks(f.workspace, path, { stateRoot: root, now });
  const ledger = () => JSON.parse(readFileSync(join(root, 'task-lifecycle.json'), 'utf8'));
  return { f, root, other, run, ledger };
}

test('archives after 30 days and restores the exact correction count on use', async t => {
  const { f, other, run, ledger } = await setup(t, 'FINISHED');
  run(f.plan, 1);
  assert.equal(run(other, period + 1).archived, 1);
  assert.equal(f.state().plans.some(plan => plan.planPath === f.plan), false);
  assert.equal(f.state().bindings.length, 0);
  assert.equal(ledger().entries.find(entry => entry.planPath === f.plan).plan.correctionCount, 9);
  assert.equal(run(f.plan, period + 2).restored, 1);
  assert.equal(f.state().plans.find(plan => plan.planPath === f.plan).correctionCount, 9);
  assert.equal(ledger().entries.find(entry => entry.planPath === f.plan).lastUsed, period + 2);
});

test('removes an untouched archive after another 30 days without deleting project files', async t => {
  const { f, other, run, ledger } = await setup(t);
  const original = readFileSync(f.plan);
  run(f.plan, 1); run(other, period + 1);
  assert.equal(run(other, 2 * period + 1).deleted, 1);
  assert.equal(ledger().entries.some(entry => entry.planPath === f.plan), false);
  assert.equal(f.state().plans.some(plan => plan.planPath === f.plan), false);
  assert.deepEqual(readFileSync(f.plan), original);
});

test('applies both elapsed periods at the next invocation', async t => {
  const { f, other, run, ledger } = await setup(t);
  run(f.plan, 1);
  const result = run(other, 2 * period + 1);
  assert.equal(result.archived, 1); assert.equal(result.deleted, 1);
  assert.equal(ledger().entries.some(entry => entry.planPath === f.plan), false);
});

test('observed changes reset inactivity when their time is unknown', async t => {
  const { f, other, run } = await setup(t, 'FINISHED');
  run(f.plan, 1);
  const state = f.state(); state.plans[0].correctionCount = 10;
  writeFileSync(f.statePath, JSON.stringify(state));
  assert.equal(run(other, period + 1).archived, 0);
  assert.equal(f.state().plans[0].correctionCount, 10);
});

test('does not archive a running task regardless of age', async t => {
  const { f, other, run } = await setup(t, 'EXECUTING');
  run(f.plan, 1); assert.equal(run(other, period * 3).archived, 0);
  assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  assert.equal(f.state().plans.find(plan => plan.planPath === f.plan).correctionCount, 9);
});

test('a previously observed owner gets a new inactive period when released', async t => {
  const { f, root, other, run } = await setup(t, 'FINISHED');
  const observers = join(root, 'observers'); mkdirSync(observers);
  const slot = join(observers, 'external-fixture'); writeFileSync(slot, '{}');
  run(f.plan, 1); run(other, period * 3);
  unlinkSync(slot);
  assert.equal(run(other, period * 3 + 1).archived, 0);
  assert.equal(f.state().plans.find(plan => plan.planPath === f.plan).correctionCount, 9);
});

test('a restored task receives a new full 30-day active period', async t => {
  const { f, other, run } = await setup(t);
  run(f.plan, 1); run(other, period + 1); run(f.plan, period + 2);
  assert.equal(run(other, 2 * period + 1).archived, 0);
  assert.equal(f.state().plans.find(plan => plan.planPath === f.plan).correctionCount, 9);
  assert.equal(run(other, 2 * period + 2).archived, 1);
});

test('unknown activity and retained ownership prevent automatic archive', async t => {
  const { f, root, other, run } = await setup(t, 'FINISHED');
  run(f.plan, 1);
  const ownership = join(root, 'ownership'); mkdirSync(ownership);
  writeFileSync(join(ownership, 'unexpected'), 'unknown');
  assert.throws(() => run(other, period + 1), /ownership is invalid/);
  assert.equal(f.state().plans.find(plan => plan.planPath === f.plan).correctionCount, 9);
});

test('reconciles an interrupted archive and interrupted restore', async t => {
  const { f, root, other, run, ledger } = await setup(t);
  run(f.plan, 1); run(other, period + 1);
  const path = join(root, 'task-lifecycle.json'), archived = ledger();
  const entry = archived.entries.find(value => value.planPath === f.plan);
  const state = f.state(); state.plans.push(entry.plan); writeFileSync(f.statePath, JSON.stringify(state));
  run(other, period + 2);
  assert.equal(f.state().plans.some(plan => plan.planPath === f.plan), false);
  const pending = ledger(); const restored = pending.entries.find(value => value.planPath === f.plan);
  restored.archivedAt = null; restored.lastUsed = period + 3; restored.pendingRestore = true;
  writeFileSync(path, JSON.stringify(pending)); run(other, period + 3);
  assert.equal(f.state().plans.find(plan => plan.planPath === f.plan).correctionCount, 9);
});

test('CLI maintenance is local and does not contact the engine', async t => {
  const { f } = await setup(t);
  const calls = f.calls.length;
  const result = await f.call(['task-maintenance', f.workspace, f.plan]);
  assert.equal(result.status, 0); assert.equal(result.result.kind, 'task-maintenance');
  assert.equal(result.result.taskSent, false); assert.equal(f.calls.length, calls);
});
