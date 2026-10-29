import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect, validateDiagnostic } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { inspectMessages, completion } from '../helper/interaction.mjs';

const privateText = 'PRIVATE_INSTRUCTION_CANARY';
function exchange(workspace, running = false) {
  const path = join(workspace, 'nested', 'AGENTS.md'), now = Date.now() - 10;
  const read = { id: 'tool_read', type: 'tool', name: 'read',
    state: { status: running ? 'running' : 'completed', input: { path: join(workspace, 'nested', 'file.mjs') } },
    time: { ran: now, ...(!running && { completed: now + 2 }) } };
  return [{ id: 'msg_read', type: 'assistant', model,
    time: { created: now - 1, ...(!running && { completed: now + 2 }) }, content: [read] },
  { id: 'msg_instruction', type: 'synthetic', text: 'Instructions from: ' + path + '\n' + privateText,
    metadata: { instruction: { paths: [path] } }, time: { created: now + 1 } }];
}
const workspace = resolve('synthetic-disposable-workspace');
const bound = { messageID: 'msg_user', workspace };
const user = { id: bound.messageID, type: 'user' };

test('native nested instructions correlate while read runs; completion still requires completed tools', () => {
  const records = exchange(workspace, true), history = inspectMessages(bound, [user, ...records]);
  assert.equal(history.tools[0].state.status, 'running');
  const ended = Date.now();
  records[0].time.completed = ended;
  const final = { id: 'msg_final', type: 'assistant', model, finish: 'stop', time: { completed: ended },
    content: [{ type: 'text', text: 'Finished' }] };
  const idle = { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: ended } };
  const terminal = inspectMessages(bound, [user, ...records, final, idle]);
  assert.throws(() => completion(terminal, { time: { idle: ended } }, { data: [] }), /Outstanding\/unknown tool/);
});

const changes = {
  'no metadata': records => { delete records[1].metadata; },
  'other origin': records => { records[1].metadata = { plugin: true }; },
  'extra metadata': records => { records[1].metadata.extra = privateText; },
  'extra instruction field': records => { records[1].metadata.instruction.extra = true; },
  'empty paths': records => { records[1].metadata.instruction.paths = []; },
  'duplicate paths': records => { records[1].metadata.instruction.paths.push(records[1].metadata.instruction.paths[0]); },
  'outside workspace': records => { records[1].metadata.instruction.paths = [resolve(workspace, '..', 'other', 'AGENTS.md')]; },
  'root instructions': records => { records[1].metadata.instruction.paths = [join(workspace, 'AGENTS.md')]; },
  'different filename': records => { records[1].metadata.instruction.paths = [join(workspace, 'nested', 'OTHER.md')]; },
  'relative path': records => { records[1].metadata.instruction.paths = ['nested/AGENTS.md']; },
  'wrong envelope': records => { records[1].text = privateText; },
  'different tool': records => { records[0].content[0].name = 'bash'; },
  'unrelated read': records => { records[0].content[0].state.input.path = join(workspace, 'elsewhere', 'file'); },
  'read AGENTS itself': records => { records[0].content[0].state.input.path = records[1].metadata.instruction.paths[0]; },
  'missing tool start': records => { delete records[0].content[0].time.ran; },
  'input before read': records => { records[1].time.created = records[0].content[0].time.ran - 1; },
  'input after read': records => { records[1].time.created = records[0].content[0].time.completed + 1; },
  'read follows input': records => { records.reverse(); },
  'failed read': records => { records[0].content[0].state.status = 'error'; },
  'invalid text': records => { records[1].text = null; },
  'invalid timestamp': records => { records[1].time.created = -1; },
};
for (const [name, change] of Object.entries(changes)) test('unverified synthetic stays blocked: ' + name, () => {
  const records = exchange(workspace); change(records);
  assert.throws(() => inspectMessages(bound, [user, ...records]), error => {
    assert.equal(error.diagnostic.category, 'history-correlation');
    assert.equal(error.diagnostic.stage, 'history'); assert.equal(error.diagnostic.historyType, 'synthetic');
    assert.match(error.diagnostic.errorCode, /^(UncorrelatedSyntheticInput|InvalidSyntheticInput)$/);
    validateDiagnostic(error.diagnostic);
    assert.ok(!JSON.stringify({ message: error.message, diagnostic: error.diagnostic }).includes(privateText));
    assert.ok(!JSON.stringify(error.diagnostic).includes(workspace)); return true;
  });
});

test('one read can load ordered nested instruction files, but unrelated parallel reads do not authorize input', () => {
  const records = exchange(workspace), second = join(workspace, 'nested', 'deeper', 'AGENTS.md');
  records[0].content[0].state.input.path = join(workspace, 'nested', 'deeper', 'file');
  records[1].metadata.instruction.paths.push(second);
  records[1].text += '\n\nInstructions from: ' + second + '\n' + privateText;
  assert.equal(inspectMessages(bound, [user, ...records]).tools.length, 1);
  records[0].content[0].state.input.path = join(workspace, 'nested', 'other', 'file');
  assert.throws(() => inspectMessages(bound, [user, ...records]), /not correlated/);
});

for (const version of ['2.1.4', '2.2.0', '2.2.1']) test(version + ' wait accepts in-flight instruction load and completes without resending', async t => {
  const f = await fixture(t, undefined, version), client = await connect({
    registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: 'synthetic-fixture' });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'synthetic-correction', f.packet, baseline, 'correction');
  const binding = f.state().bindings[0], records = exchange(f.workspace, true);
  f.messages.get(binding.sessionID).push(...records);
  let observed;
  const snapshot = new Promise(resolve => { observed = resolve; });
  f.onRequest = route => { if (route.includes('/message?')) setTimeout(observed, 25); };
  let settled = false;
  const waiting = adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 3000 }).then(result => {
    settled = true; return result;
  });
  await snapshot; assert.equal(settled, false); assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  const completed = Date.now();
  records[0].content[0].state.status = 'completed'; records[0].content[0].time.completed = completed;
  records[0].time.completed = completed; f.finish(binding.sessionID);
  const result = await waiting;
  assert.equal(result.kind, 'completed-for-review', JSON.stringify(result)); assert.equal(result.phase, 'REVIEWING');
  assert.equal((await adapter.finish(f.workspace, f.plan, baseline)).phase, 'FINISHED');
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.posts('/api/session/' + binding.sessionID + '/prompt'), 1);
  assert.ok(!readFileSync(f.statePath, 'utf8').includes(privateText));
});

test('unmatched synthetic persists truthful STOPPED and cannot trigger a retry or duplicate delivery', async t => {
  const f = await fixture(t, undefined, '2.2.0');
  await f.call(f.bindArgs(8));
  await f.call(f.submitArgs);
  const binding = f.state().bindings[0];
  f.messages.get(binding.sessionID).push({ id: 'msg_external', type: 'synthetic', text: privateText, time: { created: Date.now() } });
  const result = await f.call(['wait', f.workspace, f.plan, '--non-git-baseline', baseline, '--timeout-ms', '3000']);
  assert.equal(result.status, 1); assert.equal(result.result.phase, 'STOPPED');
  assert.equal(result.result.kind, 'history-uncertain'); assert.equal(result.result.diagnostic.category, 'history-correlation');
  assert.equal(result.result.diagnostic.stage, 'history'); assert.equal(result.result.diagnostic.errorCode, 'UncorrelatedSyntheticInput');
  assert.equal(result.result.executorStopped, false); assert.equal(f.state().plans[0].correctionCount, 9);
  const stopped = readFileSync(f.statePath);
  assert.equal((await f.call(['wait', f.workspace, f.plan, '--non-git-baseline', baseline])).result.phase, 'STOPPED');
  const duplicate = await f.call(f.submitArgs);
  assert.equal(duplicate.status, 1); assert.equal(duplicate.result.kind, 'rejected');
  assert.equal(duplicate.result.stateChange, 'unchanged');
  assert.match(duplicate.result.error, /Binding stopped or mutation uncertain; do not retry/);
  assert.equal(f.state().bindings[0].phase, 'STOPPED');
  assert.deepEqual(readFileSync(f.statePath), stopped);
  assert.equal(f.posts('/api/session/' + binding.sessionID + '/prompt'), 1);
  assert.ok(!result.stdout.includes(privateText) && !stopped.includes(Buffer.from(privateText)));
});

test('history diagnostic schema rejects private extensions and unknown type/code', () => {
  const diagnostic = { category: 'history-correlation', stage: 'history', elapsedMs: 0, lastEvent: null,
    historyType: 'synthetic', errorCode: 'UncorrelatedSyntheticInput' };
  validateDiagnostic(diagnostic);
  for (const change of [{ historyType: privateText }, { errorCode: privateText }, { text: privateText }, { category: 'unknown' }]) {
    assert.throws(() => validateDiagnostic({ ...diagnostic, ...change }), /Invalid diagnostic/);
  }
});
