import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MODEL } from '../helper/connection.mjs';
import { assignmentMessages, inspectMessages, completion, closureBoundary } from '../helper/interaction.mjs';

for (const scenario of ['complete', 'repeated-cursor', 'overlap', 'empty', 'changed-head', 'page-limit', 'byte-limit', 'deadline']) {
  test('bounded history validates ' + scenario, async t => {
    const binding = { sessionID: 'ses_fixture', messageID: 'msg_user', assignmentID: 'fixture' };
    const user = { id: 'msg_user', type: 'user', text: 'Assignment ID: fixture\n' };
    const head = { id: 'msg_head', type: 'assistant', text: 'head' };
    const body = scenario === 'byte-limit' ? 'x'.repeat(1024 * 1024) : '';
    let requests = 0;
    const clock = new AbortController();
    if (scenario === 'deadline') t.mock.method(AbortSignal, 'timeout', () => clock.signal);
    const client = { async request(route) {
      requests++;
      if (route.endsWith('limit=1&order=desc'))
        return { data: [scenario === 'changed-head' ? { ...head, text: 'changed' } : head] };
      if (scenario === 'deadline') clock.abort();
      if (scenario === 'page-limit' || scenario === 'byte-limit') return {
        data: [{ id: 'msg_' + requests, type: 'assistant', text: body }], cursor: { next: 'cursor' + requests },
      };
      if (requests === 1) return { data: [head], cursor: { next: 'first' } };
      if (scenario === 'repeated-cursor') return { data: [{ id: 'msg_other' }], cursor: { next: 'first' } };
      if (scenario === 'overlap') return { data: [head, user] };
      if (scenario === 'empty') return { data: [], cursor: { next: 'second' } };
      return { data: [user] };
    } };
    const read = assignmentMessages(client, binding);
    if (scenario === 'complete') {
      assert.deepEqual(await read, [user, head]);
      assert.equal(requests, 3);
    } else {
      const reason = { 'repeated-cursor': /invalid cursor/, overlap: /Ambiguous message pagination/,
        empty: /invalid cursor/, 'changed-head': /History head changed/,
        'page-limit': /exceeds 200 pages/, 'byte-limit': /exceeds 64 MiB/, deadline: /exceeded 90 seconds/ };
      await assert.rejects(read, reason[scenario]);
      if (scenario === 'page-limit') assert.equal(requests, 200);
      if (scenario === 'deadline') assert.equal(requests, 1);
    }
  });
}

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

function checkShell(command, { input = {}, metadata = {}, shells = [], time = { completed: 10 } } = {}) {
  const messages = exchange().filter(message => message.type !== 'synthetic');
  const offset = time.completed - 10;
  for (const message of messages.slice(1)) {
    for (const key of Object.keys(message.time)) message.time[key] += offset;
  }
  Object.assign(messages[1].content[0], { id: 'call_shell_check', name: 'shell', time, state: {
    status: 'completed', input: { command, ...input }, metadata: { status: 'completed', ...metadata },
  } });
  const binding = { messageID: 'msg_user', submittedAt: 1 };
  const session = { model: MODEL, outcome: 'succeeded', time: { idle: 41 + offset } };
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

test('a recovered provider retry and a late correlated shell notice preserve their real outcomes', () => {
  const command = 'Get-Date', messages = exchange().slice(0, 5);
  const retry = { id: 'msg_retry', type: 'assistant', model: MODEL, time: { created: 2 }, content: [],
    retry: { attempt: 1, at: 3, error: { type: 'provider', status: 503, message: 'PRIVATE_BODY' } } };
  const launch = messages[1];
  launch.time.created = 4;
  launch.content[0] = { id: 'call_shell', type: 'tool', name: 'shell', time: { ran: 5, completed: 10 },
    state: { status: 'completed', input: { command, background: true }, metadata: { status: 'running', shellID: 'sh_fixture' } } };
  messages[3].time.created = 25;
  const notice = { id: 'msg_shell', type: 'synthetic', description: command, time: { created: 31 },
    metadata: { source: 'shell', shellID: 'sh_fixture', jobID: 'sh_fixture', state: 'completed', exit: 0, truncated: false },
    text: '<shell id="sh_fixture" state="completed" command="Get-Date">\nOutput\n</shell>' };
  messages.splice(2, 1); messages.splice(1, 0, retry); messages.splice(-1, 0, notice);
  const result = complete(inspect(messages, false)).result;
  assert.deepEqual(result.recoveredRetries, [{ messageID: 'msg_retry', attempt: 1, status: 503 }]);
  assert.deepEqual(result.shellOutcomes, [{ callID: 'call_shell', outcome: 'succeeded', exit: 0 }]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_BODY'));
  notice.metadata.exit = 2;
  assert.equal(inspect(messages, false).kind, 'failed');
  notice.metadata.exit = 0;
  retry.content.push({ type: 'tool', id: 'call_unknown', name: 'write', state: { status: 'running' } });
  assert.equal(inspect(messages, false).kind, 'failed');
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
  ["$out = & (Join-Path $run 'fixture.ps1')", 'ampersand'],
  ['$out = & $tool --version', 'ampersand'],
  ['echo = & ( sleep 1 )', 'ampersand'],
  ['$out = & $tool --version\nGet-Date &', 'ampersand'],
  ['$out = & $tool --version\nStart-Job { Get-Date }', 'start-job'],
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

test('Windows PowerShell lifecycle evidence admits only the exact observed assignment call', {
  skip: process.platform !== 'win32' || process.env.DUET_TEST_POWERSHELL_EVENTS !== '1',
}, () => {
  const exe = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `# ${randomUUID()}\n` +
    "$out = & (Join-Path $env:SystemRoot 'System32/where.exe') /?\n" +
    "$tool = 'Write-Output'\n$out = & $tool 'fixture'\n$out";
  const ran = Date.now();
  execFileSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 5000, stdio: 'ignore',
  });
  const time = { ran, completed: Date.now() }, metadata = { exit: 0 };
  const [finish, close] = checkShell(command, { time, metadata });
  assert.equal(finish().kind, 'completed-for-review');
  assert.equal(close().idleAt, time.completed + 31);
  for (const variant of [command + '\nGet-Date &', command.replace("'fixture'", "'different'"), command + '\n# different']) {
    for (const check of checkShell(variant, { time, metadata })) {
      assert.throws(check, /call_shell_check.*unclassified or background ampersand/);
    }
  }
});

test('shell evidence still blocks pending and untracked background operations', () => {
  for (const check of checkShell('go version', { metadata: { shellID: 'sh_check' }, shells: [{ id: 'sh_check', status: 'running' }] }))
    assert.throws(check, /Project shell still running.*call_shell_check/);
  for (const check of checkShell('go version', { input: { background: true } }))
    assert.throws(check, /Background operation status unknown.*call_shell_check/);
});
