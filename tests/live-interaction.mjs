// Explicit live harness: creates only a NEW fixture session in a separate technical store.
// Never run as part of node --test. Uses the real CODEX_THREAD_ID; no identity override.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';
import { assignmentMessages } from '../helper/interaction.mjs';

const [command, stateRoot, kind, requestID, answer] = process.argv.slice(2);
assert.ok(isAbsolute(stateRoot || ''), 'Explicit absolute, isolated test stateRoot required');
const workspace = realpathSync(fileURLToPath(new URL('./fixtures/interaction space & test/', import.meta.url)));
assert.ok(!resolve(stateRoot).startsWith(workspace), 'Technical bookkeeping must stay outside executor workspace');
const plan = join(workspace, '001-smoke.md');
const client = await connect().catch(async error => { await helper(null, { stateRoot }).connectionLost(error); throw error; });
const adapter = helper(client, { stateRoot });
const started = Date.now();
let result;
if (command === 'bind') {
  const configuration = await client.request('/api/config?location[directory]=' + encodeURIComponent(workspace));
  const serialized = JSON.stringify(configuration);
  assert.ok(serialized.includes('"action":"shell"') && serialized.includes('"effect":"ask"'), 'Fixture must request real shell permission');
  result = await adapter.bind(workspace, plan);
} else if (command === 'submit') {
  result = await adapter.submit(workspace, plan, 'interaction-smoke-003', join(workspace, 'packet.txt'));
} else if (command === 'wait') {
  const interrupt = new AbortController();
  process.once('SIGINT', () => interrupt.abort()); process.once('SIGTERM', () => interrupt.abort());
  result = await adapter.wait(workspace, plan, { signal: interrupt.signal });
} else if (command === 'reply') {
  result = await adapter.reply(workspace, plan, kind, requestID, JSON.parse(answer));
} else if (command === 'verify') {
  const binding = JSON.parse(readFileSync(adapter.statePath, 'utf8')).bindings.find(binding => binding.codexChat === process.env.CODEX_THREAD_ID);
  assert.equal(binding.phase, 'REVIEWING');
  const messages = await assignmentMessages(client, binding);
  assert.equal(messages.filter(message => message.type === 'user').length, 1);
  const assistant = messages.filter(message => message.type === 'assistant').at(-1);
  const text = assistant.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  for (const expected of ['CODE_DUET_INTERACTION_SMOKE_003', 'Beta', 'CUSTOM_003', 'Alpha', 'Gamma']) assert.ok(text.includes(expected), expected);
  const tools = messages.flatMap(message => message.content?.filter(part => part.type === 'tool') ?? []);
  assert.equal(tools.filter(tool => tool.name === 'question').length, 3);
  const shells = tools.filter(tool => tool.name === 'shell'); assert.equal(shells.length, 1);
  assert.equal(shells[0].state.status, 'completed'); assert.equal(shells[0].state.metadata.exit, 0);
  assert.ok(shells[0].time.completed - shells[0].time.ran >= 75_000);
  assert.equal((await client.request('/api/session/active')).data[binding.sessionID], undefined);
  assert.deepEqual((await client.request('/api/session/' + binding.sessionID + '/form')).data, []);
  assert.deepEqual((await client.request('/api/session/' + binding.sessionID + '/permission')).data, []);
  result = { kind: 'live-verified', sessionID: binding.sessionID, assignmentID: binding.assignmentID,
    userMessages: 1, questionTools: 3, shellTools: 1, shellToolMillisecondsIncludingPermission: shells[0].time.completed - shells[0].time.ran, shellExit: shells[0].state.metadata.exit,
    finalCompletedAt: assistant.time.completed, text };
} else throw new Error('bind | submit | wait | reply <kind> <request-id> <JSON> | verify');
const record = { ...result, startedAt: started, returnedAt: Date.now(), milliseconds: Date.now() - started };
appendFileSync(join(stateRoot, 'outcomes.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
console.log(JSON.stringify(record));
if (result.phase === 'STOPPED') process.exitCode = 1;
