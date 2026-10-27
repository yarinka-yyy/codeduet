import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, baseline, model } from './http-fixture.mjs';

const cli = fileURLToPath(new URL('../helper/cli.mjs', import.meta.url));
const wait = (workspace, plan) => ['wait', workspace, plan, '--timeout-ms', '20000', '--non-git-baseline', baseline];

function start(f, args, chatID, timeoutMs = 25_000) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: f.workspace, windowsHide: true,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_THREAD_ID: chatID },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      assert.ok(!stdout.includes('OFFLINE_HTTP_CANARY_007') && !stderr.includes('OFFLINE_HTTP_CANARY_007'));
      const output = (stdout || stderr).trim();
      resolve({ status, signal, stdout, stderr, result: output ? JSON.parse(output) : undefined });
    });
  });
  return { child, done };
}

async function until(predicate, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(label);
}

function bindArgs(workspace, plan, count) {
  return ['bind', workspace, plan, '--correction-count', String(count), '--non-git-baseline', baseline];
}

function submitArgs(workspace, plan, packet, assignment, kind = 'initial') {
  return ['submit', workspace, plan, assignment, packet, '--kind', kind, '--non-git-baseline', baseline];
}

function addQuestion(f, sessionID, suffix) {
  const now = Date.now(), messageID = 'msg_tool_' + suffix, callID = 'call_' + suffix;
  f.messages.get(sessionID).push({ id: messageID, type: 'assistant', model, time: { created: now },
    content: [{ id: callID, type: 'tool', name: 'question', time: { created: now }, state: { status: 'running', input: {} } }] });
  f.forms.push({ id: 'frm_' + suffix, sessionID, title: 'Local concurrency fixture',
    metadata: { kind: 'question', tool: { messageID, id: callID } },
    fields: [{ key: 'q0', type: 'string', title: 'Continue?', options: [{ value: 'yes', label: 'Yes' }], custom: false }] });
  f.emit('form.created', sessionID);
}

test('a live wait leaves the shared store available for another workspace bind/adopt/submit/wait', async t => {
  const f = await fixture(t), aChat = 'offline-concurrent-chat-A', bChat = 'offline-concurrent-chat-B';
  const bWorkspace = join(f.root, 'second workspace'), bPlanDir = join(bWorkspace, 'plans');
  mkdirSync(bPlanDir, { recursive: true });
  const bPlan = join(bPlanDir, '002-second.md'), bPacket = join(bWorkspace, 'packet.txt');
  writeFileSync(bPlan, baseline); writeFileSync(bPacket, 'Second isolated no-op assignment.');

  assert.equal((await f.call(bindArgs(f.workspace, f.plan, 4), aChat)).status, 0);
  assert.equal((await f.call(submitArgs(f.workspace, f.plan, f.packet, 'assignment-A'), aChat)).status, 0);
  const aSession = f.state().bindings.find(binding => binding.codexChat === aChat).sessionID;
  const aWaiting = start(f, wait(f.workspace, f.plan), aChat);
  t.after(() => { if (aWaiting.child.exitCode === null) aWaiting.child.kill('SIGKILL'); });
  await until(() => f.streamOpens === 1, 'workspace A did not enter its SSE wait');
  await until(() => !existsSync(join(dirname(f.statePath), 'state.lock')), 'long wait retained the global state lock');
  assert.ok(readdirSync(join(dirname(f.statePath), 'ownership')).length > 0);

  assert.equal((await f.call(bindArgs(bWorkspace, bPlan, 6), bChat)).status, 0);
  const bSession = f.state().bindings.find(binding => binding.codexChat === bChat).sessionID;
  const adopted = await f.call(['adopt', bWorkspace, bPlan, bSession, '--correction-count', '6', '--non-git-baseline', baseline], bChat);
  assert.equal(adopted.status, 0, JSON.stringify(adopted.result)); assert.equal(adopted.result.kind, 'reused');
  assert.equal((await f.call(submitArgs(bWorkspace, bPlan, bPacket, 'assignment-B'), bChat)).status, 0);

  const bWaiting = start(f, wait(bWorkspace, bPlan), bChat);
  t.after(() => { if (bWaiting.child.exitCode === null) bWaiting.child.kill('SIGKILL'); });
  await until(() => f.streamOpens === 2, 'workspace B did not enter its SSE wait');
  addQuestion(f, bSession, 'b');
  const bResult = await bWaiting.done;
  assert.equal(bResult.status, 0, JSON.stringify(bResult.result)); assert.equal(bResult.result.kind, 'question');
  addQuestion(f, aSession, 'a');
  const aResult = await aWaiting.done;
  assert.equal(aResult.status, 0, JSON.stringify(aResult.result)); assert.equal(aResult.result.kind, 'question');

  const state = f.state();
  assert.deepEqual(state.bindings.map(binding => [binding.codexChat, binding.phase]).sort(),
    [[aChat, 'WAITING_FOR_ANSWER'], [bChat, 'WAITING_FOR_ANSWER']].sort());
  assert.deepEqual(state.plans.map(plan => plan.correctionCount).sort((a, b) => a - b), [4, 6]);
  assert.equal(f.posts('/api/session/' + aSession + '/prompt'), 1);
  assert.equal(f.posts('/api/session/' + bSession + '/prompt'), 1);
});

test('simultaneous corrections in different workspaces preserve both counter increments', async t => {
  const f = await fixture(t), chats = ['offline-counter-chat-A', 'offline-counter-chat-B'];
  const bWorkspace = join(f.root, 'counter workspace'), bPlanDir = join(bWorkspace, 'plans');
  mkdirSync(bPlanDir, { recursive: true });
  const bPlan = join(bPlanDir, '003-counter.md'), bPacket = join(bWorkspace, 'packet.txt');
  writeFileSync(bPlan, baseline); writeFileSync(bPacket, 'Second isolated no-op correction.');
  const a = { workspace: f.workspace, plan: f.plan, packet: f.packet };
  const b = { workspace: bWorkspace, plan: bPlan, packet: bPacket };
  assert.equal((await f.call(bindArgs(a.workspace, a.plan, 19), chats[0])).status, 0);
  assert.equal((await f.call(bindArgs(b.workspace, b.plan, 19), chats[1])).status, 0);

  let entered = 0, enterBoth;
  const both = new Promise(resolve => { enterBoth = resolve; });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  f.onRequest = async route => {
    if (route.endsWith('/prompt')) { if (++entered === 2) enterBoth(); await hold; }
  };
  const calls = [a, b].map((item, index) => f.call(
    submitArgs(item.workspace, item.plan, item.packet, 'correction-' + index, 'correction'), chats[index], 15_000));
  const bothReached = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 5000);
    both.then(() => { clearTimeout(timer); resolve(true); });
  });
  const pendingState = f.state();
  release(); f.onRequest = undefined;
  const results = await Promise.all(calls);
  assert.equal(bothReached, true, JSON.stringify(results.map(result => ({ status: result.status, outcome: result.result }))));
  assert.deepEqual(pendingState.plans.map(plan => plan.correctionCount).sort((x, y) => x - y), [20, 20]);
  assert.ok(pendingState.bindings.every(binding => binding.phase === 'STOPPED' && binding.uncertain === 'submit'));
  assert.ok(results.every(result => result.status === 0));
  const finalState = f.state();
  assert.deepEqual(finalState.plans.map(plan => plan.correctionCount).sort((x, y) => x - y), [20, 20]);
  assert.ok(finalState.bindings.every(binding => binding.phase === 'EXECUTING' && !binding.uncertain));
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.route.endsWith('/prompt')).length, 2);
});

test('same-binding concurrent submits and duplicate wait observers cannot create a second writer', async t => {
  const f = await fixture(t), chat = 'offline-same-binding-chat';
  assert.equal((await f.call(bindArgs(f.workspace, f.plan, 0), chat)).status, 0);
  const submit = submitArgs(f.workspace, f.plan, f.packet, 'same-assignment');
  const submitted = await Promise.all([f.call(submit, chat), f.call(submit, chat)]);
  assert.equal(submitted.filter(result => result.status === 0).length, 1);
  const sessionID = f.state().bindings.find(binding => binding.codexChat === chat).sessionID;
  assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);

  const first = start(f, wait(f.workspace, f.plan), chat);
  t.after(() => { if (first.child.exitCode === null) first.child.kill('SIGKILL'); });
  await until(() => f.streamOpens === 1, 'first observer did not enter SSE wait');
  const second = await f.call(wait(f.workspace, f.plan), chat);
  assert.equal(second.status, 1); assert.equal(second.result.diagnostic.category, 'state-locked');
  assert.equal(second.result.stateChange, 'unchanged'); assert.equal(f.streamOpens, 1);
  first.child.kill('SIGKILL'); await first.done;
  const leases = join(dirname(f.statePath), 'ownership');
  assert.ok(existsSync(leases) && readdirSync(leases).length > 0, 'crashed wait lease was removed');
  const afterCrash = await f.call(wait(f.workspace, f.plan), chat);
  assert.equal(afterCrash.status, 1); assert.equal(afterCrash.result.diagnostic.category, 'state-locked');
  assert.equal(f.streamOpens, 1); assert.equal(f.state().bindings.find(binding => binding.codexChat === chat).phase, 'EXECUTING');
});

for (const mode of ['nested non-Git', 'nested Git']) test(mode + ' overlapping workspaces admit at most one concurrent submit', async t => {
  const f = await fixture(t), chats = ['offline-overlap-chat-A', 'offline-overlap-chat-B'];
  if (mode === 'nested Git') execFileSync('git', ['init', '--quiet'], { cwd: f.root, windowsHide: true });
  const bWorkspace = join(f.workspace, 'nested checkout'), bPlanDir = join(bWorkspace, 'plans');
  mkdirSync(bPlanDir, { recursive: true });
  const bPlan = join(bPlanDir, '004-overlap.md'), bPacket = join(bWorkspace, 'packet.txt');
  writeFileSync(bPlan, baseline); writeFileSync(bPacket, 'Nested isolated no-op assignment.');
  assert.equal((await f.call(bindArgs(f.workspace, f.plan, 0), chats[0])).status, 0);
  assert.equal((await f.call(bindArgs(bWorkspace, bPlan, 0), chats[1])).status, 0);
  const submits = await Promise.all([
    f.call(submitArgs(f.workspace, f.plan, f.packet, 'overlap-A'), chats[0]),
    f.call(submitArgs(bWorkspace, bPlan, bPacket, 'overlap-B'), chats[1]),
  ]);
  assert.equal(submits.filter(result => result.status === 0).length, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.route.endsWith('/prompt')).length, 1);
  const state = f.state();
  assert.equal(state.bindings.filter(binding => binding.phase === 'EXECUTING').length, 1);
  assert.equal(state.bindings.filter(binding => binding.phase === 'PREPARING').length, 1);
});

test('crashed submit retains its single reserved cycle and ownership lease', async t => {
  const f = await fixture(t), chat = 'offline-crashed-submit-chat';
  assert.equal((await f.call(bindArgs(f.workspace, f.plan, 19), chat)).status, 0);
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  f.onRequest = async route => { if (route.endsWith('/prompt')) { entered(); await hold; } };
  const child = start(f, submitArgs(f.workspace, f.plan, f.packet, 'crashed-correction', 'correction'), chat);
  await reached;
  const before = readFileSync(f.statePath);
  const uncertain = f.state().bindings.find(binding => binding.codexChat === chat);
  assert.equal(uncertain.phase, 'STOPPED'); assert.equal(uncertain.uncertain, 'submit');
  assert.equal(f.state().plans[0].correctionCount, 20); assert.equal(f.posts('/api/session/' + uncertain.sessionID + '/prompt'), 1);
  child.child.kill('SIGKILL'); await child.done; release(); f.onRequest = undefined;
  const leases = join(dirname(f.statePath), 'ownership');
  assert.ok(existsSync(leases) && readdirSync(leases).length > 0, 'crashed submit lease was removed');
  assert.deepEqual(readFileSync(f.statePath), before);
  const retry = await f.call(submitArgs(f.workspace, f.plan, f.packet, 'crashed-correction', 'correction'), chat);
  assert.equal(retry.status, 1); assert.equal(f.posts('/api/session/' + uncertain.sessionID + '/prompt'), 1);
  assert.deepEqual(readFileSync(f.statePath), before);
});
