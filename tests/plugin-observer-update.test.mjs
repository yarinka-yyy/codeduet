import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, baseline } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { packageSkill } from '../tools/package.mjs';

test('two blocks survive a lost correction acknowledgement, SSE drop and replacement of the observer package', async t => {
  const f = await fixture(t), stateRoot = dirname(f.statePath);
  const chatID = '00000000-0000-4000-8000-000000000071';
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(await connectEngine(), { stateRoot, chatID });
  const { sessionID } = await adapter.bind(f.workspace, f.plan, baseline, 0);
  const wait = () => adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 10000 });
  const submit = (id, kind) => adapter.submit(f.workspace, f.plan, id, f.packet, baseline, kind);
  const initial = await submit('block-one', 'initial');
  f.messages.get(sessionID).push({ id: 'msg_choice', type: 'assistant', model: f.models[0],
    time: { created: Date.now() }, content: [{ id: 'call_choice', type: 'tool', name: 'question',
      time: { created: Date.now() }, state: { status: 'running', input: {} } }] });
  f.forms = [{ id: 'frm_choice', sessionID, title: 'Check this fixture',
    fields: [{ key: 'q0', title: 'Confirm', type: 'string', custom: true }],
    metadata: { kind: 'question', tool: { id: 'call_choice', messageID: 'msg_choice' } } }];
  assert.equal((await wait()).kind, 'question');
  assert.equal((await adapter.reply(f.workspace, f.plan, 'question', 'frm_choice', { answer: { q0: 'Yes' } }, baseline)).kind, 'replied');
  f.finish(sessionID);
  assert.equal((await wait()).messageID, initial.messageID);
  await adapter.next(f.workspace, f.plan, 'correction', baseline);
  f.fault = 'prompt-ack-lost';
  await assert.rejects(submit('block-one-fix', 'correction'), /mutation uncertain/);
  f.fault = null;
  const reconciled = await adapter.reconcile(f.workspace, f.plan, baseline);
  assert.equal(reconciled.kind, 'mutation-reconciled');
  assert.equal(reconciled.correctionCount, 1);
  const before = readFileSync(f.statePath), parent = join(f.root, 'old-plugin');
  mkdirSync(parent);
  const oldSkill = join(parent, 'code-duet'); packageSkill(oldSkill);
  const oldObserver = await import(pathToFileURL(join(oldSkill, 'helper/observer.mjs')).href);
  let child, message, workerError = '';
  const instance = oldObserver.observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
    launch: async id => {
      const receiptDir = join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex'), id);
      const snapshot = join(receiptDir, 'code-duet');
      const source = `import {observer,wakeHint} from ${JSON.stringify(pathToFileURL(join(snapshot, 'helper/observer.mjs')).href)};
        import {connect} from ${JSON.stringify(pathToFileURL(join(snapshot, 'helper/connection.mjs')).href)};
        await observer({stateRoot:${JSON.stringify(stateRoot)},chatID:${JSON.stringify(chatID)},
          connectEngine:()=>connect({registrationPath:${JSON.stringify(join(f.home, '.local/state/opencode/service.json'))}}),
          deliver:async()=>{process.send({hint:wakeHint(${JSON.stringify(id)})});return {status:'sent',exitCode:0}}}).worker(${JSON.stringify(id)});`;
      child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      child.stderr.on('data', data => { workerError += data; });
      child.on('message', value => { message = value; });
      await once(child, 'spawn');
    } });
  const armed = await instance.arm(f.workspace, f.plan, { codexExe: process.execPath, nonGitBaseline: baseline, timeoutMs: 10000 });
  assert.equal(armed.kind, 'observer-armed');
  assert.ok(resolve(oldSkill).startsWith(resolve(f.root) + sep));
  rmSync(oldSkill, { recursive: true });
  assert.deepEqual(readFileSync(f.statePath), before);
  f.finish(sessionID);
  for (const stream of f.streams) stream.destroy();
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, workerError);
  assert.ok(message.hint.includes(JSON.stringify(join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex'), armed.id, 'code-duet', 'SKILL.md'))));
  const previous = JSON.parse(before), currentState = f.state();
  for (const key of ['codexChat', 'workspace', 'planPath', 'sessionID', 'assignmentID', 'messageID'])
    assert.equal(currentState.bindings[0][key], previous.bindings[0][key], key);
  const current = await import('../helper/observer.mjs');
  const consumer = current.observer({ stateRoot, chatID, connectEngine });
  const fixed = await consumer.consume(armed.id);
  assert.equal(fixed.kind, 'completed-for-review');
  assert.equal(fixed.messageID, reconciled.messageID);
  assert.equal(f.state().plans[0].correctionCount, 1);
  await adapter.next(f.workspace, f.plan, 'block', baseline);
  const second = await submit('block-two', 'block');
  f.finish(sessionID);
  assert.equal((await wait()).messageID, second.messageID);
  assert.equal((await adapter.finish(f.workspace, f.plan, baseline)).phase, 'FINISHED');
  const index = join(dirname(f.plan), 'README.md');
  appendFileSync(f.plan, `\n\n## Review checkpoint\n\n<!-- code-duet-accepted ${fixed.messageID} -->\n<!-- code-duet-accepted ${second.messageID} -->\n`);
  writeFileSync(index, '| [001](001-test.md) | Fixture | DONE |\n');
  for (const id of [fixed.messageID, second.messageID]) {
    const { result } = await f.call(['acceptance-status', f.workspace, f.plan, id, '--index', index], chatID);
    assert.equal(result.runtimeRecorded, true);
    assert.equal(result.checkpointRecorded, true);
    assert.equal(result.indexStatus, 'DONE');
    assert.equal(result.correctionCount, 1);
  }
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.route), [
    '/api/session', `/api/session/${sessionID}/prompt`, `/api/session/${sessionID}/form/frm_choice/reply`,
    `/api/session/${sessionID}/prompt`, `/api/session/${sessionID}/prompt`,
  ]);
});

test('an incomplete old package fails before starting an observer or changing a binding', async t => {
  const f = await fixture(t), stateRoot = dirname(f.statePath);
  const chatID = '00000000-0000-4000-8000-000000000072';
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(await connectEngine(), { stateRoot, chatID });
  await adapter.bind(f.workspace, f.plan, baseline, 2);
  await adapter.submit(f.workspace, f.plan, 'incomplete-package', f.packet, baseline, 'correction');
  const parent = join(f.root, 'damaged-plugin'); mkdirSync(parent);
  const oldSkill = join(parent, 'code-duet'); packageSkill(oldSkill);
  const module = await import(pathToFileURL(join(oldSkill, 'helper/observer.mjs')).href);
  const missing = join(oldSkill, 'references', 'workflow.md');
  assert.ok(resolve(missing).startsWith(resolve(f.root) + sep));
  rmSync(missing);
  let launched = false;
  const o = module.observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
    launch: async () => { launched = true; } });
  const before = readFileSync(f.statePath);
  await assert.rejects(o.arm(f.workspace, f.plan, { codexExe: process.execPath, nonGitBaseline: baseline }), /ENOENT/);
  assert.equal(launched, false);
  assert.equal(o.status().state, 'absent');
  assert.deepEqual(readFileSync(f.statePath), before);
});

test('a replaced observer module is refused before starting or changing a binding', async t => {
  const f = await fixture(t), stateRoot = dirname(f.statePath);
  const chatID = '00000000-0000-4000-8000-000000000074';
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(await connectEngine(), { stateRoot, chatID });
  await adapter.bind(f.workspace, f.plan, baseline, 2);
  await adapter.submit(f.workspace, f.plan, 'changed-package', f.packet, baseline, 'correction');
  const parent = join(f.root, 'replaced-plugin'); mkdirSync(parent);
  const oldSkill = join(parent, 'code-duet'); packageSkill(oldSkill);
  const observerPath = join(oldSkill, 'helper', 'observer.mjs');
  const module = await import(pathToFileURL(observerPath).href);
  appendFileSync(observerPath, '\n// fixture replacement\n');
  let launched = false;
  const o = module.observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
    launch: async () => { launched = true; } });
  const before = readFileSync(f.statePath);
  await assert.rejects(o.arm(f.workspace, f.plan, { codexExe: process.execPath, nonGitBaseline: baseline }), /package changed before startup/);
  assert.equal(launched, false); assert.equal(o.status().state, 'absent');
  assert.deepEqual(readFileSync(f.statePath), before);
});
