import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, baseline } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { observer } from '../helper/observer.mjs';
import { processOwner, ownerLiveness } from '../helper/process-owner.mjs';

const chatID = '00000000-0000-4000-8000-000000000018';
const cli = fileURLToPath(new URL('../helper/cli.mjs', import.meta.url));
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (check()) return; await delay(20); }
  assert.fail('Disposable foreground did not reach expected checkpoint');
}
async function setup(t) {
  const f = await fixture(t, undefined, '2.2.1'), stateRoot = dirname(f.statePath);
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const client = await connectEngine(), adapter = helper(client, { stateRoot, chatID });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'delivered-correction-nine', f.packet, baseline, 'correction');
  await adapter.connectionLost(new Error('Isolated observation interruption'));
  const saved = f.state().bindings[0];
  const args = ['resume-watch', f.workspace, f.plan, saved.assignmentID, saved.messageID,
    '--session', saved.sessionID, '--timeout-ms', '30000', '--non-git-baseline', baseline];
  let running;
  const sent = [], o = observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
    deliver: async value => { sent.push(value); return { status: 'sent', exitCode: 0 }; },
    launch: async id => { running = o.worker(id); } });
  t.after(async () => { if (o.status().id) await o.cancel(o.status().id); await running; });
  const owners = join(stateRoot, 'ownership');
  return Object.assign(f, { stateRoot, adapter, client, o, sent, saved, args, end: () => running,
    owner: () => { const name = existsSync(owners) && readdirSync(owners).find(name => name.endsWith('.lock'));
      return name ? { path: join(owners, name), value: JSON.parse(readFileSync(join(owners, name), 'utf8')) } : null; },
    command: (token, action = 'inspect') => f.call(['ownership', f.workspace, f.plan, token,
      '--action', action, '--non-git-baseline', baseline], chatID, 25000),
    act: (token, action, adapterOverride = adapter) => adapterOverride.observationOwner(f.workspace, f.plan, token,
      { action, nonGitBaseline: baseline }),
    arm: resume => o.arm(f.workspace, f.plan, { codexExe: process.execPath, nonGitBaseline: baseline, timeoutMs: 10000, resume }) });
}
async function foreground(t, f, console = false) {
  const exe = console ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.execPath;
  const args = console ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./hidden-console.ps1', import.meta.url)), '-NodeExe', process.execPath,
    '-ArgumentsBase64', Buffer.from(JSON.stringify([cli, ...f.args])).toString('base64')] : [cli, ...f.args];
  const child = spawn(exe, args, { windowsHide: true, detached: !console,
    cwd: f.workspace, env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_THREAD_ID: chatID },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => { child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  t.after(async () => {
    if (console && f.owner()) { try { process.kill(f.owner().value.process.pid, 'SIGKILL'); } catch {} }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done;
  });
  await until(() => {
    if (child.exitCode !== null) return true;
    return f.streamOpens && f.state().bindings[0].phase === 'EXECUTING';
  });
  if (child.exitCode !== null) { const result = await done; assert.fail(JSON.stringify(result)); }
  const lease = f.owner(); assert.equal(lease.value.schema, 2);
  if (!console) assert.equal(lease.value.process.pid, child.pid);
  return { child, done, ...lease };
}
function noDeliveryChanges(f, callsFrom = 0) {
  const binding = f.state().bindings[0];
  for (const key of ['sessionID', 'assignmentID', 'messageID', 'submittedAt']) assert.equal(binding[key], f.saved[key]);
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.posts(`/api/session/${binding.sessionID}/prompt`), 1);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
}
test('process evidence handles live, absent, PID reuse, denied query, unknown birth and foreign host', () => {
  const owner = processOwner(); assert.ok(owner.start, 'Real process creation identity unavailable');
  assert.equal(ownerLiveness(owner).status, 'live');
  assert.equal(ownerLiveness(owner, () => ({ state: 'absent' })).status, 'dead');
  assert.deepEqual(ownerLiveness(owner, () => ({ state: 'present', start: owner.start + '0' })), { status: 'dead', reason: 'pid-reused' });
  assert.equal(ownerLiveness(owner, () => { throw new Error('denied'); }).status, 'unknown');
  assert.equal(ownerLiveness({ ...owner, start: null }, () => ({ state: 'present', start: '1' })).status, 'unknown');
  assert.equal(ownerLiveness({ ...owner, host: '0'.repeat(64) }).status, 'unknown');
  assert.equal(ownerLiveness(undefined).reason, 'legacy-owner-unverifiable');
});
for (const route of ['/api/session/active', '/api/session']) test('bind ownership recovery after interruption at ' + route, async t => {
  const f = await fixture(t), stateRoot = dirname(f.statePath), owners = join(stateRoot, 'ownership');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.onRequest = path => path === route ? gate : undefined;
  const child = spawn(process.execPath, [cli, ...f.bindArgs(0)], { cwd: f.workspace, windowsHide: true,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_THREAD_ID: chatID }, stdio: 'ignore' });
  const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  t.after(async () => { release(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  await until(() => f.calls.some(call => call.route === route));
  const [name] = readdirSync(owners), path = join(owners, name);
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(owner.schema, 3);
  assert.equal(owner.operation, 'bind');
  assert.equal(owner.process.pid, child.pid);
  assert.ok(owner.process.start);
  const args = ['ownership', f.workspace, f.plan, owner.token, '--non-git-baseline', baseline, '--action'];
  assert.equal((await f.call([...args, 'inspect'], chatID)).result.ownerStatus, 'live');
  assert.equal((await f.call([...args, 'recover'], chatID)).result.kind, 'rejected');
  child.kill('SIGKILL'); await done; release();
  const before = existsSync(f.statePath) ? readFileSync(f.statePath) : null;
  const from = f.calls.length, recovered = await f.call([...args, 'recover'], chatID);
  assert.equal(recovered.result.kind, 'bind-ownership-released', JSON.stringify(recovered.result));
  assert.equal(recovered.result.ownerStatus, 'dead');
  assert.equal(f.calls.length, from);
  assert.ok(!existsSync(path) && existsSync(join(stateRoot, 'ownership-history', owner.token + '.lock')));
  if (route === '/api/session') {
    assert.deepEqual(readFileSync(f.statePath), before);
    assert.equal(f.state().bindings[0].uncertain, 'create');
    assert.equal(f.state().plans[0].correctionCount, 0);
    assert.equal((await f.call(f.bindArgs(0), chatID)).status, 1);
    assert.equal(f.posts('/api/session'), 1);
  } else {
    assert.equal(existsSync(f.statePath), false);
    assert.equal(f.posts('/api/session'), 0);
    const retry = await f.call(f.bindArgs(0), chatID);
    assert.equal(retry.result.kind, 'created', JSON.stringify(retry.result));
    assert.equal(retry.result.phase, 'PREPARING');
    assert.equal(f.posts('/api/session'), 1);
  }
});
test('submit lease recovers a killed writer while preserving the exact possible prompt and correction', async t => {
  const f = await fixture(t), stateRoot = dirname(f.statePath), owners = join(stateRoot, 'ownership');
  const pair = await f.call(f.bindArgs(0), chatID);
  const route = `/api/session/${pair.result.sessionID}/prompt`;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.onRequest = path => path === route ? gate : undefined;
  const child = spawn(process.execPath, [cli, ...f.submitArgs], { cwd: f.workspace, windowsHide: true,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_THREAD_ID: chatID }, stdio: 'ignore' });
  const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  t.after(async () => { release(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  await until(() => f.posts(route) === 1);
  const [name] = readdirSync(owners), owner = JSON.parse(readFileSync(join(owners, name), 'utf8'));
  assert.equal(owner.operation, 'submit');
  assert.equal(owner.process.pid, child.pid);
  const before = readFileSync(f.statePath), saved = f.state();
  assert.equal(saved.bindings[0].uncertain, 'submit');
  assert.equal(saved.plans[0].correctionCount, 1);
  child.kill('SIGKILL'); await done; release();
  const recovered = await f.call(['ownership', f.workspace, f.plan, owner.token, '--action', 'recover',
    '--non-git-baseline', baseline], chatID);
  assert.equal(recovered.result.kind, 'operation-ownership-released', JSON.stringify(recovered.result));
  assert.equal(recovered.result.messageID, saved.bindings[0].messageID);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal((await f.call(f.submitArgs, chatID)).status, 1);
  assert.equal(f.posts(route), 1);
});

for (const operation of ['adopt', 'reply', 'next', 'finish', 'close', 'transition']) {
  const stages = operation === 'reply' ? ['leased', 'saved', 'acknowledged'] : ['leased', 'saved'];
  for (const stage of stages) test(operation + ' retains exact state after SIGKILL at ' + stage, async t => {
    const f = await fixture(t, undefined, '2.2.5'), stateRoot = dirname(f.statePath);
    const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
    const adapter = helper(await connectEngine(), { stateRoot, chatID });
    const ownerDir = join(stateRoot, 'ownership'), baselineArgs = ['--non-git-baseline', baseline];
    const work = [f.workspace, f.plan];
    let args, delivery;
    if (operation === 'adopt') {
      const id = 'ses_existing';
      f.sessions.set(id, { id, location: { directory: f.workspace }, time: {},
        model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' } });
      args = ['adopt', ...work, id, '--correction-count', '8'];
    } else {
      await adapter.bind(...work, baseline, 8);
      delivery = await adapter.submit(...work, 'before-crash', f.packet, baseline);
      const { sessionID, messageID, assignmentID } = delivery;
      if (operation === 'reply') {
        f.messages.get(sessionID).push({ id: 'msg_question', type: 'assistant', model: f.models[0], time: { created: Date.now() },
          content: [{ type: 'tool', id: 'call_question', name: 'question', time: { created: Date.now() },
            state: { status: 'running', input: {} } }] });
        f.forms = [{ id: 'frm_question', sessionID, title: 'Test choice',
          metadata: { kind: 'question', tool: { messageID: 'msg_question', id: 'call_question' } },
          fields: [{ key: 'q0', type: 'string', title: 'Test choice', custom: true }] }];
        assert.equal((await adapter.wait(...work, { nonGitBaseline: baseline, once: true })).kind, 'question');
        const answer = join(f.workspace, 'answer.json');
        writeFileSync(answer, JSON.stringify({ answer: { q0: 'ok' } }));
        args = ['reply', ...work, 'question', 'frm_question', answer];
      } else {
        if (operation === 'close') await adapter.connectionLost(new Error('Isolated observation interruption'));
        f.finish(sessionID);
        if (operation !== 'close') assert.equal((await adapter.wait(...work, { nonGitBaseline: baseline, once: true })).phase, 'REVIEWING');
        args = { next: ['next', ...work, 'block'], finish: ['finish', ...work],
          close: ['close-assignment', ...work, assignmentID, messageID, '--session', sessionID],
          transition: ['transition', ...work, messageID, 'accepted'] }[operation];
      }
    }
    const previous = existsSync(f.statePath) ? readFileSync(f.statePath) : null;
    const from = f.calls.length;
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const [cli, owners, state, stage, ...args] = process.argv.slice(2);
      const rename = fs.renameSync;
      let stateWrites = 0;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (to === state) stateWrites++;
        const halt = stage === 'leased' ? to.startsWith(owners) && to.endsWith('.lock') :
          to === state && stateWrites === (stage === 'acknowledged' ? 2 : 1);
        if (halt) {
          process.stdout.write('crash-ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      };
      syncBuiltinESMExports();
      process.argv = [process.execPath, cli, ...args];
      await import(pathToFileURL(cli));
    `;
    const harness = join(f.root, 'crash.mjs');
    writeFileSync(harness, source);
    const child = spawn(process.execPath, [harness, cli, ownerDir, f.statePath, stage, ...args, ...baselineArgs],
      { cwd: f.workspace, windowsHide: true, env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_THREAD_ID: chatID },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
    const event = await Promise.race([new Promise(resolve => child.stdout.once('data', resolve)), done.then(() => assert.fail(stderr))]);
    assert.equal(String(event), 'crash-ready');
    const [name] = readdirSync(ownerDir).filter(value => value.endsWith('.lock'));
    const owner = JSON.parse(readFileSync(join(ownerDir, name), 'utf8'));
    assert.equal(owner.operation, operation);
    assert.equal(owner.process.pid, child.pid);
    const saved = existsSync(f.statePath) ? readFileSync(f.statePath) : null;
    if (stage === 'leased') assert.deepEqual(saved, previous);
    else assert.notDeepEqual(saved, previous);
    child.kill('SIGKILL');
    await done;
    const lock = (await f.call(['state-lock'], chatID)).result;
    assert.equal(lock.ownerStatus, 'dead');
    assert.equal((await f.call(['state-lock', lock.token], chatID)).result.kind, 'state-lock-released');
    const recovered = (await f.call(['ownership', ...work, owner.token, '--action', 'recover', ...baselineArgs], chatID)).result;
    assert.equal(recovered.kind, 'operation-ownership-released', JSON.stringify(recovered));
    if (delivery) {
      assert.equal(recovered.messageID, delivery.messageID);
      assert.equal(recovered.correctionCount, 8);
    }
    if (operation === 'reply' && stage !== 'leased') assert.equal(recovered.uncertain, 'reply');
    assert.deepEqual(existsSync(f.statePath) ? readFileSync(f.statePath) : null, saved);
    const mutations = () => f.calls.slice(from).filter(call => call.method === 'POST').length;
    if (stage === 'acknowledged') {
      assert.equal(f.state().bindings[0].intent.acknowledged, true);
      const verified = await adapter.reconcile(...work, baseline);
      assert.equal(verified.kind, 'mutation-reconciled');
      assert.equal(verified.phase, 'EXECUTING');
      assert.equal(verified.correctionCount, 8);
      assert.equal(mutations(), 1);
    } else assert.equal(mutations(), 0);
  });
}

test('normal foreground completion releases ownership and preserves correction nine', async t => {
  const f = await setup(t), from = f.calls.length, run = await foreground(t, f);
  f.finish(f.saved.sessionID); const result = await run.done;
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).kind, 'completed-for-review');
  assert.equal(f.owner(), null); noDeliveryChanges(f, from);
});
test('actual Windows console Ctrl+C reaches the handler and releases resume-watch lease', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t), from = f.calls.length, run = await foreground(t, f, true);
  await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./console-interrupt.ps1', import.meta.url)),
      '-TargetProcess', String(run.value.process.pid)], { windowsHide: true, timeout: 10000 });
  const result = await run.done; assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout || result.stderr).kind, 'interrupted');
  assert.equal(f.owner(), null); assert.equal(f.state().bindings[0].phase, 'STOPPED'); noDeliveryChanges(f, from);
});
test('cooperative stop is local, releases the live foreground, then explicit observer resume uses fresh gate', async t => {
  const f = await setup(t), from = f.calls.length, run = await foreground(t, f);
  const status = await f.command(run.value.token); assert.equal(status.result.ownerStatus, 'live');
  const refused = await f.command(run.value.token, 'recover'); assert.equal(refused.status, 1);
  const stopped = await f.command(run.value.token, 'stop'); assert.equal(stopped.result.kind, 'observation-released');
  assert.equal((await run.done).code, 1); assert.equal(f.state().bindings[0].phase, 'STOPPED');
  const armed = await f.arm(true); assert.equal(armed.kind, 'observer-armed'); assert.equal(armed.endTurn, true);
  f.finish(f.saved.sessionID); await f.end(); assert.equal(f.sent.length, 1);
  assert.equal((await f.o.consume(armed.id)).kind, 'completed-for-review'); noDeliveryChanges(f, from);
});
for (const signal of ['SIGINT', 'SIGKILL']) test('forced process termination ' + signal + ' retains lease, proven-dead recovery archives it without state writes', async t => {
  const f = await setup(t), from = f.calls.length, run = await foreground(t, f);
  run.child.kill(signal); await run.done;
  if (process.platform !== 'win32' && signal === 'SIGINT') { assert.equal(f.owner(), null); return; }
  assert.ok(f.owner()); const before = readFileSync(f.statePath);
  const recovered = await f.command(run.value.token, 'recover');
  assert.equal(recovered.result.ownerStatus, 'dead'); assert.equal(recovered.result.kind, 'observation-released');
  assert.deepEqual(readFileSync(f.statePath), before); assert.equal(f.owner(), null);
  assert.ok(existsSync(join(f.stateRoot, 'ownership-history', run.value.token + '.lock')));
  const armed = await f.arm(false); f.finish(f.saved.sessionID); await f.end();
  assert.equal((await f.o.consume(armed.id)).kind, 'completed-for-review'); noDeliveryChanges(f, from);
});
test('legacy lease without PID remains unknown; inspect/stop/recover cannot retire it', async t => {
  const f = await setup(t), run = await foreground(t, f); run.child.kill('SIGKILL'); await run.done;
  const legacy = { ...run.value, schema: 1 }; delete legacy.process; delete legacy.messageID; delete legacy.fingerprint;
  writeFileSync(run.path, JSON.stringify(legacy));
  const before = readFileSync(f.statePath), leaseBefore = readFileSync(run.path), from = f.calls.length;
  for (const action of ['inspect', 'stop', 'recover']) {
    const result = await f.command(legacy.token, action); assert.equal(result.result.ownerStatus, 'unknown');
    assert.equal(result.result.reason, 'legacy-owner-unverifiable');
    assert.equal(result.result.legacyEvidence.supportedRecovery, false);
    assert.ok(result.result.legacyEvidence.missing.includes('exact lease-token acquisition by that process'));
    assert.equal(result.status, action === 'inspect' ? 0 : 1);
  }
  assert.deepEqual(readFileSync(f.statePath), before); assert.deepEqual(readFileSync(run.path), leaseBefore);
  assert.equal(f.calls.length, from); noDeliveryChanges(f, from);
});
test('unavailable process query and another chat cannot release a lease or change state', async t => {
  const f = await setup(t), run = await foreground(t, f); run.child.kill('SIGKILL'); await run.done;
  const before = readFileSync(f.statePath), from = f.calls.length;
  const unknown = helper(null, { stateRoot: f.stateRoot, chatID, probeOwner: () => ({ state: 'unknown' }) });
  assert.equal((await f.act(run.value.token, 'recover', unknown)).kind, 'rejected');
  const foreign = helper(null, { stateRoot: f.stateRoot, chatID: 'another-chat' });
  await assert.rejects(f.act(run.value.token, 'recover', foreign), /another chat/);
  assert.deepEqual(readFileSync(f.statePath), before); assert.ok(f.owner()); noDeliveryChanges(f, from);
});
test('two concurrent recoveries and arms admit one archive and one observer only', async t => {
  const f = await setup(t), run = await foreground(t, f); run.child.kill('SIGKILL'); await run.done;
  const before = readFileSync(f.statePath), from = f.calls.length;
  const results = await Promise.all([f.command(run.value.token, 'recover'), f.command(run.value.token, 'recover')]);
  assert.equal(results.filter(value => value.result.kind === 'observation-released').length, 1, JSON.stringify(results.map(x => x.result)));
  assert.deepEqual(readFileSync(f.statePath), before);
  const arms = await Promise.allSettled([f.arm(false), f.arm(false)]);
  assert.equal(arms.filter(value => value.status === 'fulfilled').length, 1);
  f.finish(f.saved.sessionID); await f.end(); assert.equal(f.sent.length, 1);
  await f.o.consume(arms.find(value => value.status === 'fulfilled').value.id); noDeliveryChanges(f, from);
});
test('recovery preserves STOPPED and uncertain mutation; observer stays forbidden', async t => {
  const f = await setup(t), run = await foreground(t, f); run.child.kill('SIGKILL'); await run.done;
  const state = f.state(); state.bindings[0].phase = 'STOPPED'; state.bindings[0].uncertain = 'submit';
  writeFileSync(f.statePath, JSON.stringify(state)); const before = readFileSync(f.statePath), from = f.calls.length;
  const inspected = await f.command(run.value.token); assert.equal(inspected.status, 0);
  const recovered = await f.command(run.value.token, 'recover'); assert.equal(recovered.status, 0);
  assert.equal(recovered.result.kind, 'observation-released');
  assert.deepEqual(readFileSync(f.statePath), before); await assert.rejects(f.arm(true), /eligible delivered/);
  assert.equal(f.sent.length, 0); noDeliveryChanges(f, from);
});
test('an existing unknown lease fails startup explicitly, retains its slot and never claims armed', async t => {
  const f = await setup(t), run = await foreground(t, f); run.child.kill('SIGKILL'); await run.done;
  const legacy = { ...run.value, schema: 1 }; delete legacy.process; delete legacy.messageID; delete legacy.fingerprint;
  writeFileSync(run.path, JSON.stringify(legacy)); const before = readFileSync(f.statePath), from = f.calls.length;
  const failed = await f.arm(false);
  assert.equal(failed.kind, 'observer-start-failed'); assert.equal(failed.endTurn, false);
  assert.equal(failed.result.diagnostic.category, 'state-locked'); assert.equal(failed.ready, false);
  await assert.rejects(f.arm(false), /EEXIST/);
  assert.deepEqual(readFileSync(f.statePath), before); assert.deepEqual(JSON.parse(readFileSync(run.path)), legacy);
  noDeliveryChanges(f, from);
});
test('counter changed before or during recovery never retires the exact lease', async t => {
  const f = await setup(t), run = await foreground(t, f); run.child.kill('SIGKILL'); await run.done;
  const before = readFileSync(f.statePath);
  const changeCounter = () => { const state = f.state(); state.plans[0].correctionCount = 10;
    writeFileSync(f.statePath, JSON.stringify(state)); return { state: 'absent' }; };
  const adapter = helper(null, { stateRoot: f.stateRoot, chatID, probeOwner: changeCounter });
  await assert.rejects(f.act(run.value.token, 'recover', adapter), /pins\/count changed/);
  assert.ok(f.owner()); assert.equal(f.state().plans[0].correctionCount, 10);
  await assert.rejects(f.act(run.value.token, 'recover'), /pins\/count changed/);
  writeFileSync(f.statePath, before);
});
