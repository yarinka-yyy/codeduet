import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixture, baseline, model } from './http-fixture.mjs';
import { context, helper, preflight } from '../helper/binding.mjs';
import { connect } from '../helper/connection.mjs';

const cliPath = fileURLToPath(new URL('../helper/cli.mjs', import.meta.url));
const execFileAsync = promisify(execFile);
const preflightArgs = (f, count = 0) =>
  ['preflight', f.workspace, f.plan, '--correction-count', String(count), '--non-git-baseline', baseline];

async function waitForStream(f, waiting) {
  waiting.catch(() => {});
  const deadline = Date.now() + 2000;
  while (!f.streams.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!f.streams.size) { await waiting; assert.fail('CLI did not open its SSE stream'); }
}

async function finishedPair(f, count = 7) {
  const bound = await f.call(f.bindArgs(count));
  assert.equal(bound.status, 0, JSON.stringify(bound.result));
  const sessionID = bound.result.sessionID;
  const submitted = await f.call(['submit', f.workspace, f.plan, 'finished-pair-assignment', f.packet,
    '--non-git-baseline', baseline]);
  assert.equal(submitted.status, 0, JSON.stringify(submitted.result));
  f.finish(sessionID);
  const reviewed = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '3000',
    '--non-git-baseline', baseline]);
  assert.equal(reviewed.status, 0, JSON.stringify(reviewed.result));
  const finished = await f.call(['finish', f.workspace, f.plan, '--non-git-baseline', baseline]);
  assert.equal(finished.status, 0, JSON.stringify(finished.result));
  return sessionID;
}

test('CLI preflight combines independent blockers and repeat runs leave all state untouched', async t => {
  const f = await fixture(t), pair = await f.call(f.bindArgs(7));
  assert.equal(pair.status, 0);
  f.sessions.get(pair.result.sessionID).model = { ...model, id: 'unsupported-model' };
  f.active[pair.result.sessionID] = { type: 'running' };
  const stateBefore = readFileSync(f.statePath), messagesBefore = JSON.stringify([...f.messages]);
  const configPath = join(f.home, '.codex', 'config.toml');
  const postCount = f.calls.filter(call => call.method === 'POST').length;
  const beforeCalls = f.calls.length;
  const args = ['preflight', f.workspace, f.plan, '--correction-count', '8'];

  const first = await f.call(args);
  assert.equal(first.status, 1); assert.equal(first.result.kind, 'preflight');
  assert.equal(first.result.status, 'blocked'); assert.equal(first.result.taskSent, false);
  const checks = Object.fromEntries(first.result.checks.map(item => [item.name, item]));
  assert.equal(checks.baseline.status, 'blocked');
  assert.equal(checks['correction-count'].status, 'blocked');
  assert.equal(checks['session-model'].status, 'blocked');
  assert.equal(checks.execution.status, 'blocked');
  assert.ok(first.result.blockers.length >= 4);
  assert.equal(first.result.connection.attempts, 1);
  assert.ok(f.calls.slice(beforeCalls).every(call => call.method === 'GET'));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, postCount);
  assert.deepEqual(readFileSync(f.statePath), stateBefore);
  assert.equal(JSON.stringify([...f.messages]), messagesBefore);
  assert.equal(existsSync(configPath), false);

  const second = await f.call(args);
  assert.equal(second.result.status, 'blocked');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, postCount);
  assert.deepEqual(readFileSync(f.statePath), stateBefore);
  assert.equal(JSON.stringify([...f.messages]), messagesBefore);
});

test('unbound late entry reports the new-bind route; bind creates it and later preflight reuses it', async t => {
  const f = await fixture(t), chatID = 'offline-http-chat-late-entry';
  const args = preflightArgs(f);
  const beforeCalls = f.calls.length;
  const fresh = await f.call(args, chatID);
  assert.equal(fresh.status, 0); assert.equal(fresh.result.status, 'pass');
  assert.equal(fresh.result.proposedRoute, 'new-bind');
  assert.equal(fresh.result.nextCommand.command, 'bind');
  assert.deepEqual(fresh.result.nextCommand.args.slice(2, 4), ['--correction-count', '0']);
  assert.equal(fresh.result.recipient.selected, false); assert.equal(fresh.result.taskSent, false);
  assert.ok(fresh.result.checks.some(item => item.name === 'history' && item.status === 'unknown' && item.deferred));
  assert.ok(f.calls.slice(beforeCalls).every(call => call.method === 'GET'));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(existsSync(dirname(f.statePath)), false);

  const bound = await f.call(f.bindArgs(0), chatID);
  assert.equal(bound.status, 0); assert.equal(bound.result.kind, 'created');
  assert.equal(f.posts('/api/session'), 1);
  const stateBefore = readFileSync(f.statePath), callsBefore = f.calls.length;
  const reused = await f.call(args, chatID);
  assert.equal(reused.status, 0); assert.equal(reused.result.status, 'pass');
  assert.equal(reused.result.proposedRoute, 'reuse-saved-pair');
  assert.equal(reused.result.recipient.sessionID, bound.result.sessionID);
  assert.equal(f.posts('/api/session'), 1);
  assert.ok(f.calls.slice(callsBefore).every(call => call.method === 'GET'));
  assert.deepEqual(readFileSync(f.statePath), stateBefore);
});

test('explicit existing recipient adopts without another prompt and completes the full CLI review cycle', async t => {
  const f = await fixture(t), chatID = 'offline-http-chat-existing';
  const sessionID = 'ses_existing012';
  const session = { id: sessionID, title: 'Selected fixture session', location: { directory: f.workspace },
    model: { providerID: model.providerID, id: model.id }, time: {} };
  f.sessions.set(sessionID, session); f.messages.set(sessionID, []);
  const args = ['preflight', f.workspace, f.plan, '--session', sessionID, '--correction-count', '0',
    '--non-git-baseline', baseline];
  const candidate = await f.call(args, chatID);
  assert.equal(candidate.status, 0, JSON.stringify(candidate.result)); assert.equal(candidate.result.status, 'pass');
  assert.equal(candidate.result.proposedRoute, 'adopt-existing');
  assert.equal(candidate.result.nextCommand.command, 'adopt');
  assert.equal(candidate.result.nextCommand.args[2], sessionID);
  assert.equal(candidate.result.recipient.source, 'explicit');
  assert.match(candidate.result.nextStep, /no extra confirmation/i);
  assert.equal(candidate.result.taskSent, false);
  assert.equal(f.posts('/api/session'), 0); assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 0);
  assert.equal(existsSync(f.statePath), false);

  f.active[sessionID] = { type: 'running' };
  const racedAdoption = await f.call(['adopt', f.workspace, f.plan, sessionID, '--correction-count', '0',
    '--non-git-baseline', baseline], chatID);
  assert.equal(racedAdoption.status, 1); assert.equal(racedAdoption.result.kind, 'rejected');
  assert.equal(racedAdoption.result.adoption.bindingState, 'unchanged');
  assert.equal(f.posts('/api/session'), 0); assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 0);
  assert.equal(existsSync(f.statePath), false);
  delete f.active[sessionID];

  const adopted = await f.call(['adopt', f.workspace, f.plan, sessionID, '--correction-count', '0',
    '--non-git-baseline', baseline], chatID);
  assert.equal(adopted.status, 0); assert.equal(adopted.result.kind, 'adopted');
  assert.equal(f.posts('/api/session'), 0); assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 0);
  const prepared = await f.call(preflightArgs(f), chatID);
  assert.equal(prepared.status, 0); assert.equal(prepared.result.proposedRoute, 'reuse-saved-pair');
  const stateBefore = readFileSync(f.statePath);

  session.model.variant = 'high';
  const raced = await f.call(['submit', f.workspace, f.plan, 'initial-raced', f.packet,
    '--non-git-baseline', baseline], chatID);
  assert.equal(raced.status, 1); assert.equal(raced.result.kind, 'rejected');
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 0);
  assert.deepEqual(readFileSync(f.statePath), stateBefore);
  delete session.model.variant;

  const submitted = await f.call(['submit', f.workspace, f.plan, 'initial-012', f.packet,
    '--non-git-baseline', baseline], chatID);
  assert.equal(submitted.status, 0); assert.equal(submitted.result.kind, 'admitted');
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
  const waiting = f.call(['wait', f.workspace, f.plan, '--timeout-ms', '3000',
    '--non-git-baseline', baseline], chatID, 6000);
  await waitForStream(f, waiting);
  f.messages.get(sessionID).push({ id: 'msg_question012', type: 'assistant', model: { ...model },
    content: [{ id: 'call_question012', type: 'tool', name: 'question',
      state: { status: 'running' } }] });
  f.forms = [{ id: 'frm_question012', sessionID,
    metadata: { kind: 'question', tool: { messageID: 'msg_question012', id: 'call_question012' } },
    fields: [{ key: 'q', type: 'string', title: 'Choice', options: [{ value: 'A', label: 'A' }], custom: true }] }];
  f.emit('form.created', sessionID);
  const question = await waiting;
  assert.equal(question.status, 0); assert.equal(question.result.kind, 'question');
  assert.equal(question.result.phase, 'WAITING_FOR_ANSWER');

  const answerPath = join(f.workspace, 'answer.json');
  writeFileSync(answerPath, JSON.stringify({ answer: { q: 'A' } }));
  const reply = await f.call(['reply', f.workspace, f.plan, 'question', 'frm_question012', answerPath,
    '--non-git-baseline', baseline], chatID);
  assert.equal(reply.status, 0); assert.equal(reply.result.kind, 'replied');
  assert.equal(f.posts('/api/session/' + sessionID + '/form/frm_question012/reply'), 1);
  f.finish(sessionID);
  const completed = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '3000',
    '--non-git-baseline', baseline], chatID);
  assert.equal(completed.status, 0, JSON.stringify(completed.result)); assert.equal(completed.result.kind, 'completed-for-review');
  assert.match(completed.result.result.text, /Simulator completed/);

  const next = await f.call(['next', f.workspace, f.plan, 'correction',
    '--non-git-baseline', baseline], chatID);
  assert.equal(next.status, 0); assert.equal(next.result.phase, 'PREPARING');
  assert.equal(next.result.correctionCount, 0);
  const correction = await f.call(['submit', f.workspace, f.plan, 'correction-012', f.packet,
    '--kind', 'correction', '--non-git-baseline', baseline], chatID);
  assert.equal(correction.status, 0); assert.equal(correction.result.kind, 'admitted');
  assert.equal(correction.result.correctionCount, 1);
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 2);
  f.finish(sessionID);
  const corrected = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '3000',
    '--non-git-baseline', baseline], chatID);
  assert.equal(corrected.status, 0); assert.equal(corrected.result.kind, 'completed-for-review');
  const finished = await f.call(['finish', f.workspace, f.plan, '--non-git-baseline', baseline], chatID);
  assert.equal(finished.status, 0); assert.equal(finished.result.phase, 'FINISHED');

  const secondWorkspace = join(f.root, 'second project'), secondPlan = join(f.root, 'second project', 'plans', '002-second.md');
  const secondBaseline = 'Baseline: independent second disposable project';
  mkdirSync(dirname(secondPlan), { recursive: true });
  writeFileSync(secondPlan, secondBaseline);
  const protectedSecond = join(secondWorkspace, 'owner-dirty.txt');
  writeFileSync(protectedSecond, 'SECOND_OWNER_DIRTY_BASELINE\n');
  const secondArgs = ['preflight', secondWorkspace, secondPlan, '--correction-count', '3',
    '--non-git-baseline', secondBaseline];
  const secondPreflight = await f.call(secondArgs, 'offline-http-chat-B');
  assert.equal(secondPreflight.status, 0); assert.equal(secondPreflight.result.status, 'pass');
  assert.equal(secondPreflight.result.proposedRoute, 'new-bind');
  const secondBound = await f.call(['bind', secondWorkspace, secondPlan, '--correction-count', '3',
    '--non-git-baseline', secondBaseline], 'offline-http-chat-B');
  assert.equal(secondBound.status, 0);
  assert.equal(readFileSync(protectedSecond, 'utf8'), 'SECOND_OWNER_DIRTY_BASELINE\n');
  assert.equal(readFileSync(join(f.workspace, 'owner-dirty.txt'), 'utf8'), 'OWNER_DIRTY_BASELINE\n');
  const state = f.state();
  assert.equal(state.bindings.length, 2);
  assert.deepEqual(state.plans.map(item => item.correctionCount).sort(), [1, 3]);
});

test('offline preflight retries only GET bootstrap and recovers on a later invocation', async t => {
  const f = await fixture(t), args = preflightArgs(f);
  f.fault = 'bootstrap-offline';
  const offline = await f.call(args);
  assert.equal(offline.status, 1); assert.equal(offline.result.kind, 'preflight');
  assert.equal(offline.result.status, 'blocked'); assert.equal(offline.result.connection.verified, false);
  assert.equal(offline.result.connection.attempts, 3); assert.equal(offline.result.connection.retried, true);
  assert.match(offline.result.nextStep, /Restore the OpenCode connection/);
  assert.equal(offline.result.taskSent, false);
  assert.equal(f.posts('/api/session'), 0);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal(existsSync(dirname(f.statePath)), false);

  f.fault = null;
  const online = await f.call(args);
  assert.equal(online.status, 0); assert.equal(online.result.status, 'pass');
  assert.equal(online.result.proposedRoute, 'new-bind');
  assert.equal(f.posts('/api/session'), 0);
  const invalid = await f.call(['preflight', f.workspace, f.plan, '--session', 'latest',
    '--correction-count', '0', '--non-git-baseline', baseline]);
  assert.equal(invalid.status, 1); assert.equal(invalid.result.status, 'blocked');
  assert.equal(invalid.result.checks.find(item => item.name === 'recipient').status, 'blocked');
  assert.equal(f.posts('/api/session'), 0);
});

test('explicit candidate reports invalid history, pending forms and running background work', async t => {
  const f = await fixture(t), sessionID = 'ses_invalid012';
  f.sessions.set(sessionID, { id: sessionID, title: 'Fixture', location: { directory: f.workspace },
    model: { providerID: model.providerID, id: model.id }, time: {} });
  f.messages.set(sessionID, []);
  f.messagePage = { data: [{ id: 'msg_invalid012', type: 'system' }], cursor: { next: 'repeat' } };
  f.forms = [{ id: 'frm_pending012', sessionID }];
  f.shells = [{ id: 'shell_running012', status: 'running', time: {} }];
  const beforeCalls = f.calls.length;
  const result = await f.call(['preflight', f.workspace, f.plan, '--session', sessionID,
    '--correction-count', '0', '--non-git-baseline', baseline]);
  assert.equal(result.status, 1); assert.equal(result.result.status, 'blocked');
  const checks = Object.fromEntries(result.result.checks.map(item => [item.name, item]));
  assert.equal(checks.history.status, 'blocked');
  assert.equal(checks.forms.status, 'blocked');
  assert.equal(checks.background.status, 'blocked');
  assert.ok(f.calls.slice(beforeCalls).every(call => call.method === 'GET'));
  assert.equal(f.posts('/api/session'), 0);
  assert.equal(existsSync(f.statePath), false);
});

test('preflight verifies a workspace nested inside its physical Git checkout', async t => {
  const f = await fixture(t), checkout = join(f.root, 'git checkout'), workspace = join(checkout, 'nested workspace');
  const plan = join(workspace, 'plans', '001-git.md');
  mkdirSync(dirname(plan), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: checkout, windowsHide: true, stdio: 'ignore' });
  writeFileSync(plan, 'Git fixture plan');
  const result = await f.call(['preflight', workspace, plan, '--correction-count', '0'], 'offline-http-git-chat');
  assert.equal(result.status, 0); assert.equal(result.result.status, 'pass');
  assert.equal(result.result.workspace.checkout, checkout);
  assert.equal(result.result.checks.find(item => item.name === 'git-checkout').status, 'pass');
  assert.equal(result.result.checks.find(item => item.name === 'baseline').status, 'pass');
  assert.equal(existsSync(f.statePath), false); assert.equal(f.posts('/api/session'), 0);
});

test('invalid state-root file blocks without probing or changing its bytes', async t => {
  const f = await fixture(t), stateRoot = join(f.root, 'state-root-file');
  writeFileSync(stateRoot, 'UNCHANGED_STATE_PATH');
  const client = await connect({ registrationPath: join(f.home, '.local', 'state', 'opencode', 'service.json') });
  const result = await preflight(client, { stateRoot, chatID: 'offline-http-chat-state-path',
    workspace: f.workspace, planPath: f.plan, correctionCount: 0, nonGitBaseline: baseline });
  assert.equal(result.status, 'blocked');
  assert.equal(result.checks.find(item => item.name === 'helper-state').status, 'blocked');
  assert.match(result.storeWriteAccess, /unknown until an authorized write command/);
  assert.equal(readFileSync(stateRoot, 'utf8'), 'UNCHANGED_STATE_PATH');
  assert.equal(f.posts('/api/session'), 0);
});

test('old STOPPED binding remains unchanged and blocks a new preflight route', async t => {
  const f = await fixture(t), bound = await f.call(f.bindArgs(0));
  const state = f.state();
  state.bindings[0].phase = 'STOPPED';
  state.bindings[0].stopReason = 'Previously interrupted; inspect first';
  writeFileSync(f.statePath, JSON.stringify(state, null, 2) + '\n');
  const before = readFileSync(f.statePath), posts = f.calls.filter(call => call.method === 'POST').length;
  const result = await f.call(preflightArgs(f));
  assert.equal(result.status, 1); assert.equal(result.result.status, 'blocked');
  assert.ok(result.result.checks.some(item => item.name === 'saved-phase' && item.status === 'blocked'));
  assert.match(result.result.nextStep, /Resolve the listed blockers/);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, posts);
  assert.equal(bound.result.sessionID, state.bindings[0].sessionID);
});

test('same physical checkout ID blocks a new chat after the old path is renamed', async t => {
  const f = await fixture(t);
  const client = await connect({ registrationPath: join(f.home, '.local', 'state', 'opencode', 'service.json') });
  const stateRoot = dirname(f.statePath), first = helper(client, { stateRoot, chatID: 'offline-http-chat-A' });
  const pair = await first.bind(f.workspace, f.plan, baseline, 0);
  assert.equal((await first.submit(f.workspace, f.plan, 'before-rename', f.packet, baseline)).kind, 'admitted');
  f.finish(pair.sessionID);
  const before = context(f.workspace, f.plan, baseline);
  const renamed = join(f.root, 'workspace renamed'), renamedPlan = join(renamed, 'plans', '001-test.md');
  renameSync(f.workspace, renamed);
  const after = context(renamed, renamedPlan, baseline);
  assert.equal(after.checkoutID, before.checkoutID);

  const snapshot = await preflight(client, { stateRoot, chatID: 'offline-http-chat-B',
    workspace: renamed, planPath: renamedPlan, correctionCount: 0, nonGitBaseline: baseline });
  assert.equal(snapshot.status, 'blocked');
  assert.ok(snapshot.checks.some(item => item.name === 'saved-writers' && item.status === 'blocked'));
  const second = helper(client, { stateRoot, chatID: 'offline-http-chat-B' });
  await assert.rejects(second.bind(renamed, renamedPlan, baseline, 0), /Prior helper assignment not reviewed.*stopped/);
  assert.equal(f.posts('/api/session'), 1);
});

test('preflight retains a bounded permanent HTTP 400 diagnostic and gives a non-looping next step', async t => {
  const f = await fixture(t), sessionID = 'ses_invalidrequest012';
  f.sessions.set(sessionID, { id: sessionID, title: 'Fixture', location: { directory: f.workspace },
    model: { providerID: model.providerID, id: model.id }, time: {} });
  f.messages.set(sessionID, []);
  f.rejectRequest = (method, route) => method === 'GET' && route.includes('/message?') ?
    { _tag: 'InvalidRequestError', message: 'PRIVATE_BODY_CANARY' } : undefined;
  const stateBefore = JSON.stringify({ schema: 1, bindings: [], plans: [] }, null, 2) + '\n';
  mkdirSync(dirname(f.statePath), { recursive: true });
  writeFileSync(f.statePath, stateBefore);
  const bytes = readFileSync(f.statePath), beforeCalls = f.calls.length;
  const result = await f.call(['preflight', f.workspace, f.plan, '--session', sessionID,
    '--correction-count', '0', '--non-git-baseline', baseline]);
  const history = result.result.checks.find(item => item.name === 'history');
  assert.equal(result.status, 1); assert.equal(history.status, 'blocked');
  assert.deepEqual(history.diagnostic, {
    category: 'request-http', stage: 'request', elapsedMs: history.diagnostic.elapsedMs, lastEvent: null,
    httpStatus: 400, errorCode: 'InvalidRequestError', operation: 'session.message.list',
    method: 'GET', page: 'first',
  });
  assert.match(history.reason, /GET session\.message\.list/);
  assert.match(result.result.nextStep, /do not retry the unchanged request/i);
  assert.match(result.result.nextStep, /correct this API request\/cursor/i);
  assert.equal(result.result.taskSent, false);
  assert.ok(f.calls.slice(beforeCalls).every(call => call.method === 'GET'));
  assert.equal(f.posts('/api/session'), 0);
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 0);
  assert.deepEqual(readFileSync(f.statePath), bytes);
  assert.ok(!JSON.stringify(result.result).includes('PRIVATE_BODY_CANARY'));
});

test('preflight store and ownership read failures retain safe typed diagnostics', async t => {
  for (const source of ['state', 'ownership']) {
    const f = await fixture(t), stateRoot = join(f.root, 'PRIVATE_STORE_ROOT_CANARY');
    mkdirSync(stateRoot, { recursive: true });
    const statePath = join(stateRoot, 'state.json'), ownershipRoot = join(stateRoot, 'ownership');
    if (source === 'state') writeFileSync(statePath, JSON.stringify({ schema: 1, bindings: [], plans: [] }));
    else {
      mkdirSync(ownershipRoot);
      writeFileSync(join(ownershipRoot, 'owner-12345678-1234-1234-1234-123456789abc.lock'),
        JSON.stringify({ schema: 1, token: '12345678-1234-1234-1234-123456789abc',
          codexChat: 'foreign-chat', workspace: f.workspace, checkout: f.workspace,
          sessionID: null, assignmentID: null, operation: 'bind' }));
    }
    const originalBytes = source === 'state' ? readFileSync(statePath) :
      readFileSync(join(ownershipRoot, 'owner-12345678-1234-1234-1234-123456789abc.lock'));
    const target = source === 'state' ? statePath : ownershipRoot;
    const method = source === 'state' ? 'readFileSync' : 'readdirSync';
    const original = fs[method];
    const client = await connect({ registrationPath: join(f.home, '.local', 'state', 'opencode', 'service.json') });
    t.mock.method(fs, method, function (path, ...args) {
      if (String(path) === target) throw Object.assign(new Error('PRIVATE_FS_EXCEPTION_CANARY ' + target),
        { code: 'EACCES', path: 'PRIVATE_FS_EXCEPTION_CANARY' });
      return original.call(this, path, ...args);
    });
    syncBuiltinESMExports();
    let result;
    try {
      result = await preflight(client, { stateRoot, chatID: 'offline-http-chat-io',
        workspace: f.workspace, planPath: f.plan, correctionCount: 0, nonGitBaseline: baseline });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    const name = source === 'state' ? 'helper-state' : 'ownership';
    const check = result.checks.find(item => item.name === name);
    assert.ok(['blocked', 'unknown'].includes(check.status));
    assert.equal(check.diagnostic.category, 'state-access');
    assert.equal(check.diagnostic.errorCode, 'EACCES');
    assert.equal(check.diagnostic.stage, 'state-lock');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_STORE_ROOT_CANARY'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_FS_EXCEPTION_CANARY'));
    assert.equal(f.posts('/api/session'), 0);
    const actualBytes = source === 'state' ? readFileSync(statePath) :
      readFileSync(join(ownershipRoot, 'owner-12345678-1234-1234-1234-123456789abc.lock'));
    assert.deepEqual(actualBytes, originalBytes);
  }
});

test('preflight has read access only; the following write needs permission and works when granted', async t => {
  const f = await fixture(t), env = { ...process.env, HOME: f.home, USERPROFILE: f.home,
    CODEX_THREAD_ID: 'offline-http-chat-permission' };
  const options = { cwd: f.workspace, env, windowsHide: true, timeout: 15_000 };
  const preflight = await execFileAsync(process.execPath, ['--no-warnings', '--permission',
    '--allow-fs-read=*', cliPath, ...preflightArgs(f)], options);
  const result = JSON.parse(preflight.stdout);
  assert.equal(result.status, 'pass');
  assert.match(result.storeWriteAccess, /unknown until an authorized write command/);
  assert.equal(existsSync(dirname(f.statePath)), false);
  assert.equal(f.posts('/api/session'), 0);

  const denied = await execFileAsync(process.execPath, ['--no-warnings', '--permission',
    '--allow-fs-read=*', cliPath, ...f.bindArgs(0)], options).then(value => value, error => error);
  assert.equal(denied.code, 1);
  assert.equal(denied.stdout, '');
  const deniedResult = JSON.parse(denied.stderr.trim());
  assert.equal(deniedResult.diagnostic.category, 'state-access');
  assert.equal(deniedResult.diagnostic.errorCode, 'ERR_ACCESS_DENIED');
  assert.equal(existsSync(dirname(f.statePath)), false);
  assert.equal(f.posts('/api/session'), 0);

  const written = await f.call(f.bindArgs(0), 'offline-http-chat-permission');
  assert.equal(written.status, 0, JSON.stringify(written.result));
  assert.equal(f.posts('/api/session'), 1);
  assert.equal(existsSync(f.statePath), true);
});

test('finished saved pair preflight gives the supported bind route for a new plan only', async t => {
  const f = await fixture(t), sessionID = await finishedPair(f, 7);
  const nextPlan = join(f.workspace, 'plans', '002-next.md');
  writeFileSync(nextPlan, baseline);
  const args = ['preflight', f.workspace, nextPlan, '--correction-count', '0', '--non-git-baseline', baseline];
  const stateBefore = readFileSync(f.statePath), messagesBefore = JSON.stringify(f.messages.get(sessionID));
  const postsBefore = f.calls.filter(call => call.method === 'POST').length;
  const ordinary = await f.call(args);
  assert.equal(ordinary.status, 0, JSON.stringify(ordinary.result));
  assert.equal(ordinary.result.proposedRoute, 'reuse-saved-pair');
  assert.equal(ordinary.result.nextCommand.command, 'bind');
  assert.deepEqual(ordinary.result.nextCommand.args.slice(0, 4), [f.workspace, nextPlan, '--correction-count', '0']);
  assert.deepEqual(readFileSync(f.statePath), stateBefore);

  const explicit = await f.call([...args.slice(0, 3), '--session', sessionID, ...args.slice(3)]);
  assert.equal(explicit.status, 0, JSON.stringify(explicit.result));
  assert.equal(explicit.result.proposedRoute, 'reuse-saved-pair');
  assert.equal(explicit.result.nextCommand.command, 'bind');
  assert.equal(explicit.result.recipient.source, 'explicit');
  assert.equal(explicit.result.nextCommand.command === 'adopt', false);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, postsBefore);

  const otherWorkspace = join(f.root, 'other target'), otherPlan = join(otherWorkspace, 'plans', '003-other.md');
  mkdirSync(dirname(otherPlan), { recursive: true });
  writeFileSync(otherPlan, baseline);
  const conflict = await f.call(['preflight', otherWorkspace, otherPlan, '--session', sessionID,
    '--correction-count', '0', '--non-git-baseline', baseline]);
  assert.equal(conflict.status, 1); assert.equal(conflict.result.status, 'blocked');
  assert.equal(conflict.result.nextCommand, null);
  assert.equal(conflict.result.checks.find(item => item.name === 'recipient').status, 'blocked');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, postsBefore);
  assert.deepEqual(readFileSync(f.statePath), stateBefore);

  const switched = await f.call([ordinary.result.nextCommand.command, ...ordinary.result.nextCommand.args]);
  assert.equal(switched.status, 0, JSON.stringify(switched.result));
  assert.equal(switched.result.kind, 'reused-plan');
  assert.equal(switched.result.phase, 'PREPARING');
  assert.equal(switched.result.sessionID, sessionID);
  assert.deepEqual(JSON.stringify(f.messages.get(sessionID)), messagesBefore);
  const state = f.state();
  assert.equal(state.plans.find(item => item.planPath === f.plan).correctionCount, 7);
  assert.equal(state.plans.find(item => item.planPath === nextPlan).correctionCount, 0);
  assert.equal(state.bindings[0].planPath, nextPlan);
  assert.equal(f.posts('/api/session'), 1);
});

test('adopted submit rejects a changed completed external-history boundary without POST', async t => {
  const f = await fixture(t), sessionID = 'ses_externalboundary012';
  const session = { id: sessionID, title: 'Completed external history', location: { directory: f.workspace },
    model: { providerID: model.providerID, id: model.id }, time: {} };
  f.sessions.set(sessionID, session);
  f.messages.set(sessionID, [{ id: 'msg_external_user', type: 'user', text: 'Previously completed task' }]);
  f.finish(sessionID);
  const explicitArgs = ['preflight', f.workspace, f.plan, '--session', sessionID,
    '--correction-count', '0', '--non-git-baseline', baseline];
  const checked = await f.call(explicitArgs);
  assert.equal(checked.status, 0, JSON.stringify(checked.result));
  assert.equal(checked.result.status, 'pass');
  const adopted = await f.call(['adopt', f.workspace, f.plan, sessionID, '--correction-count', '0',
    '--non-git-baseline', baseline]);
  assert.equal(adopted.status, 0, JSON.stringify(adopted.result));
  const saved = await f.call(preflightArgs(f));
  assert.equal(saved.status, 0, JSON.stringify(saved.result));
  assert.equal(saved.result.proposedRoute, 'reuse-saved-pair');
  const before = readFileSync(f.statePath), posts = f.posts('/api/session/' + sessionID + '/prompt');

  const changedAt = Date.now();
  f.messages.get(sessionID).push(
    { id: 'msg_external_user2', type: 'user', text: 'A separate external task' },
    { id: 'msg_external_final2', type: 'assistant', model, finish: 'stop',
      time: { completed: changedAt }, content: [{ type: 'text', text: 'Completed separately.' }] },
    { id: 'msg_external_idle2', type: 'idle', outcome: 'succeeded', time: { created: changedAt + 1 } });
  session.time = { idle: changedAt + 1, updated: changedAt + 1 };
  const rejected = await f.call(['submit', f.workspace, f.plan, 'after-external-boundary-change', f.packet,
    '--non-git-baseline', baseline]);
  assert.equal(rejected.status, 1); assert.equal(rejected.result.kind, 'rejected');
  assert.match(rejected.result.error, /changed since preparation/i);
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), posts);
  assert.deepEqual(readFileSync(f.statePath), before);
});

test('offline preflight preserves active and STOPPED saved bindings byte-for-byte', async t => {
  const f = await fixture(t), pair = await f.call(f.bindArgs(0));
  assert.equal(pair.status, 0);
  const submitted = await f.call(f.submitArgs);
  assert.equal(submitted.status, 0);
  const posts = f.calls.filter(call => call.method === 'POST').length;
  f.fault = 'bootstrap-offline';
  const activeBefore = readFileSync(f.statePath);
  const active = await f.call(preflightArgs(f));
  assert.equal(active.status, 1); assert.equal(active.result.status, 'blocked');
  assert.ok(active.result.checks.some(item => item.name === 'saved-phase' && item.status === 'blocked'));
  assert.deepEqual(readFileSync(f.statePath), activeBefore);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, posts);

  const state = f.state();
  state.bindings[0].phase = 'STOPPED';
  state.bindings[0].stopReason = 'Retained stopped fixture state';
  writeFileSync(f.statePath, JSON.stringify(state, null, 2) + '\n');
  const stoppedBefore = readFileSync(f.statePath);
  const stopped = await f.call(preflightArgs(f));
  assert.equal(stopped.status, 1); assert.equal(stopped.result.status, 'blocked');
  assert.ok(stopped.result.checks.some(item => item.name === 'saved-phase' && item.status === 'blocked'));
  assert.deepEqual(readFileSync(f.statePath), stoppedBefore);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, posts);
});
