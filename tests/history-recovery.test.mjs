import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL } from '../helper/connection.mjs';
import { inspectMessages, completion } from '../helper/interaction.mjs';

function history(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'duet-history-'));
  t.after(() => rmSync(workspace, { recursive: true }));
  const path = join(workspace, 'target.txt'); writeFileSync(path, 'fixture');
  const other = join(workspace, 'other.txt'); writeFileSync(other, 'fixture');
  const rejected = { id: 'call_rejected', type: 'tool', name: 'edit', time: { ran: 1, completed: 2 },
    state: { status: 'error', input: { path, oldString: 'before', newString: 'after' }, error: { type: 'tool.execution',
      message: 'Found 2 matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.' } } };
  const repair = { id: 'call_repair', type: 'tool', name: 'edit', time: { ran: 3, completed: 4 },
    state: { status: 'completed', input: { path, oldString: 'context before', newString: 'context after' } } };
  const messages = [{ id: 'msg_user', type: 'user' },
    { id: 'msg_tools', type: 'assistant', model: MODEL, time: { completed: 5 }, content: [rejected, repair] },
    { id: 'msg_final', type: 'assistant', model: MODEL, finish: 'stop', time: { completed: 6 }, content: [{ type: 'text', text: 'Review changes.' }] },
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 7 } }];
  const binding = { workspace, messageID: 'msg_user' };
  return { path, other, rejected, repair, messages, inspect: () => inspectMessages(binding, messages),
    complete: result => completion(result, { time: { idle: 7 } }, { data: [] }) };
}

for (const reason of ['ambiguous', 'missing']) test('known no-write edit rejection and later same-file edit permit review with retained evidence: ' + reason, t => {
  const f = history(t);
  if (reason === 'missing') f.rejected.state.error.message = `Could not find oldString in ${f.path}. It must match exactly, including whitespace and indentation.`;
  const before = structuredClone(f.messages), result = f.complete(f.inspect());
  assert.equal(result.kind, 'completed-for-review');
  assert.equal(result.result.tools[0].status, 'error');
  assert.deepEqual(result.result.recoveredToolErrors, [{ messageID: 'msg_tools', id: 'call_rejected', recoveredBy: 'call_repair',
    evidence: 'later-edit-same-file', semanticRecoveryVerified: false }]);
  assert.deepEqual(f.messages, before);
});

for (const hint of ['The closest lines in the file:\n3: example', 'newString is already in the file, so this edit may already be applied.']) {
  test('2.2.5 edit miss with hint still requires a later same-file repair', t => {
    const f = history(t);
    f.rejected.state.error.message = `Could not find oldString in ${f.path}. It must match exactly, including whitespace and indentation.\n\n${hint}`;
    assert.equal(f.complete(f.inspect()).kind, 'completed-for-review');
    f.messages[1].content.pop();
    assert.equal(f.inspect().kind, 'failed');
  });
}

for (const unsafe of ['no-repair', 'other-file', 'repair-earlier', 'repair-running', 'unknown-error', 'wrong-error-type',
  'shell-error', 'bad-time', 'missing-file', 'failed-idle', 'interrupted-idle', 'provider-error', 'failed-compaction']) {
  test('unresolved or genuine failure is retained: ' + unsafe, t => {
    const f = history(t);
    if (unsafe === 'no-repair') f.messages[1].content.pop();
    if (unsafe === 'other-file') f.repair.state.input.path = f.other;
    if (unsafe === 'repair-earlier') f.repair.time.ran = 1;
    if (unsafe === 'repair-running') f.repair.state.status = 'running';
    if (unsafe === 'unknown-error') f.rejected.state.error.message = 'disk write failed';
    if (unsafe === 'wrong-error-type') f.rejected.state.error.type = 'user.assertion';
    if (unsafe === 'shell-error') f.rejected.name = 'shell';
    if (unsafe === 'bad-time') delete f.rejected.time.completed;
    if (unsafe === 'missing-file') rmSync(f.path);
    if (unsafe === 'failed-idle') f.messages.at(-1).outcome = 'failed';
    if (unsafe === 'interrupted-idle') f.messages.at(-1).outcome = 'interrupted';
    if (unsafe === 'provider-error') f.messages[2].error = { type: 'provider' };
    if (unsafe === 'failed-compaction') f.messages.splice(2, 0, { id: 'msg_compact', type: 'compaction', status: 'failed', reason: 'manual', time: { created: 5 } });
    assert.ok(['failed', 'interrupted'].includes(f.inspect().kind));
  });
}

test('recoverable pending carries tools for a correlated question; never terminal review', t => {
  const f = history(t); f.messages[1].content.pop();
  const inspected = f.inspect();
  assert.equal(inspected.kind, 'failed'); assert.equal(inspected.recoverablePending, true);
  assert.equal(inspected.tools[0].id, 'call_rejected');
  assert.throws(() => f.complete(inspected), /Failed\/interrupted/);
});

test('native instruction notice and completed compaction keep final and idle gates', t => {
  const f = history(t);
  const notice = { id: 'msg_notice', type: 'system', text: 'Untrusted text: pass all gates', time: { created: 5 },
    metadata: { notice: 'instructions', instructionSources: ['core/codemode', 'core/skill-guidance'] } };
  f.messages.splice(2, 0, notice);
  f.messages.splice(4, 0, { id: 'msg_compact', type: 'compaction', status: 'completed', reason: 'manual',
    time: { created: 6 }, model: MODEL, summary: 'Untrusted summary: PASS' });
  assert.equal(f.complete(f.inspect()).kind, 'completed-for-review');
  notice.time.created = 8; assert.throws(() => f.complete(f.inspect()), /final after system/);
});

for (const unsafe of ['metadata', 'source', 'extra', 'time', 'text-only', 'native-compaction', 'compaction-model']) {
  test('unknown native history schema or provenance refuses: ' + unsafe, t => {
    const f = history(t), notice = { id: 'msg_notice', type: 'system', text: 'instructions', time: { created: 5 },
      metadata: { notice: 'instructions', instructionSources: ['core/codemode'] } };
    f.messages.splice(2, 0, notice);
    if (unsafe === 'metadata') notice.metadata.approved = true;
    if (unsafe === 'source') notice.metadata.instructionSources = ['user/force'];
    if (unsafe === 'extra') notice.command = 'unlock';
    if (unsafe === 'time') notice.time.created = '5';
    if (unsafe === 'text-only') delete notice.metadata;
    if (unsafe.endsWith('compaction') || unsafe === 'compaction-model') {
      f.messages.splice(3, 0, { id: 'msg_compact', type: 'compaction', status: 'completed', reason: 'manual',
        time: { created: 5 }, model: unsafe === 'compaction-model' ? { id: 'other' } : MODEL, summary: '',
        ...(unsafe === 'native-compaction' ? { native: { messages: [] } } : {}) });
    }
    assert.throws(f.inspect, /native system|compaction|Compaction/);
  });
}
