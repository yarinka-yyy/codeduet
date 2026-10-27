import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET, READY, snapshot, assertIdle } from './probe.mjs';

const rows = [
  { type: 'session_meta', payload: { id: TARGET } },
  { type: 'turn_context', payload: { model: 'proof-model', effort: 'high', cwd: 'C:/test/codeduet-wakeup-proof-016' } },
  { type: 'event_msg', payload: { type: 'task_started' } },
  { type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: READY }] } },
  { type: 'token_usage_record', payload: {} },
  { type: 'event_msg', payload: { type: 'task_complete' } },
];
const encode = values => values.map(value => JSON.stringify(value)).join('\n');
test('idle proof counts persisted turns and usage, excludes transcript contents', () => {
  const baseline = snapshot(encode(rows));
  assertIdle(baseline, snapshot(encode(rows)));
  assert.equal(baseline.starts, 1);
  assert.equal(baseline.usageRecords, 1);
  assert.deepEqual(baseline.markers, [READY]);
});
test('refuses wrong chat, unfinished initial turn, extra turn or usage during idle', () => {
  assert.throws(() => snapshot(encode([{ type: 'session_meta', payload: { id: 'production-chat' } }])));
  const before = snapshot(encode(rows));
  assert.throws(() => assertIdle(before, snapshot(encode([...rows, { type: 'event_msg', payload: { type: 'task_started' } }]))));
  assert.throws(() => assertIdle(before, snapshot(encode([...rows, { type: 'token_usage_record', payload: {} }]))));
  assert.throws(() => assertIdle(snapshot(encode(rows.slice(0, -1))), before));
});
