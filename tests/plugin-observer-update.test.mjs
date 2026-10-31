import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, baseline } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { packageSkill } from '../tools/package.mjs';

test('running observer survives removal of old plugin and retains its exact task binding', async t => {
  const f = await fixture(t), stateRoot = dirname(f.statePath);
  const chatID = '00000000-0000-4000-8000-000000000071';
  const connectEngine = () => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(await connectEngine(), { stateRoot, chatID });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'update-fixture', f.packet, baseline, 'correction');
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
  f.finish(f.state().bindings[0].sessionID);
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, workerError);
  assert.ok(message.hint.includes(JSON.stringify(join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex'), armed.id, 'code-duet', 'SKILL.md'))));
  const previous = JSON.parse(before), currentState = f.state();
  for (const key of ['codexChat', 'workspace', 'planPath', 'sessionID', 'assignmentID', 'messageID'])
    assert.equal(currentState.bindings[0][key], previous.bindings[0][key], key);
  const current = await import('../helper/observer.mjs');
  const consumer = current.observer({ stateRoot, chatID, connectEngine });
  assert.equal((await consumer.consume(armed.id)).kind, 'completed-for-review');
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.posts(`/api/session/${f.state().bindings[0].sessionID}/prompt`), 1);
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
