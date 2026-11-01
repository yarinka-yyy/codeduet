import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture } from './http-fixture.mjs';
import { readState } from '../helper/binding.mjs';

test('legacy count 21 remains readable, then a new selection preserves it and keeps the binding', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.bindArgs(20))).status, 0);
  const old = f.state(); old.plans[0].correctionCount = 21;
  writeFileSync(f.statePath, JSON.stringify(old));
  assert.equal(readState(f.statePath).plans[0].correctionCount, 21);
  assert.equal((await f.call(['task-maintenance', f.workspace, f.plan])).status, 0);
  assert.equal(f.state().plans[0].correctionCount, 21);
  const calls = f.calls.length;
  const started = await f.call(['start-cycle', f.workspace, f.plan]);
  assert.equal(started.status, 0); assert.equal(started.result.previousCount, 21);
  assert.equal(started.result.correctionCount, 0); assert.equal(started.result.taskSent, false);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.state().bindings, old.bindings);
  assert.equal(f.state().plans[0].correctionCount, 0);
  const history = join(dirname(f.statePath), 'cycle-history');
  assert.equal(JSON.parse(readFileSync(join(history, readdirSync(history)[0]))).previousCount, 21);
  assert.equal((await f.call(f.submitArgs)).result.correctionCount, 1);
});

test('limit stops all further assignments until a new explicit selection', async t => {
  const f = await fixture(t); assert.equal((await f.call(f.bindArgs(20))).status, 0);
  const before = readFileSync(f.statePath);
  for (const kind of ['correction', 'block']) {
    const args = [...f.submitArgs]; args[6] = kind;
    assert.equal((await f.call(args)).result.kind, 'correction-limit');
  }
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.ok(!f.calls.some(call => call.route.endsWith('/prompt')));
  assert.equal((await f.call(['start-cycle', f.workspace, f.plan])).result.previousCount, 20);
  assert.equal((await f.call(f.submitArgs)).result.correctionCount, 1);
});

test('a running, uncertain, or observed assignment cannot have its count reset', async t => {
  const f = await fixture(t); await f.call(f.bindArgs(19));
  assert.equal((await f.call(f.submitArgs)).result.correctionCount, 20);
  const before = readFileSync(f.statePath);
  assert.equal((await f.call(['start-cycle', f.workspace, f.plan])).status, 1);
  assert.deepEqual(readFileSync(f.statePath), before);
  const state = f.state(); state.bindings[0].phase = 'STOPPED'; state.bindings[0].uncertain = 'submit';
  writeFileSync(f.statePath, JSON.stringify(state));
  assert.equal((await f.call(['start-cycle', f.workspace, f.plan])).status, 1);
  state.bindings[0].phase = 'PREPARING'; delete state.bindings[0].uncertain;
  writeFileSync(f.statePath, JSON.stringify(state));
  const active = join(dirname(f.statePath), 'observers', 'another-chat', 'active');
  mkdirSync(dirname(active), { recursive: true }); writeFileSync(active, '{}');
  assert.equal((await f.call(['start-cycle', f.workspace, f.plan])).status, 1);
  assert.equal(f.state().plans[0].correctionCount, 20);
});
