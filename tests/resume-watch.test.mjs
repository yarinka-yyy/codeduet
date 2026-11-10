import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper, preflight as checkPreflight } from '../helper/binding.mjs';
import { inferPostgresRecovery, sha256, verifyPostgresRecovery } from '../helper/postgres-recovery.mjs';

async function stopped(t) {
  const f = await fixture(t, undefined, '2.2.0');
  const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: 'offline-http-chat-A' });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'delivered-correction-nine', f.packet, baseline, 'correction');
  const before = f.state().bindings[0];
  await adapter.connectionLost(Object.assign(new Error('Synthetic input followed the bound assignment; no ownership transfer'), {
    diagnostic: { category: 'unknown', stage: 'snapshot', elapsedMs: 49, lastEvent: null, errorName: 'Error' } }));
  const resume = Object.fromEntries(['sessionID', 'assignmentID', 'messageID'].map(key => [key, before[key]]));
  const args = ['resume-watch', f.workspace, f.plan, resume.assignmentID, resume.messageID,
    '--session', resume.sessionID, '--non-git-baseline', baseline, '--timeout-ms', '3000'];
  return Object.assign(f, { client, adapter, resume, args,
    observe: options => adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 3000, resume, ...options }),
    mutate: change => { const state = f.state(); change(state.bindings[0], state); writeFileSync(f.statePath, JSON.stringify(state)); } });
}
function unchanged(f, before, callsFrom) {
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
  assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
  const owners = join(dirname(f.statePath), 'ownership');
  assert.deepEqual(existsSync(owners) ? readdirSync(owners) : [], []);
}

test('explicit CLI resumes the same completed assignment without POST, new binding or counter reset', async t => {
  const f = await stopped(t), saved = f.state(), callsFrom = f.calls.length;
  const now = Date.now();
  f.messages.get(f.resume.sessionID).push({ id: 'msg_shell', type: 'assistant', model, time: { completed: now }, content: [
    { id: 'call_shell', type: 'tool', name: 'shell', time: { completed: now }, state: {
      status: 'completed', metadata: { status: 'completed', exit: 0 },
      input: { command: "$env:GOTOOLCHAIN='local'\n& $go version\n& (Join-Path $nodeDir 'npm.cmd') --version" },
    } },
  ] });
  f.finish(f.resume.sessionID);
  const result = await f.call(f.args);
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.result.kind, 'completed-for-review'); assert.equal(result.result.phase, 'REVIEWING');
  assert.equal(result.result.observationOnly, true); assert.equal(result.result.taskSent, false);
  assert.equal(result.result.correctionCount, 9); assert.equal(result.result.assignmentID, f.resume.assignmentID);
  assert.equal(result.result.messageID, f.resume.messageID);
  assert.deepEqual(f.state().plans, saved.plans); assert.equal(f.state().bindings.length, 1);
  assert.equal(f.state().bindings[0].stopReason, undefined); assert.equal(f.state().bindings[0].diagnostic, undefined);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
  assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
  const reviewed = readFileSync(f.statePath), after = f.calls.length;
  assert.equal((await f.call(f.args)).result.kind, 'rejected'); unchanged(f, reviewed, after);
});

async function postgresFixture(t) {
  const f = await stopped(t), run = join(f.workspace, 'postgres fixture');
  const dataDirectory = join(run, 'data', 'pgdata'), log = join(run, 'logs', 'postgres.log');
  mkdirSync(dataDirectory, { recursive: true }); mkdirSync(dirname(log));
  const ran = Date.now(), pid = 301, port = 55432;
  const command = `$run='${run}'\n$pgdata=Join-Path $run 'data/pgdata'\n` +
    "& (Join-Path $bin 'pg_ctl.exe') -D $pgdata -l (Join-Path $run 'logs/postgres.log') -w -t 60 start";
  f.messages.get(f.resume.sessionID).push({ id: 'msg_postgres', type: 'assistant', model, time: { completed: ran + 3 }, content: [
    { id: 'call_postgres', type: 'tool', name: 'shell', time: { ran, completed: ran + 3 }, state: {
      status: 'completed', metadata: { status: 'completed', timeout: true }, input: { command },
    } },
  ] });
  const line = (at, text) => new Date(at).toISOString().replace('T', ' ').replace('Z', ` UTC [${pid}] LOG:  `) + text;
  const logText = [line(ran + 1, 'starting PostgreSQL 16'),
    line(ran + 2, `listening on IPv4 address "127.0.0.1", port ${port}`),
    line(ran + 4, 'database system is shut down')].join('\n');
  writeFileSync(log, logText);
  const evidence = { messageID: f.resume.messageID, dataDirectory, log, logHash: sha256(logText), port,
    calls: [{ id: 'call_postgres', commandHash: sha256(command), pid }] };
  const file = join(f.home, 'postgres-evidence.json');
  await new Promise(resolve => setTimeout(resolve, 10));
  f.finish(f.resume.sessionID);
  return { f, evidence, file, logText, args: [...f.args.slice(0, -1), '15000', '--postgres-evidence', file] };
}

test('PostgreSQL recovery refuses an unmatched shutdown and leaves STOPPED intact', async t => {
  const { f, evidence, file, logText, args } = await postgresFixture(t);
  const incomplete = logText.split('\n').slice(0, 2).join('\n');
  writeFileSync(evidence.log, incomplete);
  writeFileSync(file, JSON.stringify({ ...evidence, logHash: sha256(incomplete) }));
  const before = readFileSync(f.statePath), from = f.calls.length;
  const outcome = await f.call(args);
  assert.match(outcome.result.error, /lifecycle evidence is incomplete/);
  unchanged(f, before, from);
});

test('PostgreSQL recovery correlates a cleaned run and two OpenCode call formats', async t => {
  const f = await stopped(t), saved = f.state().bindings[0];
  const run = join(f.workspace, 'cleaned run'), dataDirectory = join(run, 'pgdata');
  const log = join(run, 'logs', 'postgres.log'), port = 55439;
  mkdirSync(dirname(log), { recursive: true });
  const at = saved.submittedAt + 100;
  const prefix = "$run='" + run + "'; $pgbin='" + join(run, 'bin') + "'; ";
  const start = '& "$pgbin\\pg_ctl.exe" -D "$run\\pgdata" -l "$run\\logs\\postgres.log"';
  const first = { id: 'chatcmpl-tool-timeout', name: 'shell', time: { ran: at, completed: at + 2000 },
    state: { status: 'completed', metadata: { status: 'completed', timeout: true },
      input: { command: prefix + start + " -o '\"-p 55439 -c listen_addresses=127.0.0.1 -c logging_collector=off\"' start" } } };
  const second = { id: 'call_background', messageID: 'msg_shell', name: 'shell', time: { ran: at + 3000, completed: at + 3001 },
    state: { status: 'completed', metadata: { status: 'running', shellID: 'sh_fixture' },
      input: { background: true, command: prefix + start + ' -o "-p 55439 -c listen_addresses=127.0.0.1" -w start' } } };
  const background = new Map([['sh_fixture', { toolID: second.id, messageID: second.messageID,
    notice: { metadata: { state: 'completed', exit: 0 }, time: { created: at + 4000 } } }]]);
  const logLines = (pid, launch, stop) => ['starting PostgreSQL 16', 'listening on IPv4 address "127.0.0.1", port 55439',
    'database system is shut down'].map((message, index) =>
    new Date([launch, launch + 1, stop][index]).toISOString().replace('T', ' ').replace('Z', ' UTC [' + pid + '] LOG:  ') + message);
  const bytes = [...logLines(17932, at + 1, at + 1999), ...logLines(58504, at + 3391, at + 5000)].join('\n');
  writeFileSync(log, bytes);
  const evidence = { messageID: saved.messageID, dataDirectory, log, logHash: sha256(bytes), port,
    calls: [first, second].map((tool, index) => ({ id: tool.id, pid: [17932, 58504][index], commandHash: sha256(tool.state.input.command) })) };
  const verify = (postgresRecovery = evidence, probe = () => true, jobs = background) =>
    verifyPostgresRecovery({ ...saved, postgresRecovery }, [first, second], at + 6000, probe, jobs);
  assert.equal(existsSync(dataDirectory), false);
  const result = verify(evidence, (...args) => {
    assert.deepEqual(args, [55439, true, dataDirectory, [17932, 58504]]);
    return true;
  });
  assert.equal(result.get(first.id).timeout, true);
  assert.equal(result.get(second.id).startedAt - second.time.completed, 390);
  assert.throws(() => verify(evidence, undefined, new Map()), /launch does not match call call_background/);
  assert.throws(() => verify(evidence, () => false), /process, listener or PID file/);
  assert.throws(() => verify(evidence, () => { throw new Error('access denied'); }), /Windows CIM and listener access/);
  assert.throws(() => verify({ ...evidence, logHash: sha256('foreign') }), /log changed/);
  const foreignLog = join(f.workspace, 'different run', 'logs', 'postgres.log');
  mkdirSync(dirname(foreignLog), { recursive: true }); writeFileSync(foreignLog, bytes);
  assert.throws(() => verify({ ...evidence, log: foreignLog, dataDirectory: join(dirname(dirname(foreignLog)), 'pgdata') }),
    /launch directory does not match/);
  mkdirSync(dataDirectory);
  writeFileSync(join(dataDirectory, 'postmaster.pid'), '17932');
  assert.throws(() => verify(), /PID file/);
});

function nativePostgresFixture(workspace, at, port = 55432) {
  const cluster = join(workspace, 'native', '002-stage1-01'), run = join(workspace, 'native', '010-b4-02');
  const data = join(cluster, 'data', 'pgdata'), bin = join(cluster, 'tools', 'pgsql', 'bin');
  const log = join(run, 'logs', 'postgres.log'), pid = 38168;
  mkdirSync(dirname(log), { recursive: true }); mkdirSync(data, { recursive: true });
  const prefix = `cd '${workspace}'; $run='${run}'; $bin='${bin}'; $data='${data}'; `;
  const call = "& (Join-Path $bin 'pg_ctl.exe') -D $data ";
  const listener = `Get-NetTCPConnection -State Listen -LocalPort ${port}`;
  const tool = (id, command, text, ran) => ({ id, type: 'tool', name: 'shell', time: { ran, completed: ran + 4 },
    state: { status: 'completed', input: { command }, metadata: { status: 'completed', exit: 0, truncated: false },
      content: [{ type: 'text', text }] } });
  const first = tool('call_a0ed174c35dc4525b4a422b2', prefix + "$log=Join-Path $run 'logs\\postgres.log'; " +
    call + '-l $log start; $code=$LASTEXITCODE; ' + call + 'status; ' + listener,
    `start_exit=0\npostmaster_pid=${pid}\nstatus_exit=0\n127.0.0.1      ${port}    ${pid}`, at);
  const stop = tool('call_eb3782b64eee4c049d9d303d', prefix + call + '-m fast stop; $code=$LASTEXITCODE; ' +
    call + 'status; ' + listener, 'stop_exit=0\nstatus_exit=3\npid_file_exists=False\nlisteners=0\nprocesses=0', at + 10);
  const logLine = (time, text) => new Date(time).toISOString().replace('T', ' ').replace('Z', ` UTC [${pid}] LOG:  `) + text;
  const bytes = [logLine(at + 1, 'starting PostgreSQL 16.15'),
    logLine(at + 2, `listening on IPv4 address "127.0.0.1", port ${port}`),
    logLine(at + 11, 'database system is shut down')].join('\n');
  writeFileSync(log, bytes);
  return { first, stop, data, log, bytes, pid };
}

test('Windows pg_ctl with $data and $log matches only the stopped sibling test cluster', async t => {
  const f = await stopped(t), binding = f.state().bindings[0], at = binding.submittedAt + 10;
  const { first, stop, data, log, bytes, pid } = nativePostgresFixture(f.workspace, at);
  const evidence = inferPostgresRecovery(binding, [first, stop]);
  const verify = (tools = [first, stop], probe = () => true, changes = {}) =>
    verifyPostgresRecovery({ ...binding, postgresRecovery: { ...evidence, ...changes } }, tools, at + 20, probe);
  const result = verify(undefined, (...args) => { assert.deepEqual(args, [55432, false, data, [pid]]); return true; });
  assert.equal(result.get(first.id).stop.tool.id, stop.id);
  const extra = structuredClone(stop);
  extra.state.input.command += '; Start-Process cmd.exe';
  assert.match(verify([first, extra]).get(first.id).stop.command, /Start-Process cmd\.exe$/);
  assert.throws(() => verify([first]), /lacks a matching stop/);
  for (const [original, replacement] of [['002-stage1-01', 'foreign'], ['55432', '55433']]) {
    const wrongStop = structuredClone(stop);
    wrongStop.state.input.command = wrongStop.state.input.command.replaceAll(original, replacement);
    assert.throws(() => verify([first, wrongStop]), /lacks a matching stop/);
  }
  const wrongStatus = structuredClone(stop);
  wrongStatus.state.content[0].text = wrongStatus.state.content[0].text.replace('status_exit=3', 'status_exit=0');
  assert.throws(() => verify([first, wrongStatus]), /lacks a matching stop/);
  assert.throws(() => verify(undefined, undefined, { calls: [{ ...evidence.calls[0], pid: pid + 1 }] }), /PID or listener/);
  assert.throws(() => verify(undefined, () => false), /process, listener or PID file/);
  writeFileSync(join(data, 'postmaster.pid'), `${pid}`);
  assert.throws(() => verify(), /PID file/);
  unlinkSync(join(data, 'postmaster.pid'));
  const incomplete = bytes.split('\n').slice(0, 2).join('\n');
  writeFileSync(log, incomplete);
  assert.throws(() => verify(undefined, undefined, { logHash: sha256(incomplete) }), /lifecycle evidence is incomplete/);
});

test('Windows B4-02 pg_ctl history opens ordinary and resumed review without a second prompt', {
  skip: process.platform !== 'win32' || process.env.DUET_TEST_POSTGRES_RECOVERY !== '1',
}, async t => {
  for (const resume of [false, true]) await t.test(resume ? 'resume-watch at count zero' : 'ordinary wait', async t => {
    const f = await fixture(t, undefined, '2.2.6');
    const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
    const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: 'offline-http-chat-A' });
    await adapter.bind(f.workspace, f.plan, baseline, 0);
    await adapter.submit(f.workspace, f.plan, 'B4-02', f.packet, baseline);
    const saved = f.state().bindings[0], at = Date.now();
    const { first, stop, log } = nativePostgresFixture(f.workspace, at, 65429);
    f.messages.get(saved.sessionID).push({ id: 'msg_postgres', type: 'assistant', model,
      time: { completed: at + 15 }, content: [first, stop] });
    await new Promise(resolve => setTimeout(resolve, 25));
    f.finish(saved.sessionID);
    if (resume) await adapter.connectionLost(new Error('Detached command status unknown; no ownership transfer'));
    const from = f.calls.length;
    const args = [f.workspace, f.plan, '--non-git-baseline', baseline, '--timeout-ms', '15000'];
    const result = await f.call(resume ? ['resume-watch', ...args.slice(0, 2), saved.assignmentID,
      saved.messageID, '--session', saved.sessionID, ...args.slice(2)] : ['wait', ...args], undefined, 20000);
    assert.equal(result.result.kind, 'completed-for-review', JSON.stringify(result.result));
    assert.equal(result.result.phase, 'REVIEWING');
    assert.equal(result.result.correctionCount, 0);
    assert.equal(result.result.sessionID, saved.sessionID);
    assert.equal(result.result.messageID, saved.messageID);
    unlinkSync(log);
    const finished = await f.call(['finish', f.workspace, f.plan, '--non-git-baseline', baseline], undefined, 20000);
    assert.equal(finished.result.phase, 'FINISHED', JSON.stringify(finished.result));
    assert.ok(f.calls.slice(from).every(call => call.method === 'GET'));
    assert.equal(f.posts('/api/session/' + saved.sessionID + '/prompt'), 1);
  });
});

async function fourLaunchFixture(t) {
  const f = await fixture(t, undefined, '2.2.6');
  const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
  const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: 'offline-http-chat-A' });
  await adapter.bind(f.workspace, f.plan, baseline, 0);
  await adapter.submit(f.workspace, f.plan, 'B4-05', f.packet, baseline, 'correction');
  const binding = f.state().bindings[0], run = join(f.workspace, 'test run');
  const dataDirectory = join(run, 'data'), log = join(run, 'logs', 'postgres.log'), path = join(run, 'pg.ps1');
  mkdirSync(dirname(log), { recursive: true }); mkdirSync(dataDirectory);
  const bin = join(f.workspace, 'pgsql', 'bin'), port = 65428;
  const content = readFileSync(new URL('./fixtures/postgres-wrapper.ps1', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    .replace('<RUN>', run).replace('<BIN>', bin);
  const removed = '        $proc.StandardOutput.ReadToEnd() | Out-Null\n        $proc.StandardError.ReadToEnd() | Out-Null\n';
  const base = Date.now(), at = step => base + step;
  const tool = (id, name, input, step, end, metadata) => ({ id, name, type: 'tool',
    time: { ran: at(step), completed: at(end) }, state: { status: 'completed', input, metadata } });
  const shell = (id, command, step, end, timeout = false) => tool(id, 'shell', { command }, step, end,
    { status: 'completed', ...(timeout ? { timeout: true } : { exit: 0 }) });
  const direct = '$root="' + run + '"; $pg="' + bin + '"; $data=Join-Path $root "data"; ' +
    '& "$pg\\pg_ctl.exe" -D $data -l (Join-Path $root "logs\\postgres.log") -w start *> $null; ' +
    '"start exit=$LASTEXITCODE"; & "$pg\\pg_isready.exe" -h 127.0.0.1 -p ' + port;
  const dot = '. "' + path + '"; ';
  const start = "$code = Invoke-PgCtl -PgCtlArgs @('-D', $PgData, '-l', $PgLog, '-w', '-t', '60', 'start'); " +
    "if ($code -eq 0) { & (Join-Path $PgBin 'pg_isready.exe') -h 127.0.0.1 -p $Port *> $null }; ";
  const stop = "Invoke-PgCtl -PgCtlArgs @('-D', $PgData, '-m', 'fast', '-w', '-t', '60', 'stop')";
  const first = shell('call_direct', direct, 1, 4, true);
  const second = shell('call_wrapped_timeout', dot + start, 7, 9, true);
  const third = shell('call_wrapped_cycle', dot + start + stop, 18, 23);
  const fourth = shell('call_wrapped_last', dot + start, 26, 29);
  const tools = [first, tool('call_write', 'write', { path, content }, 5, 6, {}), second,
    tool('call_edit', 'edit', { path, oldString: removed, newString: '        # Skip inherited output pipes\n' }, 10, 11, {}),
    shell('call_stop_second', dot + stop, 14, 17), third, fourth, shell('call_stop_last', dot + stop, 31, 34)];
  const pids = [25224, 27560, 36400, 11592], starts = [2, 8, 19, 27], stops = [3, 16, 22, 33];
  const bytes = pids.flatMap((pid, i) => [
    [starts[i], 'starting PostgreSQL 16'], [starts[i], 'listening on IPv4 address "127.0.0.1", port ' + port],
    [stops[i], 'database system is shut down'],
  ].map(([step, message]) => new Date(at(step)).toISOString().replace('T', ' ').replace('Z', ' UTC [' + pid + '] LOG:  ') + message)).join('\n');
  writeFileSync(log, bytes);
  const evidence = { messageID: binding.messageID, dataDirectory, log, logHash: sha256(bytes), port,
    calls: [first, second, third, fourth].map((call, i) => ({ id: call.id, pid: pids[i], commandHash: sha256(call.state.input.command) })) };
  f.messages.get(binding.sessionID).push({ id: 'msg_postgres', type: 'assistant', model, time: { completed: at(35) }, content: tools });
  await new Promise(resolve => setTimeout(resolve, Math.max(0, at(40) - Date.now())));
  f.finish(binding.sessionID);
  return { f, binding, adapter, tools, evidence, bytes, pids, idleAt: f.sessions.get(binding.sessionID).time.idle };
}

test('four PostgreSQL lifecycles correlate the data layout, exact calls and historical wrapper revisions', async t => {
  const { binding, tools, evidence, bytes, pids, idleAt } = await fourLaunchFixture(t);
  const verify = (changes = {}, history = tools, probe = () => true) =>
    verifyPostgresRecovery({ ...binding, postgresRecovery: { ...evidence, ...changes } }, history, idleAt, probe);
  assert.deepEqual(inferPostgresRecovery(binding, tools, idleAt), evidence);
  const result = verify({}, tools, (...args) => {
    assert.deepEqual(args, [evidence.port, false, evidence.dataDirectory, pids]); return true;
  });
  assert.deepEqual([...result.values()].map(item => item.timeout), [true, true, false, false]);
  assert.throws(() => verify({ calls: evidence.calls.slice(1) }), /lifecycle evidence is incomplete/);
  assert.throws(() => verify({ calls: [{ ...evidence.calls[0], pid: 1 }, ...evidence.calls.slice(1)] }), /launch does not match call/);
  assert.throws(() => verify({ calls: [{ ...evidence.calls[0], commandHash: '0'.repeat(64) }, ...evidence.calls.slice(1)] }), /command SHA-256/);
  assert.throws(() => verify({ dataDirectory: join(dirname(evidence.dataDirectory), 'foreign') }), /same run/);
  assert.throws(() => verify({ port: evidence.port - 1 }), /listener disagrees/);
  assert.throws(() => verify({}, tools.filter(tool => tool.id !== 'call_write')), /wrapper write\/edit history/);
  assert.throws(() => verify({}, tools, () => false), /process, listener or PID file/);
  const incomplete = bytes.split('\n').slice(0, -1).join('\n');
  writeFileSync(evidence.log, incomplete);
  assert.throws(() => verify({ logHash: sha256(incomplete) }), /lifecycle evidence is incomplete/);
});

test('Windows B4-05 opens the same correction for review with or without an explicit receipt', {
  skip: process.platform !== 'win32' || process.env.DUET_TEST_POSTGRES_RECOVERY !== '1',
}, async t => {
  for (const resume of [true, false]) await t.test(resume ? 'resume-watch' : 'wait', async t => {
    const { f, binding, adapter, evidence, pids } = await fourLaunchFixture(t);
    const args = [f.workspace, f.plan], options = ['--non-git-baseline', baseline, '--timeout-ms', '18000'];
    const file = join(f.home, 'postgres-evidence.json');
    writeFileSync(file, JSON.stringify(evidence));
    if (resume) await adapter.connectionLost(new Error('Shell termination is not confirmed'));
    const from = f.calls.length;
    const resumeArgs = ['resume-watch', ...args, binding.assignmentID, binding.messageID,
      '--session', binding.sessionID, '--postgres-evidence', file, ...options];
    if (resume) {
      const stopped = readFileSync(f.statePath), pidFile = join(evidence.dataDirectory, 'postmaster.pid');
      writeFileSync(pidFile, String(pids[0]));
      const blocked = await f.call(resumeArgs, undefined, 22000);
      assert.match(blocked.result.error, /PID file/);
      assert.deepEqual(readFileSync(f.statePath), stopped);
      unlinkSync(pidFile);
    }
    const result = await f.call(resume ? resumeArgs : ['wait', ...args, ...options], undefined, 22000);
    assert.equal(result.result.kind, 'completed-for-review', JSON.stringify(result.result));
    for (const field of ['assignmentID', 'sessionID', 'messageID']) assert.equal(result.result[field], binding[field]);
    assert.equal(result.result.correctionCount, 1);
    assert.deepEqual(result.result.result.postgresRecovery.map(item => item.pid), pids);
    assert.ok(f.calls.slice(from).every(call => call.method === 'GET'));
    assert.equal(f.posts('/api/session/' + binding.sessionID + '/prompt'), 1);
    unlinkSync(evidence.log);
    const finished = await f.call(['finish', ...args, '--non-git-baseline', baseline], undefined, 22000);
    assert.equal(finished.result.kind, 'released', JSON.stringify(finished.result));
  });
});

test('PostgreSQL recovery opens review with the timeout and reuses the receipt on release', {
  skip: process.platform !== 'win32' || process.env.DUET_TEST_POSTGRES_RECOVERY !== '1',
}, async t => {
  const { f, evidence, file, logText, args } = await postgresFixture(t);
  writeFileSync(file, JSON.stringify(evidence));
  const from = f.calls.length;
  const outcome = await f.call(args, undefined, 20000);
  assert.equal(outcome.status, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.phase, 'REVIEWING');
  assert.equal(outcome.result.taskSent, false);
  assert.equal(outcome.result.result.postgresRecovery[0].timeout, true);
  assert.equal(outcome.result.result.tools[0].timeout, true);
  assert.equal(outcome.result.correctionCount, 9);
  const state = f.state(), binding = state.bindings[0];
  assert.equal(binding.messageID, f.resume.messageID);
  assert.equal(binding.postgresRecovery, undefined);
  const receipt = join(dirname(f.statePath), 'postgres-recoveries', f.resume.messageID + '.json');
  assert.equal(JSON.parse(readFileSync(receipt)).timeline[0].timeout, true);
  writeFileSync(evidence.log, logText + '\nRotated log\n');
  unlinkSync(evidence.log);
  const finish = ['finish', f.workspace, f.plan, '--non-git-baseline', baseline];
  const released = await f.call(finish, undefined, 20000);
  assert.equal(released.result.kind, 'released', JSON.stringify(released.result));
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(from).every(call => call.method === 'GET'));
  assert.equal(existsSync(evidence.log), false);
});

test('legacy FINISHED delivery can move to an empty session without bypassing active work', {
  skip: process.platform !== 'win32' || process.env.DUET_TEST_POSTGRES_RECOVERY !== '1',
}, async t => {
  const { f, evidence, file, args } = await postgresFixture(t);
  writeFileSync(file, JSON.stringify(evidence));
  const reviewed = await f.call(args, undefined, 20000);
  assert.equal(reviewed.result.phase, 'REVIEWING', JSON.stringify(reviewed.result));
  const finished = await f.call(['finish', f.workspace, f.plan, '--non-git-baseline', baseline], undefined, 20000);
  assert.equal(finished.result.phase, 'FINISHED', JSON.stringify(finished.result));
  const old = f.state().bindings[0], messages = f.messages.get(old.sessionID);
  const ran = messages[1].time.completed, completed = messages.at(-1).time.created;
  // Fixture for a delivery finished by a release that did not retain invocation proof.
  unlinkSync(join(dirname(f.statePath), 'review-boundaries', old.messageID + '.json'));
  const command = "$run='" + dirname(dirname(evidence.dataDirectory)) + "'\n$bin=Join-Path $run 'tools/pgsql/bin'\n" +
    "$sql | & (Join-Path $bin 'psql.exe') -X -w -h 127.0.0.1 -p " + evidence.port + " -U $cred.role -d postgres -q";
  const call = { id: 'call_lost', type: 'tool', name: 'shell', time: { ran, completed }, state: {
    status: 'completed', input: { command }, metadata: { status: 'completed', exit: 0 },
  } };
  messages.splice(-2, 0, { id: 'msg_lost', type: 'assistant', model, time: { completed }, content: [call] });
  const before = readFileSync(f.statePath), stateRoot = dirname(f.statePath), from = f.calls.length;
  const replace = ['replace-finished-session', f.workspace, f.plan, old.messageID, '--session', old.sessionID,
    '--lost-powershell-calls', call.id, '--non-git-baseline', baseline];
  const run = () => f.call(replace, undefined, 20000);
  const preflight = ['preflight', f.workspace, f.plan, '--non-git-baseline', baseline];
  assert.match((await f.call(preflight, undefined, 20000)).result.checks.find(x => x.name === 'history').reason, /call_lost/);
  const active = join(stateRoot, 'observers', 'fixture', 'active');
  mkdirSync(dirname(active), { recursive: true }); writeFileSync(active, 'fixture');
  assert.match((await run()).result.error, /observer is active or uncertain/);
  unlinkSync(active);
  f.forms.push({ id: 'frm_waiting', sessionID: old.sessionID });
  assert.match((await run()).result.error, /pending forms/);
  f.forms.length = 0;
  f.shells = [{ id: 'sh_running', status: 'running' }];
  assert.match((await run()).result.error, /Project shell still running/);
  f.shells = [];
  const pidFile = join(evidence.dataDirectory, 'postmaster.pid');
  writeFileSync(pidFile, '301');
  assert.match((await run()).result.error, /process, listener or PID file still present/);
  unlinkSync(pidFile);
  call.state.input.command = command + ' -f external.sql';
  assert.match((await run()).result.error, /unclassified or background ampersand/);
  call.state.input.command = command;
  call.state.input.command += '\nStart-Job { Get-Date }';
  assert.match((await run()).result.error, /possible detached launcher start-job/);
  call.state.input.command = command;
  unchanged(f, before, from);
  const token = 'abcdef01-2345-6789-abcd-ef0123456789';
  const lease = join(stateRoot, 'ownership', 'owner-' + token + '.lock');
  mkdirSync(dirname(lease), { recursive: true });
  writeFileSync(lease, JSON.stringify({ schema: 1, token, operation: 'bind', codexChat: old.codexChat,
    workspace: old.workspace, checkout: old.checkout, sessionID: old.sessionID, assignmentID: old.assignmentID }));
  const inspected = (await f.call(['ownership', f.workspace, f.plan, token, '--non-git-baseline', baseline])).result;
  assert.equal(inspected.reason, 'legacy-bind-needs-local-reboot-proof');
  assert.equal(inspected.recoveryAllowed, false);
  assert.match(inspected.legacyBind.explanation, /no PID or process start time/);
  assert.deepEqual(inspected.legacyBind.steps, [
    ['ownership', f.workspace, f.plan, token, '--action', 'recover-legacy-bind', '--non-git-baseline', baseline],
    ['replace-finished-session', f.workspace, f.plan, old.messageID, '--session', old.sessionID,
      '--lost-powershell-calls', '<comma-separated-call-ids>', '--recovered-bind', token, '--non-git-baseline', baseline],
    ['preflight', f.workspace, f.plan, '--session', '<new-session-id>', '--non-git-baseline', baseline],
  ]);
  assert.match((await run()).result.error, /ownership locked/);
  const restarted = { ...f.client, engineID: 'offline-restarted-engine' };
  const newChat = 'offline-http-chat-recovery';
  const candidate = await checkPreflight(f.client, { stateRoot, chatID: newChat, workspace: f.workspace,
    planPath: f.plan, nonGitBaseline: baseline });
  assert.equal(candidate.legacyCandidates.find(x => x.token === token).action, 'recover-legacy-bind');
  const recover = boot => helper(restarted, { stateRoot, chatID: newChat, probeBootTime: () => boot })
    .observationOwner(f.workspace, f.plan, token, { action: 'recover-legacy-bind', nonGitBaseline: baseline });
  const rejected = await recover(0);
  assert.equal(rejected.kind, 'rejected');
  assert.match(rejected.error, /confirmed Windows restart/);
  assert.deepEqual(rejected.legacyBind.steps.map(args => args[0]), ['ownership', 'preflight']);
  const createReceipt = join(stateRoot, 'finished-session-replacements', old.messageID + '.json');
  mkdirSync(dirname(createReceipt), { recursive: true });
  writeFileSync(createReceipt, '{}');
  await assert.rejects(recover(Date.now() + 1000), /create may have been reserved/);
  unlinkSync(createReceipt);
  f.forms.push({ id: 'frm_waiting', sessionID: old.sessionID });
  await assert.rejects(recover(Date.now() + 1000), /awaiting a reply/);
  f.forms.length = 0;
  f.shells = [{ id: 'sh_running', status: 'running' }];
  await assert.rejects(recover(Date.now() + 1000), /shell still running/);
  f.shells = [];
  assert.ok(existsSync(lease));
  assert.equal((await recover(Date.now() + 1000)).kind, 'bind-ownership-released');
  assert.ok(existsSync(join(stateRoot, 'ownership-history', token + '.lock')));
  unchanged(f, before, from);
  const options = { sessionID: old.sessionID, messageID: old.messageID, lostCalls: [call.id] };
  const adapter = helper(restarted, { stateRoot, chatID: old.codexChat });
  await assert.rejects(adapter.bind(f.workspace, f.plan, baseline, undefined, options), /Engine changed/);
  call.state.input.command += ' # changed';
  assert.match((await f.call([...replace, '--recovered-bind', token])).result.error, /history differs/);
  call.state.input.command = command;
  const history = JSON.stringify(messages);
  const passed = { result: await adapter.bind(f.workspace, f.plan, baseline, undefined, { ...options, recoveredBind: token }) };
  assert.equal(passed.result.kind, 'finished-session-replaced');
  assert.equal(passed.result.taskSent, false);
  assert.equal(passed.result.previous.phase, 'FINISHED');
  assert.equal(passed.result.correctionCount, 9);
  assert.notEqual(passed.result.sessionID, old.sessionID);
  assert.equal(JSON.stringify(f.messages.get(old.sessionID)), history);
  const receipt = JSON.parse(readFileSync(join(stateRoot, 'finished-session-replacements', old.messageID + '.json'), 'utf8'));
  assert.deepEqual(receipt.source, old);
  assert.equal(receipt.correctionCount, 9);
  assert.equal(receipt.reason, 'lost-powershell-lifecycle-evidence');
  assert.equal(receipt.gaps[0].hash, sha256(command));
  assert.equal(existsSync(join(stateRoot, 'powershell-invocations', old.messageID + '.json')), false);
  const ready = await checkPreflight(restarted, { stateRoot, chatID: old.codexChat, workspace: f.workspace,
    planPath: f.plan, sessionID: passed.result.sessionID, nonGitBaseline: baseline });
  assert.equal(ready.status, 'pass');
  assert.equal(ready.taskSent, false);
  assert.equal((await run()).result.kind, 'rejected');
  assert.deepEqual(f.calls.slice(from).filter(call => call.method === 'POST').map(call => call.route), ['/api/session']);
});

test('CLI wait and resume-watch accept four hours and reject larger or invalid deadlines without mutation', async t => {
  const f = await stopped(t), wait = ['wait', f.workspace, f.plan, '--non-git-baseline', baseline];
  const resume = f.args.slice(0, -2), before = readFileSync(f.statePath), from = f.calls.length;
  for (const args of [wait, resume]) for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', '14400001']) {
    const result = await f.call([...args, '--timeout-ms=' + invalid]);
    assert.equal(result.status, 1); assert.match(result.result.error, /1\.\.14400000/);
  }
  assert.deepEqual(readFileSync(f.statePath), before); assert.equal(f.calls.length, from);
  f.finish(f.resume.sessionID);
  for (const args of [resume, wait]) {
    const result = await f.call([...args, '--timeout-ms', '14400000']);
    assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.result.kind, 'completed-for-review');
  }
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(f.posts(`/api/session/${f.resume.sessionID}/prompt`), 1);
});

test('resumed active observation owns a lease, leaves the short lock free and waits for actual completion', async t => {
  const f = await stopped(t), callsFrom = f.calls.length;
  let notified, reads = 0;
  const observed = new Promise(resolve => { notified = resolve; });
  f.onRequest = route => {
    if (route.includes('/message?') && ++reads === 2) setTimeout(notified, 25);
  };
  const waiting = f.observe(); await observed;
  assert.equal(f.state().bindings[0].phase, 'EXECUTING'); assert.equal(f.state().plans[0].correctionCount, 9);
  assert.equal(existsSync(join(dirname(f.statePath), 'state.lock')), false);
  const owners = readdirSync(join(dirname(f.statePath), 'ownership')); assert.equal(owners.length, 1);
  assert.equal(JSON.parse(readFileSync(join(dirname(f.statePath), 'ownership', owners[0]))).operation, 'resume-watch');
  f.finish(f.resume.sessionID);
  assert.equal((await waiting).kind, 'completed-for-review');
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
  assert.equal(f.state().plans[0].correctionCount, 9);
});

test('ordinary wait remains sticky; missing/incorrect explicit selection never clears STOPPED', async t => {
  const f = await stopped(t), before = readFileSync(f.statePath), callsFrom = f.calls.length;
  assert.equal((await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline })).phase, 'STOPPED');
  for (const resume of [null, {}, { ...f.resume, sessionID: 'ses_wrong' },
    { ...f.resume, assignmentID: 'different' }, { ...f.resume, messageID: 'msg_wrong' }]) {
    await assert.rejects(f.observe({ resume }), /Explicit resume|Resume selection/);
  }
  const foreign = helper(f.client, { stateRoot: dirname(f.statePath), chatID: 'different-owner' });
  await assert.rejects(foreign.wait(f.workspace, f.plan, { nonGitBaseline: baseline, resume: f.resume }), /No binding/);
  const noSession = f.args.filter((value, index) => index !== 5 && index !== 6);
  assert.equal((await f.call(noSession)).status, 1);
  assert.equal((await f.call([...f.args, '--correction-count', '0'])).status, 1);
  unchanged(f, before, callsFrom);
});

for (const uncertain of ['create', 'submit', 'reply']) test('uncertain ' + uncertain + ' cannot be recovered by observation', async t => {
  const f = await stopped(t); f.mutate(binding => { binding.uncertain = uncertain; });
  const before = readFileSync(f.statePath), callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /mutation uncertain/); unchanged(f, before, callsFrom);
});

const unsafe = {
  'missing delivered message': f => { f.messages.set(f.resume.sessionID, []); },
  'assignment text mismatch': f => { f.messages.get(f.resume.sessionID)[0].text = 'Unrelated packet'; },
  'another user prompt': f => { f.messages.get(f.resume.sessionID).push({ id: 'msg_other', type: 'user', text: 'Other task' }); },
  'unmatched synthetic input': f => { f.messages.get(f.resume.sessionID).push({ id: 'msg_external', type: 'synthetic', text: 'PRIVATE_RESUME_CANARY', time: { created: Date.now() } }); },
  'changed model': f => { f.sessions.get(f.resume.sessionID).model = { ...model, id: 'other' }; },
  'archived session': f => { f.sessions.get(f.resume.sessionID).time.archived = Date.now(); },
  'stale idle without active execution': f => {
    delete f.active[f.resume.sessionID]; f.sessions.get(f.resume.sessionID).time.idle = 1;
    f.sessions.get(f.resume.sessionID).outcome = 'succeeded';
  },
  'failed execution': f => {
    f.finish(f.resume.sessionID); f.messages.get(f.resume.sessionID).at(-1).outcome = 'failed';
    f.sessions.get(f.resume.sessionID).outcome = 'failed';
  },
  'unfinished terminal tool': f => {
    f.messages.get(f.resume.sessionID).push({ id: 'msg_read', type: 'assistant', model,
      time: { completed: Date.now() }, content: [{ type: 'tool', name: 'read', id: 'tool_unfinished', state: { status: 'running' } }] });
    f.finish(f.resume.sessionID);
  },
  'active project shell at terminal': f => {
    f.finish(f.resume.sessionID); f.shells = [{ id: 'shell_running', status: 'running', time: {} }];
  },
  'foreign checkout executor': f => {
    f.active.ses_foreign = { type: 'running' };
    f.sessions.set('ses_foreign', { id: 'ses_foreign', location: { directory: f.workspace } });
  },
  'event handshake failure': f => { f.eventFault = 'http'; },
  'unknown active status': f => { f.active[f.resume.sessionID] = { type: 'unknown' }; },
  'history HTTP 400': f => { f.rejectRequest = (method, route) => method === 'GET' && route.includes('/message?'); },
};
for (const [name, change] of Object.entries(unsafe)) test('resume refuses ' + name + ' and preserves original stop evidence', async t => {
  const f = await stopped(t); change(f);
  const before = readFileSync(f.statePath), callsFrom = f.calls.length;
  const result = await f.observe();
  assert.equal(result.kind, 'rejected', JSON.stringify(result)); assert.equal(result.phase, 'STOPPED');
  assert.equal(result.stateChange, 'unchanged'); assert.equal(result.taskSent, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RESUME_CANARY')); unchanged(f, before, callsFrom);
});

test('resume restores a correlated pending question without answering or spending a correction', async t => {
  const f = await stopped(t), callsFrom = f.calls.length, now = Date.now();
  f.messages.get(f.resume.sessionID).push({ id: 'msg_question', type: 'assistant', model, time: { created: now }, content: [
    { id: 'tool_question', type: 'tool', name: 'question', state: { status: 'running' } },
  ] });
  f.forms = [{ id: 'frm_resume', sessionID: f.resume.sessionID,
    metadata: { kind: 'question', tool: { messageID: 'msg_question', id: 'tool_question' } },
    fields: [{ key: 'q0', type: 'string', label: 'Fixture choice' }] }];
  const result = await f.observe(); assert.equal(result.kind, 'question'); assert.equal(result.phase, 'WAITING_FOR_ANSWER');
  assert.equal(result.request.id, 'frm_resume'); assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
});

test('a stale pending record is cleared only after verified completed-for-review', async t => {
  const f = await stopped(t);
  f.mutate(binding => { binding.pending = { kind: 'question', id: 'frm_old', fingerprint: '0'.repeat(64) }; });
  f.finish(f.resume.sessionID);
  assert.equal((await f.observe()).kind, 'completed-for-review'); assert.equal(f.state().bindings[0].pending, undefined);
  assert.equal(f.state().plans[0].correctionCount, 9);
});

test('two resumptions cannot own the same stopped assignment concurrently', async t => {
  const f = await stopped(t); f.finish(f.resume.sessionID);
  let release, notify;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { notify = resolve; });
  let first = true;
  f.onRequest = async route => { if (route.includes('/message?') && first) { first = false; notify(); await held; } };
  const waiting = f.observe(); await entered;
  try { await assert.rejects(f.observe(), /ownership locked/); }
  finally { release(); }
  assert.equal((await waiting).kind, 'completed-for-review'); assert.equal(f.state().plans[0].correctionCount, 9);
});

test('out-of-band counter drift is refused and never reset to the old count', async t => {
  const f = await stopped(t); f.finish(f.resume.sessionID);
  let changed;
  f.onRequest = route => { if (route.includes('/message?') && !changed) {
    f.mutate((binding, state) => { state.plans[0].correctionCount = 10; }); changed = readFileSync(f.statePath);
  } };
  const result = await f.observe(); assert.equal(result.kind, 'rejected'); assert.match(result.error, /assignment\/count changed/);
  assert.deepEqual(readFileSync(f.statePath), changed); assert.equal(f.state().plans[0].correctionCount, 10);
});

test('resumption at correction 20 may review the result without reserving cycle 21', async t => {
  const f = await stopped(t); f.mutate((binding, state) => { state.plans[0].correctionCount = 20; });
  f.finish(f.resume.sessionID);
  const result = await f.observe(); assert.equal(result.kind, 'completed-for-review'); assert.equal(result.correctionCount, 20);
  assert.equal(f.state().plans[0].correctionCount, 20); assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
});

test('a stream gap after successful resumption polls the same delivery to review', async t => {
  const f = await stopped(t);
  let notify, reads = 0;
  const observed = new Promise(resolve => { notify = resolve; });
  f.onRequest = route => { if (route.includes('/message?') && ++reads === 2) setTimeout(notify, 25); };
  const waiting = f.observe(); await observed; assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  for (const stream of f.streams) stream.end();
  f.finish(f.resume.sessionID);
  const result = await waiting; assert.equal(result.phase, 'REVIEWING'); assert.equal(result.kind, 'completed-for-review');
  assert.equal(f.state().plans[0].correctionCount, 9); assert.equal(result.assignmentID, f.resume.assignmentID);
  assert.equal(result.messageID, f.resume.messageID); assert.equal(f.posts('/api/session/' + f.resume.sessionID + '/prompt'), 1);
});

test('the P4 native instruction pattern resumes without broad synthetic-input exceptions', async t => {
  const f = await stopped(t), now = Date.now(), path = join(f.workspace, 'nested', 'AGENTS.md');
  f.messages.get(f.resume.sessionID).push(
    { id: 'msg_read', type: 'assistant', model, time: { created: now - 3, completed: now }, content: [
      { id: 'tool_read', type: 'tool', name: 'read', state: { status: 'completed', input: { path: join(f.workspace, 'nested', 'file') } },
        time: { ran: now - 2, completed: now } },
    ] },
    { id: 'msg_native', type: 'synthetic', metadata: { instruction: { paths: [path] } },
      text: 'Instructions from: ' + path + '\nPRIVATE_RESUME_CANARY', time: { created: now - 1 } });
  f.finish(f.resume.sessionID); const result = await f.observe();
  assert.equal(result.kind, 'completed-for-review'); assert.equal(result.correctionCount, 9);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RESUME_CANARY'));
  assert.ok(!readFileSync(f.statePath, 'utf8').includes('PRIVATE_RESUME_CANARY'));
});

test('an existing writer lock is not removed by resume-watch', async t => {
  const f = await stopped(t), lock = join(dirname(f.statePath), 'state.lock');
  writeFileSync(lock, 'FOREIGN_WRITER'); const before = readFileSync(f.statePath), callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /state locked/); assert.equal(readFileSync(lock, 'utf8'), 'FOREIGN_WRITER');
  unchanged(f, before, callsFrom);
});

test('prepared next assignment and changed engine identity cannot be resumed', async t => {
  const f = await stopped(t);
  f.mutate(binding => { binding.nextAssignment = 'correction'; });
  let before = readFileSync(f.statePath), callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /Resume selection/); unchanged(f, before, callsFrom);
  f.mutate(binding => { delete binding.nextAssignment; binding.engineID = 'changed-engine'; });
  before = readFileSync(f.statePath); callsFrom = f.calls.length;
  await assert.rejects(f.observe(), /Engine changed/); unchanged(f, before, callsFrom);
});

test('known no-write edit rejection permits active observation but unresolved terminal failure stays STOPPED', async t => {
  const f = await stopped(t), callsFrom = f.calls.length, path = join(f.workspace, 'edit-target.txt'), now = Date.now();
  writeFileSync(path, 'fixture');
  f.messages.get(f.resume.sessionID).push({ id: 'msg_failed_edit', type: 'assistant', model,
    time: { created: Date.now(), completed: Date.now() }, content: [
      { id: 'tool_failed_edit', type: 'tool', name: 'edit', time: { ran: now, completed: now },
        state: { status: 'error', input: { path, oldString: 'old', newString: 'new' }, error: { type: 'tool.execution',
          message: `Could not find oldString in ${path}. It must match exactly, including whitespace and indentation.` } } },
    ] });
  let notify, reads = 0;
  const observed = new Promise(resolve => { notify = resolve; });
  f.onRequest = route => { if (route.includes('/message?') && ++reads === 2) setTimeout(notify, 25); };
  const waiting = f.observe();
  await Promise.race([observed, waiting.then(result => assert.fail('Ended before readiness: ' + result.kind))]);
  assert.equal(f.state().bindings[0].phase, 'EXECUTING');
  f.finish(f.resume.sessionID);
  const result = await waiting; assert.equal(result.kind, 'failed'); assert.equal(result.phase, 'STOPPED');
  assert.equal(result.correctionCount, 9); assert.equal(result.taskSent, false);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
});

test('a hard assistant failure stays failed while live observation continues; idle cannot complete', async t => {
  const f = await stopped(t), callsFrom = f.calls.length;
  f.messages.get(f.resume.sessionID).push({ id: 'msg_failed_step', type: 'assistant', model,
    finish: 'error', content: [{ id: 'tool_failed', type: 'tool', name: 'edit', state: { status: 'error' } }] });
  const result = await f.observe({ once: true }); assert.equal(result.kind, 'observing');
  assert.equal(result.exchangeOutcome, 'failed'); assert.equal(result.reviewAllowed, false);
  assert.equal(result.exchangeFailure.reason, 'assistant-finish');
  f.finish(f.resume.sessionID);
  const terminal = await f.adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true });
  assert.equal(terminal.kind, 'failed'); assert.equal(terminal.phase, 'STOPPED');
  assert.equal(f.state().plans[0].correctionCount, 9);
  assert.ok(f.calls.slice(callsFrom).every(call => call.method === 'GET'));
});
