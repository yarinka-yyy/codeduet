import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, baseline, model } from './http-fixture.mjs';

async function stopped(t, { uncertain = false } = {}) {
  const f = await fixture(t, undefined, '2.2.5');
  assert.equal((await f.call(f.bindArgs(0))).status, 0);
  const sessionID = f.state().bindings[0].sessionID;
  f.fault = uncertain ? 'drop' : null;
  assert.equal((await f.call(['submit', f.workspace, f.plan, 'old-task', f.packet, '--non-git-baseline', baseline])).status,
    uncertain ? 1 : 0);
  f.fault = null;
  const session = f.sessions.get(sessionID);
  if (!uncertain) {
    const started = Date.now();
    f.messages.get(sessionID).push({ id: 'msg_failedTool', type: 'assistant', model,
      time: { created: started, completed: started }, content: [{ type: 'tool', id: 'call_shell', name: 'shell',
        time: { ran: started, completed: started }, state: { status: 'error', input: { command: 'build' },
          error: { type: 'unknown', message: 'PRIVATE_TEST_OUTPUT' } } },
      { type: 'tool', id: 'call_search', name: 'shell', time: { ran: started, completed: started }, state: { status: 'completed',
        input: { command: "rg -n 'func Spawn|ID:' task.go" }, metadata: { status: 'completed', exit: 0 } } }] });
    f.finish(sessionID);
    const waited = await f.call(['wait', f.workspace, f.plan, '--non-git-baseline', baseline, '--timeout-ms', '3000']);
    assert.equal(waited.result.phase, 'STOPPED', JSON.stringify(waited));
    assert.equal(waited.result.exchangeFailure?.toolID, 'call_shell');
  }
  const binding = f.state().bindings[0];
  const args = ['close-assignment', f.workspace, f.plan, binding.assignmentID, binding.messageID, '--session', sessionID];
  return Object.assign(f, { binding, session, args });
}

test('close without acceptance retains evidence, then admits exactly one separately submitted correction', async t => {
  const f = await stopped(t);
  const { binding, session } = f, { sessionID } = binding, records = f.messages.get(sessionID);
  const idle = session.time.idle;
  const prior = { ...session.model, variant: 'default' };
  records.push({ id: 'msg_switch', type: 'model-switched', model: session.model, previous: prior, time: { created: idle + 1 } },
    { id: 'msg_compact', type: 'compaction', status: 'completed', reason: 'manual', model: session.model, time: { created: idle + 2 } },
    { id: 'msg_maintenanceIdle', type: 'idle', outcome: 'succeeded', time: { created: idle + 3 } });
  session.time.idle = idle + 3;
  const originalHistory = structuredClone(records), calls = f.calls.length;
  const closed = await f.call(f.args);
  assert.equal(closed.status, 0, JSON.stringify(closed));
  assert.equal(closed.result.kind, 'closed-without-acceptance');
  assert.equal(closed.result.reviewAllowed, false);
  assert.equal(closed.result.correctionCount, 0);
  assert.equal(closed.result.stopReason, binding.stopReason);
  assert.deepEqual(closed.result.diagnostic, binding.diagnostic);
  assert.deepEqual(f.messages.get(sessionID), originalHistory);
  assert.ok(f.calls.slice(calls).every(call => call.method === 'GET'));
  const state = readFileSync(f.statePath);
  assert.deepEqual((await f.call(f.args)).result, closed.result);
  assert.deepEqual(readFileSync(f.statePath), state);
  assert.equal((await f.call(['preflight', f.workspace, f.plan, '--non-git-baseline', baseline])).status, 0);
  const correction = ['submit', f.workspace, f.plan, 'playwright-new', f.packet, '--kind', 'correction', '--non-git-baseline', baseline];
  records.push({ id: 'msg_manualPrompt', type: 'user' });
  assert.equal((await f.call(correction)).status, 1);
  assert.equal(f.posts(`/api/session/${sessionID}/prompt`), 1);
  assert.deepEqual(readFileSync(f.statePath), state);
  records.pop();
  assert.equal((await f.call(correction)).result.kind, 'admitted');
  assert.equal((await f.call(correction)).status, 1);
  assert.equal(f.posts(`/api/session/${sessionID}/prompt`), 2);
  assert.equal(f.state().bindings[0].sessionID, sessionID);
  assert.equal(f.state().plans[0].correctionCount, 1);
  assert.deepEqual((await f.call(f.args)).result, closed.result);
});

for (const scenario of ['active', 'pending question', 'running shell', 'uncertain delivery', 'wrong assignment', 'new user input']) {
  test('close refuses ' + scenario + ' without changing saved state or posting', async t => {
    const f = await stopped(t, { uncertain: scenario === 'uncertain delivery' });
    const { sessionID } = f.binding;
    if (scenario === 'active') f.active[sessionID] = { type: 'running' };
    if (scenario === 'pending question') f.forms = [{ sessionID, id: 'frm_pending' }];
    if (scenario === 'running shell') f.shells = [{ id: 'sh_running', status: 'running' }];
    if (scenario === 'wrong assignment') f.args[3] = 'other-assignment';
    if (scenario === 'new user input') f.messages.get(sessionID).push({ id: 'msg_newUser', type: 'user' });
    const state = readFileSync(f.statePath), calls = f.calls.length;
    const result = await f.call(f.args);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.notEqual(result.result.kind, 'closed-without-acceptance');
    assert.deepEqual(readFileSync(f.statePath), state);
    assert.ok(f.calls.slice(calls).every(call => call.method === 'GET'));
  });
}
