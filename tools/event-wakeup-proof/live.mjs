// Explicit live Desktop test with a disposable HTTP/SSE simulator, never the real OpenCode.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fixture, baseline, model } from '../../tests/http-fixture.mjs';
import { connect } from '../../helper/connection.mjs';
import { helper } from '../../helper/binding.mjs';
import { observer } from '../../helper/observer.mjs';

const [command, evidence, id] = process.argv.slice(2);
assert.ok(isAbsolute(evidence ?? ''), 'Use an absolute isolated evidence directory');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const log = data => appendFileSync(join(evidence, 'live.jsonl'), JSON.stringify({ at: Date.now(), ...data }) + '\n');
const here = fileURLToPath(import.meta.url);
function history(chatID) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
  const directory = join(homedir(), '.codex', 'sessions', date);
  const names = readdirSync(directory).filter(name => name.endsWith(chatID + '.jsonl'));
  assert.equal(names.length, 1);
  const rows = readFileSync(join(directory, names[0]), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find(row => row.type === 'session_meta').payload.id, chatID);
  return { starts: rows.filter(row => row.type === 'event_msg' && row.payload.type === 'task_started').length,
    completes: rows.filter(row => row.type === 'event_msg' && row.payload.type === 'task_complete').length,
    usage: rows.filter(row => row.type === 'token_usage_record').length };
}

if (command === 'serve') {
  mkdirSync(evidence, { recursive: true });
  assert.ok(!existsSync(join(evidence, 'fixture.json')), 'Never replace a live fixture');
  const cleanup = [], f = await fixture({ after: callback => cleanup.push(callback) }, undefined, '2.2.0');
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify({ root: f.root, workspace: f.workspace, plan: f.plan,
    packet: f.packet, stateRoot: dirname(f.statePath), registration: join(f.home, '.local/state/opencode/service.json') }));
  log({ kind: 'fixture-started', pid: process.pid });
  let stage = 0, before, started, lastCompletions = 0;
  const end = Date.now() + 20 * 60 * 1000;
  while (!existsSync(join(evidence, 'stop')) && Date.now() < end) {
    await new Promise(done => setTimeout(done, 250));
    if (!existsSync(join(evidence, 'chat.json'))) continue;
    const chatID = read(join(evidence, 'chat.json')).chatID;
    const folder = join(dirname(f.statePath), 'observers', createHash('sha256').update(chatID).digest('hex'));
    if (!existsSync(join(folder, 'active'))) continue;
    const receipt = read(join(folder, 'active')).id, dir = join(folder, receipt);
    if (!existsSync(join(dir, 'ready.json'))) continue;
    const current = history(chatID);
    if (!started && current.starts === current.completes && current.completes > lastCompletions && stage < 2) {
      before = current; started = Date.now();
      log({ kind: 'idle-start', stage, chatID, receipt, counts: before });
    }
    if (!started || Date.now() - started < 120000) continue;
    const after = history(chatID); assert.deepEqual(after, before, 'GPT woke before the fixture event');
    const session = f.state().bindings[0].sessionID;
    if (stage === 0) {
      f.messages.get(session).push({ id: 'msg_tool', type: 'assistant', model, time: { created: Date.now() },
        content: [{ id: 'call_question', type: 'tool', name: 'question', time: { created: Date.now() }, state: { status: 'running', input: {} } }] });
      f.forms = [{ id: 'frm_question', sessionID: session,
        metadata: { kind: 'question', tool: { messageID: 'msg_tool', id: 'call_question' } },
        title: 'Synthetic test question: choose fixture', fields: [{ key: 'answer', type: 'string', required: true }] }];
      f.emit('form.created', session);
    } else f.finish(session);
    log({ kind: 'significant-event', stage, event: stage === 0 ? 'question' : 'completed', chatID, receipt,
      idleMs: Date.now() - started, before, after, count: f.state().plans[0].correctionCount,
      promptPosts: f.posts(`/api/session/${session}/prompt`) });
    lastCompletions = current.completes; started = null; stage++;
  }
  const state = existsSync(f.statePath) ? f.state() : null;
  writeFileSync(join(evidence, 'final.json'), JSON.stringify({ stage, state, calls: f.calls, closedAt: Date.now() }, null, 2));
  for (const callback of cleanup.reverse()) await callback();
  log({ kind: 'fixture-stopped' });
} else if (command === 'stop') {
  const config = read(join(evidence, 'fixture.json'));
  assert.match(config.root, /duet-http-/);
  writeFileSync(join(evidence, 'stop'), 'Stop only the disposable simulator.\n', { flag: 'wx' });
} else {
  const config = read(join(evidence, 'fixture.json'));
  assert.match(config.root, /duet-http-/); assert.ok(config.stateRoot.startsWith(config.root));
  const chatID = process.env.CODEX_THREAD_ID;
  const connectEngine = () => connect({ registrationPath: config.registration });
  let o;
  o = observer({ stateRoot: config.stateRoot, chatID, connectEngine,
    launch: async receipt => {
      const child = spawn(process.execPath, [here, 'worker', evidence, receipt], { detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
    } });
  let result;
  if (command === 'arm' || command === 'migrate-arm') {
    const adapter = helper(await connectEngine(), { stateRoot: config.stateRoot, chatID });
    if (!existsSync(join(config.stateRoot, 'state.json'))) {
      await adapter.bind(config.workspace, config.plan, baseline, 8);
      await adapter.submit(config.workspace, config.plan, 'live-observer-correction-nine', config.packet, baseline, 'correction');
      writeFileSync(join(evidence, 'chat.json'), JSON.stringify({ chatID }));
    }
    assert.equal(read(join(evidence, 'chat.json')).chatID, chatID, 'Wrong live test chat');
    if (command === 'migrate-arm') {
      assert.ok(!existsSync(join(evidence, 'migration.json')), 'Never repeat a migration test');
      await adapter.connectionLost(new Error('Disposable pre-migration interruption'));
      const saved = read(join(config.stateRoot, 'state.json')).bindings[0];
      const child = spawn(process.execPath, [here, 'foreground', evidence],
        { windowsHide: true, stdio: 'ignore' });
      const done = new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
      const end = Date.now() + 15000;
      while (!existsSync(join(evidence, 'foreground-ready.json')) && Date.now() < end) {
        assert.equal(child.exitCode, null, 'Disposable foreground exited before readiness');
        await new Promise(done => setTimeout(done, 100));
      }
      assert.ok(existsSync(join(evidence, 'foreground-ready.json')), 'Disposable foreground not ready');
      const ownerDir = join(config.stateRoot, 'ownership');
      const names = readdirSync(ownerDir); assert.equal(names.length, 1);
      const owner = read(join(ownerDir, names[0]));
      assert.equal(owner.codexChat, chatID); assert.equal(owner.process.pid, child.pid);
      assert.equal(owner.assignmentID, saved.assignmentID); assert.equal(owner.messageID, saved.messageID);
      const stopped = await adapter.observationOwner(config.workspace, config.plan, owner.token,
        { action: 'stop', nonGitBaseline: baseline });
      assert.equal(stopped.ownerStatus, 'live'); assert.equal(stopped.kind, 'observation-released');
      await done;
      const after = read(join(config.stateRoot, 'state.json'));
      assert.equal(after.bindings[0].phase, 'STOPPED'); assert.equal(after.plans[0].correctionCount, 9);
      for (const key of ['sessionID', 'assignmentID', 'messageID', 'submittedAt'])
        assert.equal(after.bindings[0][key], saved[key]);
      writeFileSync(join(evidence, 'migration.json'), JSON.stringify({ chatID, owner, stopped, deliveryUnchanged: true }));
      log({ kind: 'foreground-migrated', chatID, stopped });
    }
    result = await o.arm(config.workspace, config.plan, { nonGitBaseline: baseline, timeoutMs: 600000,
      resume: command === 'migrate-arm', codexExe: 'C:/Users/Yarin/AppData/Local/OpenAI/Codex/bin/08d187884f2330d1/codex.exe' });
  } else if (command === 'foreground') {
    const adapter = helper(await connectEngine(), { stateRoot: config.stateRoot, chatID });
    const saved = read(join(config.stateRoot, 'state.json')).bindings[0];
    result = await adapter.wait(config.workspace, config.plan, { nonGitBaseline: baseline, timeoutMs: 600000,
      resume: Object.fromEntries(['sessionID', 'assignmentID', 'messageID'].map(key => [key, saved[key]])),
      onReady: () => writeFileSync(join(evidence, 'foreground-ready.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx' }) });
  } else if (command === 'reply') {
    result = await helper(await connectEngine(), { stateRoot: config.stateRoot, chatID }).reply(config.workspace, config.plan,
      'question', 'frm_question', { answer: { answer: 'fixture' } }, baseline);
  } else if (['worker', 'consume', 'cancel', 'status'].includes(command)) result = await o[command](id);
  else throw new Error('serve | arm | migrate-arm | foreground | consume ID | reply | status | cancel ID | stop');
  if (result) { log({ kind: 'chat-operation', command, chatID, result }); console.log(JSON.stringify(result)); }
}
