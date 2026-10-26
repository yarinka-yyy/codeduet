import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL, localEndpoint, decodeFrame, completed, questionAnswer, proofMessages } from './probe.mjs';

test('only local HTTP registration endpoints receive credentials', () => {
  assert.equal(localEndpoint('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  for (const url of ['https://example.com', 'http://example.com', 'http://localhost@evil.test', 'http://localhost/path', 'http://user:password@localhost']) {
    assert.throws(() => localEndpoint(url));
  }
});

test('SSE accepts native and double-encoded events, not failure envelopes', () => {
  const event = { id: '1', type: 'session.idle', data: { sessionID: 's1' } };
  assert.deepEqual(decodeFrame('event: message\r\ndata: ' + JSON.stringify(event)), event);
  assert.deepEqual(decodeFrame('data: ' + JSON.stringify(JSON.stringify(event))), event);
  assert.equal(decodeFrame(': heartbeat'), null);
  assert.throws(() => decodeFrame('data: {"error":"broken"}'));
});

const state = { messageID: 'msg_1', submittedAt: 100, marker: 'expected' };
const session = { outcome: 'succeeded', time: { idle: 200 } };
const assistant = { id: 'msg_2', type: 'assistant', model: MODEL, finish: 'stop', time: { completed: 190 }, content: [{ type: 'text', text: 'expected; no background operations' }] };
const messages = [{ id: 'msg_1', type: 'user' }, assistant, { id: 'msg_3', type: 'idle', outcome: 'succeeded' }];

test('position cursors on a short page do not imply truncated history', () => {
  assert.deepEqual(proofMessages({ data: messages, cursor: { next: 'position' } }), messages);
  assert.throws(() => proofMessages({ data: Array(50).fill(messages[0]), cursor: { next: 'position' } }));
});

test('completion correlates final response, successful terminal idle and bound model', () => {
  assert.equal(completed(state, session, null, [], messages).messageID, 'msg_2');
  assert.equal(completed(state, session, { type: 'running' }, [], messages), null);
  assert.equal(completed(state, session, null, [{}], messages), null);
  assert.equal(completed(state, { ...session, time: { idle: 99 } }, null, [], messages), null);
  assert.throws(() => completed(state, { ...session, outcome: 'failed' }, null, [], messages));
});

test('old response, wrong provider and missing terminal evidence cannot complete', () => {
  assert.throws(() => completed({ ...state, messageID: 'msg_other' }, session, null, [], messages));
  assert.throws(() => completed({ ...state, marker: 'wrong' }, session, null, [], messages));
  assert.throws(() => completed(state, session, null, [], [messages[0], { ...assistant, model: { ...MODEL, providerID: 'opencode' } }, messages[2]]));
  assert.throws(() => completed(state, session, null, [], messages.slice(0, 2)));
});

test('unfinished/failed tools block review even after final text', () => {
  for (const status of ['running', 'streaming', 'error']) {
    const tool = { ...assistant, content: [{ type: 'tool', state: { status } }, ...assistant.content] };
    assert.throws(() => completed(state, session, null, [], [messages[0], tool, messages[2]]));
  }
});

test('four-choice forms use actual field/option values and allow a custom answer only when supported', () => {
  const form = { fields: [{ key: 'answer_0', type: 'string', custom: true, options: ['Alpha', 'Beta', 'Gamma', 'Delta'].map(value => ({ value })) }] };
  assert.deepEqual(questionAnswer(form, 'selection'), { answer_0: 'Beta' });
  assert.deepEqual(questionAnswer(form, 'custom'), { answer_0: 'CUSTOM_PROOF_001' });
  assert.throws(() => questionAnswer({ fields: [{ ...form.fields[0], custom: false }] }, 'custom'));
});
