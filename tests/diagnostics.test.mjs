import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { fixture, baseline, model } from './http-fixture.mjs';

const activeFailure = (method, route) => method === 'GET' && route === '/api/session/active' ?
  { _tag: 'InvalidRequestError' } : undefined;

async function review(f, chatID) {
  assert.equal((await f.call(f.bindArgs(3), chatID)).status, 0);
  assert.equal((await f.call(['submit', f.workspace, f.plan, 'diag-assignment', f.packet,
    '--kind', 'initial', '--non-git-baseline', baseline], chatID)).status, 0);
  const sessionID = f.state().bindings.find(binding => binding.codexChat === chatID).sessionID;
  f.finish(sessionID);
  const result = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '2000', '--non-git-baseline', baseline], chatID);
  assert.equal(result.status, 0); assert.equal(result.result.phase, 'REVIEWING');
  return sessionID;
}

function addQuestion(f, sessionID) {
  const now = Date.now(), messageID = 'msg_diag_tool';
  f.messages.get(sessionID).push({ id: messageID, type: 'assistant', model, time: { created: now },
    content: [{ id: 'call_diag', type: 'tool', name: 'question', time: { created: now }, state: { status: 'running', input: {} } }] });
  f.forms = [{ id: 'frm_diag', sessionID, title: 'Diagnostic test', metadata: { kind: 'question',
    tool: { messageID, id: 'call_diag' } }, fields: [{ key: 'q0', type: 'string', title: 'Continue?',
      options: [{ value: 'yes', label: 'Yes' }], custom: false }] }];
  f.emit('form.created', sessionID);
}

function addPermission(f, sessionID) {
  const now = Date.now(), messageID = 'msg_diag_permission_tool';
  f.messages.get(sessionID).push({ id: messageID, type: 'assistant', model, time: { created: now },
    content: [{ id: 'call_diag_permission', type: 'tool', name: 'question', time: { created: now }, state: { status: 'running', input: {} } }] });
  f.permissions = [{ id: 'per_diag', sessionID, action: 'exec', resources: ['offline fixture'],
    source: { type: 'tool', messageID, id: 'call_diag_permission' } }];
  f.emit('permission.created', sessionID);
}

async function pendingReply(f, chat, kind) {
  assert.equal((await f.call(f.bindArgs(3), chat)).status, 0);
  assert.equal((await f.call(['submit', f.workspace, f.plan, 'reply-save-assignment', f.packet,
    '--kind', 'initial', '--non-git-baseline', baseline], chat)).status, 0);
  const sessionID = f.state().bindings.find(binding => binding.codexChat === chat).sessionID;
  if (kind === 'question') addQuestion(f, sessionID); else addPermission(f, sessionID);
  const pending = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '2000', '--non-git-baseline', baseline], chat);
  assert.equal(pending.status, 0); assert.equal(pending.result.kind, kind);
  return sessionID;
}

function failStateRename(f, failAt) {
  const preload = join(f.root, 'fail-state-rename.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync; let matching = 0;
fs.renameSync = function (source, destination, ...rest) {
  if (destination === process.env.CODEDUET_FAULT_STATE_PATH && ++matching === Number(process.env.CODEDUET_FAULT_STATE_AT))
    throw Object.assign(new Error('PRIVATE_STATE_WRITE_CANARY'), { code: 'EIO' });
  return Reflect.apply(rename, this, [source, destination, ...rest]);
};
syncBuiltinESMExports();
`);
  return { NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' '),
    CODEDUET_FAULT_STATE_PATH: f.statePath, CODEDUET_FAULT_STATE_AT: String(failAt) };
}

for (const operation of ['finish', 'next', 'reply']) test('HTTP 400 in ' + operation + ' retains its typed diagnostic in result and saved STOPPED state', async t => {
  const f = await fixture(t), chat = 'offline-diagnostic-' + operation;
  let sessionID;
  if (operation === 'reply') {
    assert.equal((await f.call(f.bindArgs(3), chat)).status, 0);
    assert.equal((await f.call(['submit', f.workspace, f.plan, 'diag-assignment', f.packet,
      '--kind', 'initial', '--non-git-baseline', baseline], chat)).status, 0);
    sessionID = f.state().bindings.find(binding => binding.codexChat === chat).sessionID;
    addQuestion(f, sessionID);
    const pending = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '2000', '--non-git-baseline', baseline], chat);
    assert.equal(pending.status, 0); assert.equal(pending.result.kind, 'question');
  } else sessionID = await review(f, chat);

  f.rejectRequest = activeFailure;
  let args;
  if (operation === 'finish') args = ['finish', f.workspace, f.plan, '--non-git-baseline', baseline];
  else if (operation === 'next') args = ['next', f.workspace, f.plan, 'block', '--non-git-baseline', baseline];
  else {
    const answer = join(f.workspace, 'answer.json'); writeFileSync(answer, JSON.stringify({ answer: { q0: 'yes' } }));
    args = ['reply', f.workspace, f.plan, 'question', 'frm_diag', answer, '--non-git-baseline', baseline];
  }
  const result = await f.call(args, chat);
  assert.equal(result.status, 1); assert.equal(result.result.kind, 'stopped');
  assert.equal(result.result.phase, 'STOPPED'); assert.equal(result.result.stateChange, 'saved');
  assert.equal(result.result.diagnostic.category, 'request-http');
  assert.equal(result.result.diagnostic.operation, 'session.active');
  assert.equal(result.result.diagnostic.method, 'GET');
  assert.equal(result.result.diagnostic.httpStatus, 400);
  assert.equal(result.result.diagnostic.errorCode, 'InvalidRequestError');
  const saved = f.state().bindings.find(binding => binding.codexChat === chat);
  assert.equal(saved.phase, 'STOPPED'); assert.deepEqual(saved.diagnostic, result.result.diagnostic);
  if (operation === 'reply') assert.equal(saved.pending.id, 'frm_diag');
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.route.endsWith('/reply')).length, 0);
});

test('bootstrap failure leaves PREPARING unchanged and a later normal bind succeeds', async t => {
  const f = await fixture(t), chat = 'offline-bootstrap-preparing';
  assert.equal((await f.call(f.bindArgs(8), chat)).status, 0);
  const before = fs.readFileSync(f.statePath);
  f.rejectRequest = (method, route) => method === 'GET' && route === '/api/info' ? { _tag: 'InvalidRequestError' } : undefined;
  const unavailable = await f.call(f.bindArgs(8), chat);
  assert.equal(unavailable.status, 1); assert.equal(unavailable.result.kind, 'connection-unavailable');
  assert.equal(unavailable.result.phase, 'PREPARING'); assert.equal(unavailable.result.stateChange, 'unchanged');
  assert.equal(unavailable.result.bootstrap.attempts, 1);
  assert.equal(unavailable.result.diagnostic.operation, 'server.info');
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  f.rejectRequest = undefined;
  const reused = await f.call(f.bindArgs(8), chat);
  assert.equal(reused.status, 0); assert.equal(reused.result.kind, 'reused');
});

test('bootstrap failure leaves FINISHED unchanged; later ordinary next succeeds', async t => {
  const f = await fixture(t), chat = 'offline-bootstrap-finished';
  const sessionID = await review(f, chat);
  assert.equal((await f.call(['finish', f.workspace, f.plan, '--non-git-baseline', baseline], chat)).status, 0);
  const before = fs.readFileSync(f.statePath);
  f.rejectRequest = (method, route) => method === 'GET' && route === '/api/info' ? { _tag: 'InvalidRequestError' } : undefined;
  const unavailable = await f.call(['next', f.workspace, f.plan, 'block', '--non-git-baseline', baseline], chat);
  assert.equal(unavailable.status, 1); assert.equal(unavailable.result.kind, 'connection-unavailable');
  assert.equal(unavailable.result.phase, 'FINISHED'); assert.equal(unavailable.result.stateChange, 'unchanged');
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  f.rejectRequest = undefined;
  const next = await f.call(['next', f.workspace, f.plan, 'block', '--non-git-baseline', baseline], chat);
  assert.equal(next.status, 0); assert.equal(next.result.phase, 'PREPARING');
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
});

test('a local submit phase rejection returns its current phase and leaves the binding unchanged', async t => {
  const f = await fixture(t), chat = 'offline-local-phase-rejection';
  assert.equal((await f.call(f.bindArgs(2), chat)).status, 0);
  assert.equal((await f.call(['submit', f.workspace, f.plan, 'phase-assignment', f.packet,
    '--kind', 'initial', '--non-git-baseline', baseline], chat)).status, 0);
  const before = fs.readFileSync(f.statePath), sessionID = f.state().bindings[0].sessionID;
  const rejected = await f.call(['submit', f.workspace, f.plan, 'phase-assignment-duplicate', f.packet,
    '--kind', 'initial', '--non-git-baseline', baseline], chat);
  assert.equal(rejected.status, 1); assert.equal(rejected.result.kind, 'rejected');
  assert.equal(rejected.result.phase, 'EXECUTING'); assert.equal(rejected.result.stateChange, 'unchanged');
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
});

for (const phase of ['EXECUTING', 'WAITING_FOR_ANSWER', 'REVIEWING']) test('bootstrap failure conservatively stops ' + phase + ' and keeps the first STOPPED diagnostic', async t => {
  const f = await fixture(t), chat = 'offline-bootstrap-' + phase.toLowerCase();
  let sessionID;
  if (phase === 'REVIEWING') sessionID = await review(f, chat);
  else {
    assert.equal((await f.call(f.bindArgs(3), chat)).status, 0);
    assert.equal((await f.call(['submit', f.workspace, f.plan, 'diag-assignment', f.packet,
      '--kind', 'initial', '--non-git-baseline', baseline], chat)).status, 0);
    sessionID = f.state().bindings.find(binding => binding.codexChat === chat).sessionID;
    if (phase === 'WAITING_FOR_ANSWER') {
      addQuestion(f, sessionID);
      const waiting = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '2000', '--non-git-baseline', baseline], chat);
      assert.equal(waiting.status, 0); assert.equal(waiting.result.phase, 'WAITING_FOR_ANSWER');
    }
  }
  f.rejectRequest = (method, route) => method === 'GET' && route === '/api/info' ? { _tag: 'InvalidRequestError' } : undefined;
  let args;
  if (phase === 'EXECUTING') args = ['wait', f.workspace, f.plan, '--timeout-ms', '1000', '--non-git-baseline', baseline];
  else if (phase === 'REVIEWING') args = ['next', f.workspace, f.plan, 'block', '--non-git-baseline', baseline];
  else {
    const answer = join(f.workspace, 'answer.json'); writeFileSync(answer, JSON.stringify({ answer: { q0: 'yes' } }));
    args = ['reply', f.workspace, f.plan, 'question', 'frm_diag', answer, '--non-git-baseline', baseline];
  }
  const stopped = await f.call(args, chat);
  assert.equal(stopped.status, 1); assert.equal(stopped.result.kind, 'connection-uncertain');
  assert.equal(stopped.result.phase, 'STOPPED'); assert.equal(stopped.result.stateChange, 'saved');
  assert.equal(stopped.result.diagnostic.operation, 'server.info');
  const beforeSticky = fs.readFileSync(f.statePath), firstDiagnostic = stopped.result.diagnostic;
  const sticky = await f.call(f.bindArgs(3), chat);
  assert.equal(sticky.status, 1); assert.equal(sticky.result.kind, 'stopped');
  assert.equal(sticky.result.stateChange, 'unchanged'); assert.deepEqual(sticky.result.diagnostic, firstDiagnostic);
  assert.deepEqual(fs.readFileSync(f.statePath), beforeSticky);
  const saved = f.state().bindings.find(binding => binding.codexChat === chat);
  assert.equal(saved.phase, 'STOPPED'); assert.deepEqual(saved.diagnostic, firstDiagnostic);
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
});

test('a primary HTTP diagnostic survives a failed attempt to persist STOPPED', async t => {
  const f = await fixture(t), chat = 'offline-primary-diagnostic';
  const client = await connect({ registrationPath: join(f.home, '.local', 'state', 'opencode', 'service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: chat });
  await adapter.bind(f.workspace, f.plan, baseline, 3);
  await adapter.submit(f.workspace, f.plan, 'diag-assignment', f.packet, baseline, 'initial');
  const sessionID = f.state().bindings.find(binding => binding.codexChat === chat).sessionID;
  f.finish(sessionID);
  const completed = await adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 2000 });
  assert.equal(completed.phase, 'REVIEWING');
  const before = fs.readFileSync(f.statePath);
  f.rejectRequest = activeFailure;
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (source, destination, ...rest) {
    if (destination === f.statePath) throw Object.assign(new Error('PRIVATE_WRITE_CANARY'), { code: 'EIO' });
    return originalRename(source, destination, ...rest);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await adapter.finish(f.workspace, f.plan, baseline); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(result.phase, 'REVIEWING'); assert.equal(result.stateChange, 'unconfirmed');
  assert.equal(result.diagnostic.operation, 'session.active');
  assert.equal(result.diagnostic.httpStatus, 400); assert.equal(result.diagnostic.errorCode, 'InvalidRequestError');
  assert.equal(result.persistenceFailure.category, 'state-io');
  assert.equal(result.persistenceFailure.stage, 'state-write'); assert.equal(result.persistenceFailure.errorCode, 'EIO');
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  assert.equal(f.state().bindings[0].phase, 'REVIEWING');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_WRITE_CANARY'));
});

for (const kind of ['question', 'permission']) test('accepted ' + kind + ' reply with a failed final save remains stopped and cannot replay', async t => {
  const f = await fixture(t), chat = 'offline-reply-save-' + kind;
  const sessionID = await pendingReply(f, chat, kind), requestID = kind === 'question' ? 'frm_diag' : 'per_diag';
  const answer = join(f.workspace, 'answer.json');
  writeFileSync(answer, JSON.stringify(kind === 'question' ? { answer: { q0: 'yes' } } : { decision: 'reject' }));
  const args = ['reply', f.workspace, f.plan, kind, requestID, answer, '--non-git-baseline', baseline];
  const result = await f.call(args, chat, 10_000, failStateRename(f, 2));
  assert.equal(result.status, 1); assert.equal(result.result.kind, 'stopped');
  assert.equal(result.result.phase, 'STOPPED'); assert.equal(result.result.stateChange, 'unconfirmed');
  assert.match(result.result.error, /state transition unconfirmed/);
  assert.equal(result.result.diagnostic.category, 'state-io');
  assert.equal(result.result.diagnostic.stage, 'state-write'); assert.equal(result.result.diagnostic.errorCode, 'EIO');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_STATE_WRITE_CANARY'));
  const saved = f.state().bindings.find(binding => binding.codexChat === chat);
  assert.equal(saved.phase, 'STOPPED'); assert.equal(saved.uncertain, 'reply');
  assert.deepEqual(saved.pending, { kind, id: requestID, fingerprint: saved.pending.fingerprint });
  const route = '/api/session/' + sessionID + '/' + (kind === 'question' ? 'form' : 'permission') + '/' + requestID + '/reply';
  assert.equal(f.posts(route), 1);
  const beforeRetry = fs.readFileSync(f.statePath);
  const retry = await f.call(args, chat);
  assert.equal(retry.status, 1); assert.equal(retry.result.kind, 'stopped');
  assert.equal(retry.result.stateChange, 'unchanged');
  assert.deepEqual(fs.readFileSync(f.statePath), beforeRetry); assert.equal(f.posts(route), 1);
});

test('reply reservation save failure is unconfirmed, sends no reply, and leaves ordinary continuation possible', async t => {
  const f = await fixture(t), chat = 'offline-reply-reserve-fault';
  const sessionID = await pendingReply(f, chat, 'question'), answer = join(f.workspace, 'answer.json');
  writeFileSync(answer, JSON.stringify({ answer: { q0: 'yes' } }));
  const args = ['reply', f.workspace, f.plan, 'question', 'frm_diag', answer, '--non-git-baseline', baseline];
  const before = fs.readFileSync(f.statePath);
  const failed = await f.call(args, chat, 10_000, failStateRename(f, 1));
  assert.equal(failed.status, 1); assert.equal(failed.result.kind, 'stopped');
  assert.equal(failed.result.stateChange, 'unconfirmed'); assert.equal(failed.result.diagnostic.errorCode, 'EIO');
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  const route = '/api/session/' + sessionID + '/form/frm_diag/reply';
  assert.equal(f.posts(route), 0);
  const continued = await f.call(args, chat);
  assert.equal(continued.status, 0); assert.equal(continued.result.kind, 'replied');
  assert.equal(f.posts(route), 1);
});

test('bind and submit reserve/final saves report unconfirmed and never replay POSTs', async t => {
  const create = await fixture(t), createChat = 'offline-create-save-fault';
  const failedCreate = await create.call(create.bindArgs(2), createChat, 10_000, failStateRename(create, 2));
  assert.equal(failedCreate.status, 1); assert.equal(failedCreate.result.stateChange, 'unconfirmed');
  assert.equal(failedCreate.result.phase, 'STOPPED'); assert.equal(failedCreate.result.sessionID, 'ses_http1');
  assert.equal(failedCreate.result.diagnostic.errorCode, 'EIO');
  assert.equal(create.posts('/api/session'), 1);
  const createBytes = fs.readFileSync(create.statePath), createRetry = await create.call(create.bindArgs(2), createChat);
  assert.equal(createRetry.status, 1); assert.deepEqual(fs.readFileSync(create.statePath), createBytes);
  assert.equal(create.posts('/api/session'), 1);

  const submit = await fixture(t), submitChat = 'offline-submit-save-fault';
  assert.equal((await submit.call(submit.bindArgs(3), submitChat)).status, 0);
  const sessionID = submit.state().bindings.find(binding => binding.codexChat === submitChat).sessionID;
  const beforeReservation = fs.readFileSync(submit.statePath);
  const failedReservation = await submit.call(submit.submitArgs, submitChat, 10_000, failStateRename(submit, 1));
  assert.equal(failedReservation.status, 1); assert.equal(failedReservation.result.stateChange, 'unconfirmed');
  assert.equal(failedReservation.result.diagnostic.errorCode, 'EIO');
  assert.deepEqual(fs.readFileSync(submit.statePath), beforeReservation);
  assert.equal(submit.posts('/api/session/' + sessionID + '/prompt'), 0);
  const failedSubmit = await submit.call(submit.submitArgs, submitChat, 10_000, failStateRename(submit, 2));
  assert.equal(failedSubmit.status, 1); assert.equal(failedSubmit.result.stateChange, 'unconfirmed');
  assert.equal(failedSubmit.result.phase, 'STOPPED'); assert.equal(failedSubmit.result.diagnostic.errorCode, 'EIO');
  assert.equal(submit.state().bindings[0].uncertain, 'submit');
  assert.equal(submit.state().plans[0].correctionCount, 4);
  const promptRoute = '/api/session/' + sessionID + '/prompt';
  assert.equal(submit.posts(promptRoute), 1);
  const submitBytes = fs.readFileSync(submit.statePath), submitRetry = await submit.call(submit.submitArgs, submitChat);
  assert.equal(submitRetry.status, 1); assert.equal(submitRetry.result.kind, 'rejected');
  assert.deepEqual(fs.readFileSync(submit.statePath), submitBytes); assert.equal(submit.posts(promptRoute), 1);
});

for (const failAt of [1, 2, 3]) test('bind create save attempt ' + failAt + ' preserves attempted state outcome', async t => {
  const f = await fixture(t), chat = 'offline-bind-save-attempt-' + failAt;
  const result = await f.call(f.bindArgs(2), chat, 10_000, failStateRename(f, failAt));
  assert.equal(result.status, 1); assert.equal(result.result.kind, 'stopped');
  assert.equal(result.result.phase, 'STOPPED'); assert.equal(result.result.stateChange, 'unconfirmed');
  assert.equal(result.result.diagnostic.errorCode, 'EIO');
  assert.equal(f.posts('/api/session'), failAt === 1 ? 0 : 1);
  if (failAt > 1) {
    const saved = f.state().bindings[0];
    assert.equal(saved.phase, 'STOPPED'); assert.equal(saved.uncertain, 'create');
    assert.equal(saved.sessionID, failAt === 2 ? null : 'ses_http1');
    const beforeRetry = fs.readFileSync(f.statePath);
    assert.equal((await f.call(f.bindArgs(2), chat)).status, 1);
    assert.deepEqual(fs.readFileSync(f.statePath), beforeRetry); assert.equal(f.posts('/api/session'), 1);
  }
});

test('ownership release failure stays secondary to a primary HTTP stop', async t => {
  const f = await fixture(t), chat = 'offline-primary-plus-release';
  const sessionID = await review(f, chat);
  const client = await connect({ registrationPath: join(f.home, '.local', 'state', 'opencode', 'service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: chat });
  f.rejectRequest = activeFailure;
  const ownerRoot = join(dirname(f.statePath), 'ownership'), originalUnlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', function (path, ...rest) {
    if (String(path).startsWith(ownerRoot + sep)) throw Object.assign(new Error('PRIVATE_RELEASE_CANARY'), { code: 'EPERM' });
    return originalUnlink(path, ...rest);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await adapter.finish(f.workspace, f.plan, baseline); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(result.kind, 'stopped'); assert.equal(result.phase, 'STOPPED');
  assert.equal(result.stateChange, 'saved'); assert.equal(result.diagnostic.httpStatus, 400);
  assert.equal(result.diagnostic.operation, 'session.active');
  assert.ok(!result.error.includes('Ownership lock release unconfirmed'));
  assert.equal(result.ownershipReleaseFailure.category, 'state-access');
  assert.equal(result.ownershipReleaseFailure.errorCode, 'EPERM');
  assert.equal(f.state().bindings[0].phase, 'STOPPED');
  assert.ok(fs.readdirSync(ownerRoot).length > 0);
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RELEASE_CANARY'));
});

test('ownership release failure stays secondary to local reply rejection', async t => {
  const f = await fixture(t), chat = 'offline-rejected-plus-release';
  await pendingReply(f, chat, 'question');
  const client = await connect({ registrationPath: join(f.home, '.local', 'state', 'opencode', 'service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: chat });
  const before = fs.readFileSync(f.statePath), ownerRoot = join(dirname(f.statePath), 'ownership');
  const originalUnlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', function (path, ...rest) {
    if (String(path).startsWith(ownerRoot + sep)) throw Object.assign(new Error('PRIVATE_RELEASE_CANARY'), { code: 'EPERM' });
    return originalUnlink(path, ...rest);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await adapter.reply(f.workspace, f.plan, 'question', 'frm_diag', { answer: { q0: 'invalid' } }, baseline); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(result.kind, 'rejected'); assert.equal(result.phase, 'WAITING_FOR_ANSWER');
  assert.equal(result.stateChange, 'unchanged'); assert.match(result.error, /answer/i);
  assert.equal(result.ownershipReleaseFailure.category, 'state-access');
  assert.equal(result.ownershipReleaseFailure.errorCode, 'EPERM');
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.route.endsWith('/reply')).length, 0);
  assert.ok(fs.readdirSync(ownerRoot).length > 0);
});

test('connection failure keeps its primary diagnostic when invalid store state blocks persistence', async t => {
  const f = await fixture(t), chat = 'offline-connection-invalid-store';
  assert.equal((await f.call(f.bindArgs(2), chat)).status, 0);
  const invalidStore = Buffer.from('PRIVATE_INVALID_STORE_CANARY');
  fs.writeFileSync(f.statePath, invalidStore);
  f.rejectRequest = (method, route) => method === 'GET' && route === '/api/info' ? { _tag: 'InvalidRequestError' } : undefined;
  const outcome = await f.call(['finish', f.workspace, f.plan, '--non-git-baseline', baseline], chat);
  assert.equal(outcome.status, 1); assert.equal(outcome.result.kind, 'stopped');
  assert.equal(outcome.result.diagnostic.category, 'request-http');
  assert.equal(outcome.result.diagnostic.operation, 'server.info');
  assert.equal(outcome.result.persistenceFailure.category, 'state-io');
  assert.equal(outcome.result.persistenceFailure.stage, 'state-write');
  assert.equal(outcome.result.stateChange, 'unconfirmed');
  assert.deepEqual(fs.readFileSync(f.statePath), invalidStore);
  assert.ok(!JSON.stringify(outcome).includes('PRIVATE_INVALID_STORE_CANARY'));
});
