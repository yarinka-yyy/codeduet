import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fixture, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { observer } from '../helper/observer.mjs';
import { processOwner } from '../helper/process-owner.mjs';

const chatID = '00000000-0000-4000-8000-000000000025';
const moduleURL = new URL('../helper/observer.mjs', import.meta.url).href;
const connectionURL = new URL('../helper/connection.mjs', import.meta.url).href;

test('killed real worker is explicitly retired by exact process evidence; rearm is exclusive and sends no task', async t => {
  const f = await fixture(t, undefined, '2.2.0'), stateRoot = dirname(f.statePath), sessionID = 'ses_manual';
  f.sessions.set(sessionID, { id: sessionID, location: { directory: f.workspace },
    model: { id: model.id, providerID: model.providerID }, time: {} });
  f.messages.set(sessionID, [{ id: 'msg_manual', type: 'user', text: 'Implement ' + basename(f.plan) }]);
  f.active[sessionID] = { type: 'running' };
  const registrationPath = join(f.home, '.local/state/opencode/service.json');
  let child;
  const o = observer({ stateRoot, chatID, connectEngine: () => connect({ registrationPath }),
    checkCapability: () => ({ path: process.execPath, version: 'fixture', hash: 'fixture' }),
    launch: async id => {
      const source = `import {observer} from ${JSON.stringify(moduleURL)};
        import {connect} from ${JSON.stringify(connectionURL)};
        await observer({stateRoot:${JSON.stringify(stateRoot)},chatID:${JSON.stringify(chatID)},
          connectEngine:()=>connect({registrationPath:${JSON.stringify(registrationPath)}}),
          deliver:async()=>({status:'sent',exitCode:0})}).worker(${JSON.stringify(id)});`;
      child = spawn(process.execPath, ['--input-type=module', '-e', source],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      await once(child, 'spawn');
    } });
  const arm = () => o.arm(f.workspace, f.plan, { codexExe: process.execPath,
    sessionID, messageID: 'msg_manual', timeoutMs: 10000 });
  let error = '';
  try {
    const first = await arm(); child.stderr.on('data', data => { error += data; });
    assert.equal(first.kind, 'observer-armed'); assert.ok(first.started.process.start);
    const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
    const firstDir = join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex'), first.id);
    assert.equal(existsSync(join(firstDir, 'exited.json')), false);
    await assert.rejects(arm(), /EEXIST/);
    const cancelled = await o.cancel(first.id);
    assert.equal(cancelled.exited, true); assert.equal(cancelled.workerOwner.status, 'dead');
    assert.equal(JSON.parse(readFileSync(join(firstDir, 'exited.json'))).kind, 'dead-worker');
    assert.equal(f.active[sessionID].type, 'running');
    assert.equal(existsSync(f.statePath), false);
    const next = await arm(); assert.equal(next.kind, 'observer-armed'); assert.notEqual(next.id, first.id);
    const nextClosed = once(child, 'exit');
    const repeat = await o.cancel(first.id); assert.equal(repeat.id, first.id);
    assert.equal(o.status().id, next.id, 'Old cancellation released a new slot');
    f.finish(sessionID); await nextClosed;
    assert.equal((await o.consume(next.id)).kind, 'external-completed');
    assert.equal(o.status().state, 'absent'); assert.equal(error, '');
    assert.ok(f.calls.every(call => call.method === 'GET'));
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
    }
    if (o.status().id) await o.cancel(o.status().id);
  }
});

test('cancel and consume are serialized; a cancelled receipt never grants a late fresh result', async t => {
  const f = await fixture(t, undefined, '2.2.0'), stateRoot = dirname(f.statePath), sessionID = 'ses_manual';
  f.sessions.set(sessionID, { id: sessionID, location: { directory: f.workspace },
    model: { id: model.id, providerID: model.providerID }, time: {} });
  f.messages.set(sessionID, [{ id: 'msg_manual', type: 'user', text: 'Implement ' + basename(f.plan) }]);
  f.active[sessionID] = { type: 'running' };
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  let worker, releaseRead, readStarted;
  const readPending = new Promise(done => { readStarted = done; });
  const o = observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, version: 'fixture', hash: 'fixture' }),
    deliver: async () => ({ status: 'sent', exitCode: 0 }), launch: async id => { worker = o.worker(id); } });
  const armed = await o.arm(f.workspace, f.plan, { codexExe: process.execPath, sessionID, messageID: 'msg_manual' });
  f.finish(sessionID); await worker;
  f.onRequest = async route => {
    if (route === '/api/session/active' && !releaseRead) {
      await new Promise(done => { releaseRead = done; readStarted(); });
    }
  };
  const consuming = o.consume(armed.id);
  const rejected = assert.rejects(consuming, /cancelled during consume/);
  await readPending; await o.cancel(armed.id); releaseRead(); await rejected;
  const dir = join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex'), armed.id);
  assert.equal(existsSync(join(dir, 'consumed.json')), false);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('unknown worker evidence never unlocks a slot', async t => {
  await Promise.all(['legacy', 'wrong-receipt', 'live'].map(async variant => {
    const f = await fixture(t), stateRoot = dirname(f.statePath), id = '00000000-0000-4000-8000-000000000026';
    const folder = join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex')), dir = join(folder, id);
    mkdirSync(dir, { recursive: true });
    const receipt = JSON.stringify({ schema: 1, id, codexChat: chatID });
    writeFileSync(join(dir, 'receipt.json'), receipt);
    writeFileSync(join(folder, 'active'), JSON.stringify({ id }));
    writeFileSync(join(dir, 'started.json'), JSON.stringify({ pid: process.pid,
      ...(variant !== 'legacy' ? { process: processOwner(), receiptHash: variant === 'wrong-receipt' ? 'wrong' :
        createHash('sha256').update(receipt).digest('hex') } : {}) }));
    const o = observer({ stateRoot, chatID }), before = readFileSync(join(folder, 'active'));
    const result = await o.cancel(id);
    assert.equal(result.exited, false); assert.equal(result.cancelled, true);
    assert.equal(result.workerOwner.status, variant === 'live' ? 'live' : 'unknown');
    assert.deepEqual(readFileSync(join(folder, 'active')), before);
    assert.equal(existsSync(join(dir, 'exited.json')), false);
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.statePath), false);
  }));
});
