import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';

async function stopped(t) {
  const f = await fixture(t, undefined, '2.2.0');
  const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: 'offline-http-chat-A' });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'delivered-correction-nine', f.packet, baseline, 'correction');
  const before = f.state().bindings[0];
  await adapter.connectionLost(Object.assign(new Error('Synthetic input followed the bound assignment; no ownership transfer'), {
    diagnostic: { category: 'unknown', stage: 'snapshot', elapsedMs: 49, lastEvent: null, errorName: 'Error' } }));
  const resume = Object.fromEntries(['sessionID', 'assignmentID', 'messageID'].map(key => [key, before[key]]));
  const args = ['resume-watch', f.workspace, f.plan, resume.assignmentID, resume.messageID,
    '--session', resume.sessionID, '--non-git-baseline', baseline, '--timeout-ms', '3000'];
  return Object.assign(f, { client, adapter, resume, args,
    observe: options => adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 3000, resume, ...options }),
    mutate: change => { const state = f.state(); change(state.bindings[0], state); writeFileSync(f.statePath, JSON.stringify(state)); } });
}
function unchanged(f, before, callsFrom) {
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
  assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
  const owners = join(dirname(f.statePath), 'ownership');
  assert.deepEqual(existsSync(owners) ? readdirSync(owners) : [], []);
}

test('explicit CLI resumes the same completed assignment without POST, new binding or counter reset', async t => {
  const f = await stopped(t), saved = f.state(), callsFrom = f.calls.length;
  f.finish(f.resume.sessionID);
  const result = await f.call(f.args);
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.result.kind, 'completed-for-review'); assert.equal(result.result.phase, 'REVIEWING');
  assert.equal(result.result.observationOnly, true); assert.equal(result.result.taskSent, false);
  assert.equal(result.result.correctionCount, 9); assert.equal(result.result.assignmentID, f.resume.assignmentID);
  assert.equal(result.result.messageID, f.resume.messageID);
  assert.deepEqual(f.state().plans, saved.plans); assert.equal(f.state().bindings.length, 1);
  assert.equal(f.state().bindings[0].stopReason, undefined); assert.equal(f.state().bindings[0].diagnostic, undefined);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
  assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
  const reviewed = readFileSync(f.statePath), after = f.calls.length;
  assert.equal((await f.call(f.args)).result.kind, 'rejected'); unchanged(f, reviewed, after);
});

test('resumed active observation owns a lease, leaves the short lock free and waits for actual completion', async t => {
  const f = await stopped(t), callsFrom = f.calls.length;
  let notified, reads = 0;
  const observed = new Promise(resolve => { notified = resolve; });
  f.onRequest = route => {
    if (route.includes('/message?') && ++reads === 2) setTimeout(notified, 25);
  };
  const waiting = f.observe(); await observed;
  assert.equal(f.state().bindings[0].phase, 'EXECUTING'); assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(existsSync(join(dirname(f.statePath), 'state.lock')), false);
  const owners = readdirSync(join(dirname(f.statePath), 'ownership')); assert.equal(owners.length, 1);
  assert.equal(JSON.parse(readFileSync(join(dirname(f.statePath), 'ownership', owners[0]))).operation, 'resume-watch');
  f.finish(f.resume.sessionID);
  assert.equal((await waiting).kind, 'completed-for-review');
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
  assert.equal(f.state().plans[0].correctionCount, 9);
});

test('ordinary wait remains sticky; missing/incorrect explicit selection never clears STOPPED', async t => {
  const f = await stopped(t), before = readFileSync(f.statePath), callsFrom = f.calls.length;
  assert.equal((await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline })).phase, 'STOPPED');
  for (const resume of [null, {}, { ...f.resume, sessionID: 'ses_wrong' },
    { ...f.resume, assignmentID: 'different' }, { ...f.resume, messageID: 'msg_wrong' }]) {
    await assert.rejects(f.observe({ resume }), /Explicit resume|Resume selection/);
  }
  const foreign = helper(f.client, { stateRoot: dirname(f.statePath), chatID: 'different-owner' });
  await assert.rejects(foreign.wait(f.workspace, f.plan, { nonGitBaseline: baseline, resume: f.resume }), /No binding/);
  const noSession = f.args.filter((value, index) => index !== 5 && index !== 6);
  assert.equal((await f.call(noSession)).status, 1);
  assert.equal((await f.call([...f.args, '--correction-count', '0'])).status, 1);
  unchanged(f, before, callsFrom);
});

for (const uncertain of ['create', 'submit', 'reply']) test('uncertain ' + uncertain + ' cannot be recovered by observation', async t => {
  const f = await stopped(t); f.mutate(binding => { binding.uncertain = uncertain; });
  const before = readFileSync(f.statePath), callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /mutation uncertain/); unchanged(f, before, callsFrom);
});

const unsafe = {
  'missing delivered message': f => { f.messages.set(f.resume.sessionID, []); },
  'assignment text mismatch': f => { f.messages.get(f.resume.sessionID)[0].text = 'Unrelated packet'; },
  'another user prompt': f => { f.messages.get(f.resume.sessionID).push({ id: 'msg_other', type: 'user', text: 'Other task' }); },
  'unmatched synthetic input': f => { f.messages.get(f.resume.sessionID).push({ id: 'msg_external', type: 'synthetic', text: 'PRIVATE_RESUME_CANARY', time: { created: Date.now() } }); },
  'changed model': f => { f.sessions.get(f.resume.sessionID).model = { ...model, id: 'other' }; },
  'archived session': f => { f.sessions.get(f.resume.sessionID).time.archived = Date.now(); },
  'stale idle without active execution': f => {
    delete f.active[f.resume.sessionID]; f.sessions.get(f.resume.sessionID).time.idle = 1;
    f.sessions.get(f.resume.sessionID).outcome = 'succeeded';
  },
  'failed execution': f => {
    f.finish(f.resume.sessionID); f.messages.get(f.resume.sessionID).at(-1).outcome = 'failed';
    f.sessions.get(f.resume.sessionID).outcome = 'failed';
  },
  'unfinished terminal tool': f => {
    f.messages.get(f.resume.sessionID).push({ id: 'msg_read', type: 'assistant', model,
      time: { completed: Date.now() }, content: [{ type: 'tool', name: 'read', id: 'tool_unfinished', state: { status: 'running' } }] });
    f.finish(f.resume.sessionID);
  },
  'active project shell at terminal': f => {
    f.finish(f.resume.sessionID); f.shells = [{ id: 'shell_running', status: 'running', time: {} }];
  },
  'foreign checkout executor': f => {
    f.active.ses_foreign = { type: 'running' };
    f.sessions.set('ses_foreign', { id: 'ses_foreign', location: { directory: f.workspace } });
  },
  'event handshake failure': f => { f.eventFault = 'http'; },
  'unknown active status': f => { f.active[f.resume.sessionID] = { type: 'unknown' }; },
  'history HTTP 400': f => { f.rejectRequest = (method, route) => method === 'GET' && route.includes('/message?'); },
};
for (const [name, change] of Object.entries(unsafe)) test('resume refuses ' + name + ' and preserves original stop evidence', async t => {
  const f = await stopped(t); change(f);
  const before = readFileSync(f.statePath), callsFrom = f.calls.length;
  const result = await f.observe();
  assert.equal(result.kind, 'rejected', JSON.stringify(result)); assert.equal(result.phase, 'STOPPED');
  assert.equal(result.stateChange, 'unchanged'); assert.equal(result.taskSent, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RESUME_CANARY')); unchanged(f, before, callsFrom);
});

test('resume restores a correlated pending question without answering or spending a correction', async t => {
  const f = await stopped(t), callsFrom = f.calls.length, now = Date.now();
  f.messages.get(f.resume.sessionID).push({ id: 'msg_question', type: 'assistant', model, time: { created: now }, content: [
    { id: 'tool_question', type: 'tool', name: 'question', state: { status: 'running' } },
  ] });
  f.forms = [{ id: 'frm_resume', sessionID: f.resume.sessionID,
    metadata: { kind: 'question', tool: { messageID: 'msg_question', id: 'tool_question' } },
    fields: [{ key: 'q0', type: 'string', label: 'Fixture choice' }] }];
  const result = await f.observe(); assert.equal(result.kind, 'question'); assert.equal(result.phase, 'WAITING_FOR_ANSWER');
  assert.equal(result.request.id, 'frm_resume'); assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
});

test('a stale pending record is cleared only after verified completed-for-review', async t => {
  const f = await stopped(t);
  f.mutate(binding => { binding.pending = { kind: 'question', id: 'frm_old', fingerprint: '0'.repeat(64) }; });
  f.finish(f.resume.sessionID);
  assert.equal((await f.observe()).kind, 'completed-for-review'); assert.equal(f.state().bindings[0].pending, undefined);
  assert.equal(f.state().plans[0].correctionCount, 9);
});

test('two resumptions cannot own the same stopped assignment concurrently', async t => {
  const f = await stopped(t); f.finish(f.resume.sessionID);
  let release, notify;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { notify = resolve; });
  let first = true;
  f.onRequest = async route => { if (route.includes('/message?') && first) { first = false; notify(); await held; } };
  const waiting = f.observe(); await entered;
  try { await assert.rejects(f.observe(), /ownership locked/); }
  finally { release(); }
  assert.equal((await waiting).kind, 'completed-for-review'); assert.equal(f.state().plans[0].correctionCount, 9);
});

test('out-of-band counter drift is refused and never reset to the old count', async t => {
  const f = await stopped(t); f.finish(f.resume.sessionID);
  let changed;
  f.onRequest = route => { if (route.includes('/message?') && !changed) {
    f.mutate((binding, state) => { state.plans[0].correctionCount = 10; }); changed = readFileSync(f.statePath);
  } };
  const result = await f.observe(); assert.equal(result.kind, 'rejected'); assert.match(result.error, /correction count changed/);
  assert.deepEqual(readFileSync(f.statePath), changed); assert.equal(f.state().plans[0].correctionCount, 10);
});

test('resumption at correction 20 may review the result without reserving cycle 21', async t => {
  const f = await stopped(t); f.mutate((binding, state) => { state.plans[0].correctionCount = 20; });
  f.finish(f.resume.sessionID);
  const result = await f.observe(); assert.equal(result.kind, 'completed-for-review'); assert.equal(result.correctionCount, 20);
  assert.equal(f.state().plans[0].correctionCount, 20); assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
});

test('a stream gap after successful resumption records STOPPED again without duplicate delivery', async t => {
  const f = await stopped(t);
  let notify, reads = 0;
  const observed = new Promise(resolve => { notify = resolve; });
  f.onRequest = route => { if (route.includes('/message?') && ++reads === 2) setTimeout(notify, 25); };
  const waiting = f.observe(); await observed; assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  for (const stream of f.streams) stream.end();
  const result = await waiting; assert.equal(result.phase, 'STOPPED'); assert.equal(result.diagnostic.category, 'event-eof');
  assert.equal(f.state().plans[0].correctionCount, 9); assert.equal(result.assignmentID, f.resume.assignmentID);
  assert.equal(result.messageID, f.resume.messageID); assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
});

test('the P4 native instruction pattern resumes without broad synthetic-input exceptions', async t => {
  const f = await stopped(t), now = Date.now(), path = join(f.workspace, 'nested', 'AGENTS.md');
  f.messages.get(f.resume.sessionID).push(
    { id: 'msg_read', type: 'assistant', model, time: { created: now - 3, completed: now }, content: [
      { id: 'tool_read', type: 'tool', name: 'read', state: { status: 'completed', input: { path: join(f.workspace, 'nested', 'file') } },
        time: { ran: now - 2, completed: now } },
    ] },
    { id: 'msg_native', type: 'synthetic', metadata: { instruction: { paths: [path] } },
      text: 'Instructions from: ' + path + '\nPRIVATE_RESUME_CANARY', time: { created: now - 1 } });
  f.finish(f.resume.sessionID); const result = await f.observe();
  assert.equal(result.kind, 'completed-for-review'); assert.equal(result.correctionCount, 9);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RESUME_CANARY'));
  assert.ok(!readFileSync(f.statePath, 'utf8').includes('PRIVATE_RESUME_CANARY'));
});

test('an existing writer lock is not removed by resume-watch', async t => {
  const f = await stopped(t), lock = join(dirname(f.statePath), 'state.lock');
  writeFileSync(lock, 'FOREIGN_WRITER'); const before = readFileSync(f.statePath), callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /state locked/); assert.equal(readFileSync(lock, 'utf8'), 'FOREIGN_WRITER');
  unchanged(f, before, callsFrom);
});

test('prepared next assignment and changed engine identity cannot be resumed', async t => {
  const f = await stopped(t);
  f.mutate(binding => { binding.nextAssignment = 'correction'; });
  let before = readFileSync(f.statePath), callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /Resume selection/); unchanged(f, before, callsFrom);
  f.mutate(binding => { delete binding.nextAssignment; binding.engineID = 'changed-engine'; });
  before = readFileSync(f.statePath); callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /Engine changed/); unchanged(f, before, callsFrom);
});

test('a prior edit error does not prevent active observation, but never grants completed-for-review', async t => {
  const f = await stopped(t), callsFrom = f.calls.length;
  f.messages.get(f.resume.sessionID).push({ id: 'msg_failed_edit', type: 'assistant', model,
    time: { created: Date.now(), completed: Date.now() }, content: [
      { id: 'tool_failed_edit', type: 'tool', name: 'edit', state: { status: 'error' }, time: { completed: Date.now() } },
    ] });
  let notify, reads = 0;
  const observed = new Promise(resolve => { notify = resolve; });
  f.onRequest = route => { if (route.includes('/message?') && ++reads === 2) setTimeout(notify, 25); };
  const waiting = f.observe(); await observed;
  assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  f.finish(f.resume.sessionID);
  const result = await waiting; assert.equal(result.kind, 'failed'); assert.equal(result.phase, 'STOPPED');
  assert.equal(result.correctionCount, 9); assert.equal(result.taskSent, false);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
});

test('a hard assistant failure cannot masquerade as an observable isolated tool error', async t => {
  const f = await stopped(t), before = readFileSync(f.statePath), callsFrom = f.calls.length;
  f.messages.get(f.resume.sessionID).push({ id: 'msg_failed_step', type: 'assistant', model,
    finish: 'error', content: [{ id: 'tool_failed', type: 'tool', name: 'edit', state: { status: 'error' } }] });
  const result = await f.observe(); assert.equal(result.kind, 'rejected'); unchanged(f, before, callsFrom);
});
