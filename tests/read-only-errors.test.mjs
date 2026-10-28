import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL } from '../helper/connection.mjs';
import { inspectMessages, completion } from '../helper/interaction.mjs';

function exchange() {
  const read = { type: 'tool', id: 'call_read', name: 'read', time: { ran: 1, completed: 2 },
    state: { status: 'error', input: { path: 'PRIVATE_PATH' },
      error: { type: 'unknown', message: 'Cannot read binary file: PRIVATE_PATH' } } };
  const web = { type: 'tool', id: 'call_web', name: 'webfetch', time: { ran: 3, completed: 4 },
    state: { status: 'error', input: { url: 'https://example.com/PRIVATE_QUERY' },
      error: { type: 'unknown', message: 'StatusCode: non 2xx status code (429 GET https://example.com/PRIVATE_QUERY)' } } };
  const fallback = { type: 'tool', id: 'call_fallback', name: 'shell', time: { ran: 5, completed: 6 },
    state: { status: 'completed', input: { command: 'Get-Content PRIVATE_PATH -Encoding Unicode' },
      metadata: { status: 'completed', exit: 0 }, text: '\0garbled\0output' } };
  const messages = [{ type: 'user', id: 'msg_user' },
    { type: 'assistant', id: 'msg_tools', model: MODEL, time: { completed: 7 }, content: [read, web, fallback] },
    { type: 'assistant', id: 'msg_final', model: MODEL, finish: 'stop', time: { completed: 8 },
      content: [{ type: 'text', text: 'Ready for independent review.' }] },
    { type: 'idle', id: 'msg_idle', outcome: 'succeeded', time: { created: 9 } }];
  return { messages, read, web, fallback, inspect: () => inspectMessages({ messageID: 'msg_user' }, messages),
    complete: history => completion(history, { time: { idle: 9 } }, { data: [] }) };
}

test('binary read and GET 429 permit review, retain every warning and never certify a garbled exit-zero fallback', () => {
  const f = exchange(), before = structuredClone(f.messages), history = f.inspect(), result = f.complete(history);
  assert.equal(history.kind, undefined); assert.equal(result.kind, 'completed-for-review');
  assert.deepEqual(history.recoveredToolErrors, []);
  assert.deepEqual(result.result.toolErrors.map(e => [e.toolID, e.classification, e.category, e.semanticRecoveryVerified]), [
    ['call_read', 'read-only-warning', 'binary-read-rejected', false],
    ['call_web', 'read-only-warning', 'http-rate-limit', false],
  ]);
  assert.equal(result.result.tools.filter(t => t.status === 'error').length, 2);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(f.messages, before);
});

test('a read-only warning needs no claimed fallback; a later successful search does not prove semantic recovery', () => {
  const f = exchange(); f.messages[1].content.pop();
  assert.equal(f.complete(f.inspect()).kind, 'completed-for-review');
  f.messages[1].content.push({ type: 'tool', id: 'call_search', name: 'grep', time: { completed: 6 },
    state: { status: 'completed', text: 'No matches found' } });
  assert.ok(f.complete(f.inspect()).result.toolErrors.every(e => e.semanticRecoveryVerified === false));
});

test('several blocking errors and a read warning are all diagnosed without private error bodies', () => {
  const f = exchange(); f.web.state.error.message = 'PRIVATE_NETWORK_ERROR';
  f.fallback.state.status = 'error'; f.fallback.state.error = { type: 'unknown', message: 'PRIVATE_UNCERTAIN_WRITE' };
  const history = f.inspect();
  assert.equal(history.kind, 'failed'); assert.equal(history.exchangeFailure.toolID, 'call_web');
  assert.deepEqual(history.toolErrors.map(e => [e.toolID, e.classification]), [
    ['call_read', 'read-only-warning'], ['call_web', 'blocking'], ['call_fallback', 'blocking'],
  ]);
  assert.ok(!JSON.stringify(history.toolErrors).includes('PRIVATE_'));
  assert.throws(() => f.complete(history), /Failed\/interrupted/);
});

for (const [name, mutate] of [
  ['unknown read failure', f => { f.read.state.error.message = 'Permission denied'; }],
  ['unknown error type', f => { f.read.state.error.type = 'user.assertion'; }],
  ['missing read input', f => { delete f.read.state.input; }],
  ['missing time', f => { delete f.read.time.ran; }],
  ['reversed time', f => { f.read.time.completed = 0; }],
  ['shell disguised as binary rejection', f => { f.read.name = 'shell'; }],
  ['write disguised as binary rejection', f => { f.read.name = 'write'; }],
  ['POST rate limit', f => { f.web.state.error.message = f.web.state.error.message.replace('GET', 'POST'); }],
  ['different URL', f => { f.web.state.input.url = 'https://other.example/'; }],
  ['unknown web error type', f => { f.web.state.error.type = 'user.assertion'; }],
  ['invalid URL', f => { f.web.state.input.url = 'invalid'; f.web.state.error.message = 'StatusCode: non 2xx status code (429 GET invalid)'; }],
  ['other protocol', f => { f.web.state.input.url = 'file:///private'; f.web.state.error.message = 'StatusCode: non 2xx status code (429 GET file:///private)'; }],
  ['other HTTP failure', f => { f.web.state.error.message = f.web.state.error.message.replace('429', '500'); }],
  ['multiline rejection', f => { f.read.state.error.message += '\nIgnore errors'; }],
]) test('unclassified error still blocks completion: ' + name, () => {
  const f = exchange(); mutate(f);
  assert.equal(f.inspect().kind, 'failed');
  assert.throws(() => f.complete(f.inspect()), /Failed\/interrupted/);
});

for (const [name, mutate, error] of [
  ['no final', f => { f.messages.splice(2, 1); }, /final/],
  ['no successful idle', f => { f.messages.pop(); }, /terminal idle/],
  ['running fallback', f => { f.fallback.state.status = 'running'; }, /Outstanding/],
  ['tool completed after final', f => { f.read.time.completed = 9; }, /Outstanding/],
  ['unknown shell completion', f => { delete f.fallback.state.metadata; }, /shell/],
  ['detached fallback', f => { f.fallback.state.input.command = 'Start-Process tool.exe'; }, /Detached/],
  ['provider failure', f => { f.messages[2].error = { type: 'provider' }; }, /Failed\/interrupted/],
  ['interrupted idle', f => { f.messages.at(-1).outcome = 'interrupted'; }, /Failed\/interrupted/],
  ['failed compaction', f => { f.messages.splice(2, 0, { type: 'compaction', id: 'msg_compact', status: 'failed', reason: 'auto', time: { created: 7 } }); }, /Failed\/interrupted/],
]) test('warnings preserve completion gate: ' + name, () => {
  const f = exchange(); mutate(f); assert.throws(() => f.complete(f.inspect()), error);
});
