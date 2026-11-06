import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL } from '../helper/connection.mjs';
import { inspectMessages, completion, closureBoundary } from '../helper/interaction.mjs';

// Native 2.1.4 shapes: synthetic input, then manual compaction after a final/idle.
function exchange() {
  return [
    { id: 'msg_user', type: 'user', text: 'PRIVATE_INPUT' },
    { id: 'msg_step', type: 'assistant', model: MODEL, time: { completed: 10 }, content: [
      { id: 'call_edit', type: 'tool', name: 'edit', time: { completed: 10 }, state: { status: 'completed' } },
    ] },
    { id: 'msg_synthetic', type: 'synthetic', time: { created: 20 }, text: 'PRIVATE_SYNTHETIC', metadata: { instruction: true } },
    { id: 'msg_final', type: 'assistant', model: MODEL, finish: 'stop', time: { completed: 30 }, content: [{ type: 'text', text: 'Finished.' }] },
    { id: 'msg_idle1', type: 'idle', outcome: 'succeeded', time: { created: 31 } },
    { id: 'msg_compact', type: 'compaction', status: 'completed', reason: 'manual', model: MODEL,
      time: { created: 40 }, summary: 'PRIVATE_SUMMARY', metadata: { keepID: 'msg_final' } },
    { id: 'msg_idle2', type: 'idle', outcome: 'succeeded', time: { created: 41 } },
  ];
}
const inspect = (messages, adopting = true) => inspectMessages({ messageID: 'msg_user' }, messages, { adopting });
const complete = history => completion(history, { time: { idle: 41 } }, { data: [] });

function checkShell(command, { input = {}, metadata = {}, shells = [] } = {}) {
  const messages = exchange().filter(message => message.type !== 'synthetic');
  Object.assign(messages[1].content[0], { id: 'call_shell_check', name: 'shell', state: {
    status: 'completed', input: { command, ...input }, metadata: { status: 'completed', ...metadata },
  } });
  const binding = { messageID: 'msg_user', submittedAt: 1 };
  const session = { model: MODEL, outcome: 'succeeded', time: { idle: 41 } };
  return [() => completion(inspectMessages(binding, messages), session, { data: shells }),
    () => closureBoundary(binding, messages, session, { data: shells })];
}

test('completed native compaction and prior synthetic preserve the final, all tools and source history', () => {
  const messages = exchange(), before = structuredClone(messages), history = inspect(messages);
  const result = complete(history);
  assert.equal(result.kind, 'completed-for-review'); assert.equal(result.result.assistantID, 'msg_final');
  assert.equal(result.result.tools.length, 1); assert.equal(result.result.endedAt, 41);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.deepEqual(messages, before);
});

test('uncorrelated synthetic input stays blocked during a bound assignment, even with a later successful final', () => {
  assert.throws(() => inspect(exchange(), false), error => error.diagnostic?.errorCode === 'UncorrelatedSyntheticInput');
});

for (const [name, mutate, error] of [
  ['running compaction', m => { m[5].status = 'running'; }, /Compaction has not completed/],
  ['unknown compaction status', m => { m[5].status = 'PRIVATE_STATUS'; }, /Unknown compaction status/],
  ['missing compaction time', m => { delete m[5].time.created; }, /Invalid compaction metadata/],
  ['unknown compaction reason', m => { m[5].reason = 'PRIVATE_REASON'; }, /Invalid compaction metadata/],
  ['changed compaction model', m => { m[5].model = { ...MODEL, id: 'other' }; }, /Compaction model\/summary changed/],
  ['missing compaction summary', m => { delete m[5].summary; }, /Compaction model\/summary changed/],
  ['compaction newer than idle', m => { m[5].time.created = 42; }, /No terminal idle after compaction/],
  ['synthetic after final', m => { m.splice(4, 0, m.splice(2, 1)[0]); }, /No completed final after synthetic input/],
  ['synthetic newer than final', m => { m[2].time.created = 32; }, /No completed final after synthetic input/],
  ['synthetic without text', m => { delete m[2].text; }, /Invalid synthetic input metadata/],
  ['synthetic without time', m => { delete m[2].time; }, /Invalid synthetic input metadata/],
  ['old running tool before synthetic', m => { m[1].content[0].state.status = 'running'; }, /Outstanding\/unknown tool/],
]) test(name + ' cannot transfer ownership', () => {
  const messages = exchange(); mutate(messages);
  assert.throws(() => complete(inspect(messages)), error);
});

test('failed compaction and interrupted execution remain failures despite a later successful idle', () => {
  const messages = exchange(); messages[5].status = 'failed';
  assert.equal(inspect(messages).kind, 'failed');
  messages[5].status = 'completed'; messages[4].outcome = 'interrupted';
  assert.equal(inspect(messages).kind, 'interrupted');
});

test('automatic compaction is supported during a bound assignment without permitting synthetic input', () => {
  const messages = exchange().filter(m => m.type !== 'synthetic');
  messages[4].reason = 'auto';
  assert.equal(complete(inspect(messages, false)).kind, 'completed-for-review');
});

test('unsupported history diagnostics name only known API types, never arbitrary private values', () => {
  for (const type of ['shell', 'system', 'skill', 'model-switched', 'agent-switched', 'location-switched', 'PRIVATE_TYPE']) {
    const messages = exchange(); messages[2].type = type;
    assert.throws(() => inspect(messages), error => {
      assert.ok(error.message.includes(type === 'PRIVATE_TYPE' ? 'unrecognized' : type));
      assert.ok(!error.message.includes('PRIVATE_')); return true;
    });
  }
});

for (const command of [
  'dotnet test 2>&1 | Select-Object -Last 5',
  'cd C:/fixture; & $tool test 2>&1',
  'if ($true) { & "C:/fixture/tool.exe" test }',
  '& tool.exe test 2>&1',
  "$env:GOTOOLCHAIN='local'\r\n  & $go version\r\n& $node --version",
  "$nodeDir='C:/fixture'\n& (Join-Path $nodeDir 'npm.cmd') --version",
  "Write-Output 'start verification'",
  'Write-Output ok # Start-Job is forbidden',
  'printf ok && npm test 2>&1',
]) test('foreground shell syntax does not become background: ' + command, () => {
  const [finish, close] = checkShell(command);
  assert.equal(finish().kind, 'completed-for-review');
  assert.equal(close().idleAt, 41);
});

for (const [command, reason] of [
  ['dotnet build 2>&1 &', 'ampersand'],
  ['cd C:/fixture; & $tool test; sleep 10 &', 'ampersand'],
  ['Write-Output ok\n& (Join-Path $nodeDir "tool.exe") &', 'ampersand'],
  ['sleep 10 \\\n& echo done', 'ampersand'],
  ['$p=Start-Process tool.exe -PassThru; if (!$p.WaitForExit(1000)) { $p.Kill() }', 'start-process'],
  ['Start-Job { build }', 'start-job'],
  ['nohup build', 'nohup'],
  ['python -c "subprocess.Popen(PRIVATE_INPUT)"', 'popen'],
  ['Write-Output "$(Start-Job { build })"', 'start-job'],
  ['cmd /c "start tool.exe"', 'start'],
]) test('redirection or invocation normalization cannot hide detached work: ' + reason, () => {
  for (const check of checkShell(command)) assert.throws(check, error => {
    assert.match(error.message, /Detached command status unknown.*call_shell_check/);
    assert.ok(error.message.endsWith(reason));
    assert.ok(!error.message.includes('PRIVATE_INPUT'));
    return true;
  });
});

test('shell evidence still blocks pending and untracked background operations', () => {
  for (const check of checkShell('go version', { metadata: { shellID: 'sh_check' }, shells: [{ id: 'sh_check', status: 'running' }] }))
    assert.throws(check, /Project shell still running.*call_shell_check/);
  for (const check of checkShell('go version', { input: { background: true } }))
    assert.throws(check, /Background operation status unknown.*call_shell_check/);
});
