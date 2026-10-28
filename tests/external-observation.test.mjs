import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { observer } from '../helper/observer.mjs';
import { selectExternal, externalOutcome } from '../helper/external-observation.mjs';
import { inspectMessages } from '../helper/interaction.mjs';

const chatID = '00000000-0000-4000-8000-000000000020';
const sessionID = 'ses_manual', messageID = 'msg_manual';
async function setup(t) {
  let dispose;
  const f = await fixture({ after: fn => { dispose = fn; } }, fileURLToPath(new URL('../helper/observer.mjs', import.meta.url)), '2.2.0'), stateRoot = dirname(f.statePath);
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const client = await connectEngine(), adapter = helper(client, { stateRoot, chatID: 'old-owner' });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'old-correction-nine', f.packet, baseline, 'correction');
  const state = f.state(), old = state.bindings[0];
  delete f.active[old.sessionID]; old.phase = 'STOPPED'; old.uncertain = 'submit';
  writeFileSync(f.statePath, JSON.stringify(state));
  const token = '00000000-0000-4000-8000-000000000009';
  const lease = join(stateRoot, 'ownership', 'owner-' + token + '.lock');
  mkdirSync(dirname(lease), { recursive: true });
  writeFileSync(lease, JSON.stringify({ schema: 1, token, codexChat: old.codexChat, workspace: old.workspace,
    checkout: old.checkout, sessionID: old.sessionID, assignmentID: old.assignmentID, operation: 'resume-watch' }));
  const session = { id: sessionID, location: { directory: f.workspace }, model: { providerID: model.providerID, id: model.id, variant: 'high' }, time: {} };
  f.sessions.set(sessionID, session);
  f.messages.set(sessionID, [{ id: messageID, type: 'user', text: 'Implement ' + basename(f.plan), time: { created: Date.now() } }]);
  f.active[sessionID] = { type: 'running' };
  const before = readFileSync(f.statePath), leaseBefore = readFileSync(lease), from = f.calls.length, sent = [];
  let running;
  function make(receivingChat = chatID) {
    const o = observer({ stateRoot, chatID: receivingChat, connectEngine,
      checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
      deliver: async pin => { sent.push(pin); return { status: 'sent', exitCode: 0 }; },
      launch: async id => { running = o.worker(id); } });
    return o;
  }
  const o = make();
  t.after(async () => {
    try {
      if (o.status().id) await o.cancel(o.status().id); await running;
      assert.deepEqual(readFileSync(f.statePath), before);
      assert.deepEqual(readFileSync(lease), leaseBefore);
      assert.ok(f.calls.slice(from).every(call => call.method === 'GET'), 'External observation mutated engine');
    } finally { await dispose(); }
  });
  return Object.assign(f, { stateRoot, client, o, session, sent, make, end: () => running,
    select: () => selectExternal(client, stateRoot, f.workspace, f.plan, sessionID, messageID),
    arm: () => o.arm(f.workspace, f.plan, { codexExe: process.execPath, sessionID, messageID, timeoutMs: 10000 }) });
}

test('manual active assignment observes, wakes and consumes without touching old count9/uncertainty/legacy lease', async t => {
  const f = await setup(t);
  const inspected = await f.o.inspectExternal(f.workspace, f.plan, sessionID);
  assert.equal(inspected.messageID, messageID); assert.equal(inspected.correctionCount, 9);
  const armed = await f.arm(); assert.equal(armed.kind, 'observer-armed'); assert.equal(armed.ready, true);
  f.emit('tool.success', sessionID); f.emit('execution.succeeded', 'ses_other');
  await new Promise(done => setTimeout(done, 70)); assert.equal(f.sent.length, 0);
  f.finish(sessionID); await f.end(); assert.equal(f.sent.length, 1);
  const result = await f.o.consume(armed.id);
  assert.equal(result.kind, 'external-completed'); assert.equal(result.ownershipTransferred, false);
  assert.equal((await f.o.consume(armed.id)).kind, 'already-consumed');
  assert.equal(f.o.status().state, 'absent');
});

test('one passive observer per chat/checkout, concurrent arms and cancellation send no task or hint', async t => {
  const f = await setup(t);
  const arms = await Promise.allSettled([f.arm(), f.arm()]);
  assert.equal(arms.filter(value => value.status === 'fulfilled').length, 1);
  const other = f.make('00000000-0000-4000-8000-000000000021');
  await assert.rejects(other.arm(f.workspace, f.plan, { codexExe: process.execPath, sessionID, messageID }), /EEXIST/);
  const id = arms.find(value => value.status === 'fulfilled').value.id;
  const cancelled = await f.o.cancel(id); await f.end();
  assert.equal(cancelled.exited, true); assert.equal(f.active[sessionID].type, 'running');
  assert.equal(f.sent.length, 0); await assert.rejects(f.o.consume(id), /cancelled/);
});

test('newer or edited prompts never retarget a receipt, even at consume', async t => {
  const f = await setup(t), pin = await f.select();
  f.messages.get(sessionID)[0].text += ' changed';
  await assert.rejects(externalOutcome(f.client, f.stateRoot, pin), /prompt changed/);
  f.messages.get(sessionID)[0].text = 'Implement ' + basename(f.plan);
  const armed = await f.arm(); f.finish(sessionID); await f.end();
  f.messages.get(sessionID).push({ id: 'msg_new', type: 'user', text: 'Implement ' + basename(f.plan) });
  await assert.rejects(f.o.consume(armed.id), /prompt changed/);
});

test('bound session cannot bypass owner/STOPPED/uncertainty gates', async t => {
  const f = await setup(t), old = f.state().bindings[0];
  await assert.rejects(selectExternal(f.client, f.stateRoot, f.workspace, f.plan, old.sessionID), /already has a helper binding/);
});

test('wrong message, plan, engine, model variant, physical directory and overlapping writer fail closed', async t => {
  const f = await setup(t), pin = await f.select();
  await assert.rejects(selectExternal(f.client, f.stateRoot, f.workspace, f.plan, sessionID, 'msg_wrong'), /no longer/);
  const text = f.messages.get(sessionID)[0].text;
  f.messages.get(sessionID)[0].text = 'Other task'; await assert.rejects(f.select(), /selected plan/);
  f.messages.get(sessionID)[0].text = text;
  await assert.rejects(externalOutcome({ ...f.client, engineID: 'changed' }, f.stateRoot, pin), /engine changed/);
  f.session.model.variant = 'different'; await assert.rejects(externalOutcome(f.client, f.stateRoot, pin), /options changed/);
  f.session.model.variant = 'high'; f.session.location.directory = f.root;
  await assert.rejects(f.select(), /directory mismatch/); f.session.location.directory = f.workspace;
  f.sessions.set('ses_other', { id: 'ses_other', location: { directory: f.workspace } });
  f.active.ses_other = { type: 'running' }; await assert.rejects(f.select(), /Another executor/);
});

for (const kind of ['question', 'permission']) test('external ' + kind + ' is correlated, not automatically answered', async t => {
  const f = await setup(t), armed = await f.arm(), now = Date.now();
  f.messages.get(sessionID).push({ id: 'msg_tool', type: 'assistant', model, time: { created: now },
    content: [{ id: 'call_request', type: 'tool', name: kind, state: { status: 'running' }, time: { created: now } }] });
  if (kind === 'question') f.forms = [{ id: 'frm_question', sessionID, metadata: { kind, tool: { messageID: 'msg_tool', id: 'call_request' } },
    title: 'PRIVATE_QUESTION', fields: [{ key: 'answer', type: 'string' }] }];
  else f.permissions = [{ id: 'per_permission', sessionID, action: 'shell', resources: ['fixture'], source: { type: 'tool', messageID: 'msg_tool', id: 'call_request' } }];
  f.emit(kind === 'question' ? 'form.created' : 'permission.created', sessionID); await f.end();
  const result = await f.o.consume(armed.id); assert.equal(result.kind, kind);
  assert.equal(result.ownershipTransferred, false); assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify(f.o.status(armed.id)).includes('PRIVATE_QUESTION'));
});

test('terminal text alone, outstanding shell, invalid status and uncorrelated request cannot complete', async t => {
  const f = await setup(t), pin = await f.select();
  f.messages.get(sessionID).push({ id: 'msg_text', type: 'assistant', model, finish: 'stop', time: { completed: Date.now() }, content: [] });
  assert.equal((await externalOutcome(f.client, f.stateRoot, pin)).kind, 'observing');
  f.active[sessionID] = { type: 'unknown' }; await assert.rejects(f.select(), /Unknown active/);
  f.active[sessionID] = { type: 'running' };
  f.forms = [{ id: 'frm_wrong', sessionID, metadata: { kind: 'question', tool: { messageID: 'msg_missing', id: 'call_missing' } } }];
  await assert.rejects(f.select(), /not correlated/); f.forms = [];
  f.finish(sessionID); f.shells = [{ status: 'running', time: {} }];
  await assert.rejects(externalOutcome(f.client, f.stateRoot, pin), /shell still running/);
});

test('new untracked plan has unknown count, changed plan and interrupted exchange refuse completion', async t => {
  const f = await setup(t), plan = join(dirname(f.plan), '002-other.md');
  writeFileSync(plan, 'Read-only plan with no non-Git declaration.');
  f.messages.get(sessionID)[0].text = 'Implement 002-other.md';
  const pin = await selectExternal(f.client, f.stateRoot, f.workspace, plan, sessionID, messageID);
  assert.equal(pin.correctionCount, null);
  writeFileSync(plan, 'Changed'); await assert.rejects(externalOutcome(f.client, f.stateRoot, pin), /context\/plan changed/);
  writeFileSync(plan, 'Read-only plan with no non-Git declaration.');
  f.messages.get(sessionID).push({ id: 'msg_failedidle', type: 'idle', outcome: 'interrupted' });
  assert.equal((await externalOutcome(f.client, f.stateRoot, pin)).kind, 'observing');
  delete f.active[sessionID];
  assert.equal((await externalOutcome(f.client, f.stateRoot, pin)).kind, 'interrupted');
});

test('external CLI inspect is read-only and observe requires both exact pins', async t => {
  const f = await setup(t);
  const inspected = await f.call(['inspect-external', f.workspace, f.plan, '--session', sessionID], chatID);
  assert.equal(inspected.status, 0); assert.equal(inspected.result.messageID, messageID);
  const invalid = await f.call(['observe', f.workspace, f.plan, '--session', sessionID], chatID);
  assert.equal(invalid.status, 1); assert.equal(invalid.result.kind, 'observer-rejected');
  const mixed = await f.call(['arm', f.workspace, f.plan, '--session', sessionID, '--message', messageID], chatID);
  assert.equal(mixed.status, 1);
});

test('unknown passive checkout slot is retained and prevents a second observer', async t => {
  const f = await setup(t), pin = await f.select();
  const root = join(f.stateRoot, 'observers'); mkdirSync(root, { recursive: true });
  const slot = join(root, 'external-' + createHash('sha256').update(pin.checkout).digest('hex'));
  const original = JSON.stringify({ id: 'unknown-owner', codexChat: 'other' }); writeFileSync(slot, original);
  await assert.rejects(f.arm(), /EEXIST/); assert.equal(readFileSync(slot, 'utf8'), original);
  assert.equal(f.sent.length, 0); assert.equal(f.o.status().state, 'absent');
});

test('stream disconnect notifies once and never reconnects or sends a prompt', async t => {
  const f = await setup(t), armed = await f.arm(), opens = f.streamOpens;
  for (const stream of f.streams) stream.destroy();
  await f.end(); assert.equal(f.sent.length, 1); assert.equal(f.streamOpens, opens);
  const consumed = await f.o.consume(armed.id);
  assert.equal(consumed.kind, 'observer-error');
  assert.equal(consumed.executorCheck.status, 'checked'); assert.equal(consumed.executorCheck.kind, 'observing');
  assert.equal(consumed.executorCheck.executorActivity, 'running'); assert.equal(consumed.executorCheck.reviewAllowed, false);
  assert.equal(consumed.rearm, false);
  await assert.rejects(f.o.worker(armed.id), /EEXIST|slot changed/); assert.equal(f.sent.length, 1);
});

for (const type of ['location.shutdown', 'location.disposed']) test('foreign ' + type + ' keeps passive observation through completion', async t => {
  const f = await setup(t), armed = await f.arm(), opens = f.streamOpens;
  for (const stream of f.streams) stream.write('data: ' + JSON.stringify({ type,
    location: { directory: f.root }, data: { sessionID: 'ses_other' } }) + '\n\n');
  await new Promise(done => setTimeout(done, 70));
  assert.equal(f.sent.length, 0); assert.equal(f.o.status(armed.id).result, null);
  assert.equal(f.active[sessionID].type, 'running'); assert.equal(f.streamOpens, opens);
  f.finish(sessionID); await f.end();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.o.consume(armed.id)).kind, 'external-completed');
});

test('saved observer error cannot become completion; failed fresh reads remain unavailable', async t => {
  const f = await setup(t), armed = await f.arm();
  for (const stream of f.streams) stream.write('data: ' + JSON.stringify({ type: 'location.shutdown',
    location: { directory: f.workspace }, data: {} }) + '\n\n');
  await f.end(); f.finish(sessionID);
  const result = await f.o.consume(armed.id);
  assert.equal(result.kind, 'observer-error'); assert.equal(result.diagnostic.eventScope, 'selected');
  assert.equal(result.executorCheck.status, 'checked'); assert.equal(result.executorCheck.kind, 'external-completed');
  assert.equal(result.executorCheck.executorActivity, 'idle'); assert.equal(result.executorCheck.reviewAllowed, false);
  assert.equal(result.rearm, false);
  f.active[sessionID] = { type: 'running' };
  const next = await f.arm();
  for (const stream of f.streams) stream.destroy();
  await f.end(); f.session.model.variant = 'changed';
  const failed = await f.o.consume(next.id);
  assert.equal(failed.kind, 'observer-error'); assert.equal(failed.executorCheck.status, 'unavailable');
  assert.equal(failed.rearm, false);
});

test('plan change after readiness still sends an error hint and never grants consume', async t => {
  const f = await setup(t), original = readFileSync(f.plan), armed = await f.arm();
  writeFileSync(f.plan, 'Changed plan'); f.emit('tool.success', sessionID); await f.end();
  assert.equal(f.sent.length, 1); assert.equal(f.o.status(armed.id).result.kind, 'observer-error');
  await assert.rejects(f.o.consume(armed.id), /context\/plan changed/);
  writeFileSync(f.plan, original);
});

test('native system notice is data in shared history; invalid or later input cannot complete', async t => {
  const f = await setup(t), pin = await f.select();
  const notice = { id: 'msg_system', type: 'system', text: 'PRIVATE_SYSTEM_DATA', time: { created: Date.now() },
    metadata: { notice: 'instructions', instructionSources: ['core/codemode'] }, description: 'Instructions updated' };
  f.messages.get(sessionID).push(notice);
  assert.equal((await externalOutcome(f.client, f.stateRoot, pin)).kind, 'observing');
  assert.equal(inspectMessages(pin, f.messages.get(sessionID)).kind, undefined);
  notice.unexpected = true; await assert.rejects(externalOutcome(f.client, f.stateRoot, pin), /Unknown native system/);
  delete notice.unexpected; f.finish(sessionID);
  assert.equal((await externalOutcome(f.client, f.stateRoot, pin)).kind, 'external-completed');
  notice.time.created = Date.now() + 10000;
  await assert.rejects(externalOutcome(f.client, f.stateRoot, pin), /No completed final after system/);
});

for (const terminal of ['external-completed', 'failed']) test('immediate ' + terminal + ' is terminal, never an armed wait', async t => {
  const f = await setup(t); f.finish(sessionID);
  if (terminal === 'failed') f.messages.get(sessionID).splice(1, 0, { id: 'msg_error', type: 'assistant', model,
    time: { completed: Date.now() }, content: [{ id: 'call_error', type: 'tool', name: 'edit', state: { status: 'error' } }] });
  const started = await f.arm(); await f.end();
  assert.equal(started.kind, 'observer-terminal'); assert.equal(started.endTurn, false);
  assert.equal(started.result.kind, terminal); assert.equal(started.consumeRequired, true);
  const consumed = await f.o.consume(started.id);
  assert.equal(consumed.kind, terminal); assert.equal(consumed.observerState, 'ended');
  assert.equal(consumed.executorActivity, 'idle'); assert.equal(consumed.dispatchAllowed, false);
  assert.equal(consumed.reviewAllowed, terminal === 'external-completed');
  assert.equal(consumed.rearm, false); assert.equal(f.sent.length, 1);
});

test('pending rejected edit keeps observation and question correlation; unresolved idle remains failed', async t => {
  const f = await setup(t), pin = await f.select(), path = join(f.workspace, 'edit-target.txt'), now = Date.now();
  writeFileSync(path, 'fixture');
  const edit = { id: 'call_edit', type: 'tool', name: 'edit', time: { ran: now, completed: now },
    state: { status: 'error', input: { path, oldString: 'old', newString: 'new' }, error: { type: 'tool.execution',
      message: `Could not find oldString in ${path}. It must match exactly, including whitespace and indentation.` } } };
  f.messages.get(sessionID).push({ id: 'msg_edit', type: 'assistant', model, time: { completed: now }, content: [edit] });
  const pending = await externalOutcome(f.client, f.stateRoot, pin);
  assert.equal(pending.kind, 'observing'); assert.equal(pending.executorActivity, 'running');
  assert.equal(pending.reviewAllowed, false); assert.equal(pending.dispatchAllowed, false);
  f.messages.get(sessionID).push({ id: 'msg_question', type: 'assistant', model, content: [
    { id: 'call_question', name: 'question', type: 'tool', state: { status: 'running' } }] });
  f.forms = [{ id: 'frm_question', sessionID, metadata: { kind: 'question', tool: { messageID: 'msg_question', id: 'call_question' } },
    fields: [{ key: 'answer', type: 'string' }] }];
  assert.equal((await externalOutcome(f.client, f.stateRoot, pin)).kind, 'question');
  f.forms = []; f.finish(sessionID);
  const failed = await externalOutcome(f.client, f.stateRoot, pin);
  assert.equal(failed.kind, 'failed'); assert.equal(failed.executorActivity, 'idle'); assert.equal(failed.reviewAllowed, false);
  f.active[sessionID] = { type: 'running' }; edit.state.error.message = 'disk write failed';
  const genuine = await externalOutcome(f.client, f.stateRoot, pin);
  assert.equal(genuine.kind, 'observing'); assert.equal(genuine.executorActivity, 'running');
  assert.equal(genuine.exchangeOutcome, 'failed'); assert.equal(genuine.reviewAllowed, false);
});
