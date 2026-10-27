import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installation-specific proof: never select a production chat or OpenCode recipient.
export const TARGET = '01a17e9d-d0a5-7a91-b8a5-55090cc96633';
export const READY = 'CODEDUET_READY_016';
const EVENT = 'CODEDUET_EVENT_016';
const ACK = 'CODEDUET_EVENT_ACK_016';

export function snapshot(text) {
  const rows = text.trim().split('\n').map(JSON.parse);
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  assert.equal(meta?.id, TARGET, 'Not the disposable proof chat');
  const events = rows.filter(row => row.type === 'event_msg');
  const context = rows.filter(row => row.type === 'turn_context').at(-1)?.payload;
  return {
    starts: events.filter(row => row.payload.type === 'task_started').length,
    completes: events.filter(row => row.payload.type === 'task_complete').length,
    usageRecords: rows.filter(row => row.type === 'token_usage_record').length,
    markers: rows.filter(row => row.type === 'response_item' && row.payload.type === 'message')
      .flatMap(row => row.payload.content ?? [])
      .map(item => item.text).filter(text => [READY, ACK].includes(text)),
    model: context?.model, effort: context?.effort, cwd: context?.cwd,
  };
}

export function assertIdle(before, after) {
  assert.equal(before.starts, 1, 'Proof requires exactly one initial turn');
  assert.equal(before.completes, 1, 'Initial turn is not complete');
  assert.ok(before.markers.includes(READY), 'Initial proof response missing');
  assert.match(before.cwd, /codeduet-wakeup-proof-016$/);
  assert.deepEqual(after, before, 'Test chat changed before the event; do not deliver');
}

function rpc(executable, record) {
  const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let next = 0;
  let buffer = '';
  let stderrBytes = 0;
  const fail = error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', data => { stderrBytes += data.length; });
  child.on('exit', code => {
    record('server-exit', { code, stderrBytes });
    fail(new Error('Temporary App Server exited'));
  });
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
          else waiter.resolve(message.result);
        } else if (message.params?.threadId === TARGET && ['turn/started', 'turn/completed', 'thread/tokenUsage/updated'].includes(message.method)) {
          record(message.method, { turnId: message.params.turn?.id, status: message.params.turn?.status });
        }
      } catch (error) { fail(error); }
    }
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ method, ...(params ? { params } : {}) }) + '\n');
  return {
    child, notify,
    call(method, params) {
      const id = ++next;
      record('rpc', { method });
      return new Promise((resolveCall, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC deadline: ${method}; no retry`));
        }, 25000);
        pending.set(id, {
          resolve: result => { clearTimeout(timer); resolveCall(result); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
  };
}

async function main([executable, rollout, output, delivery = 'tool-output']) {
  assert.ok(executable && rollout && output, 'Usage: node probe.mjs CODEX_EXE TEST_ROLLOUT NEW_REPORT');
  assert.ok(['tool-output', 'queue'].includes(delivery), 'Unknown delivery route');
  // Exclusive receipt prevents accidentally rerunning this notification after an uncertain result.
  writeFileSync(output, JSON.stringify({ target: TARGET, status: 'reserved' }) + '\n', { flag: 'wx' });
  const started = Date.now();
  const report = { target: TARGET, delivery, startedAt: new Date(started).toISOString(), status: 'running', records: [] };
  const record = (type, fields = {}) => {
    report.records.push({ elapsedMs: Date.now() - started, type, ...fields });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ type, ...fields }));
  };
  const client = rpc(executable, record);
  try {
    await client.call('initialize', { clientInfo: { name: 'codeduet_wakeup_proof', version: '0.1' }, capabilities: { experimentalApi: true } });
    client.notify('initialized');
    const baseline = snapshot(readFileSync(rollout, 'utf8'));
    assertIdle(baseline, baseline);
    const read = await client.call('thread/read', { threadId: TARGET, includeTurns: true });
    assert.equal(read.thread.id, TARGET);
    assert.equal(read.thread.turns.length, 1);
    assert.equal(read.thread.turns[0].status, 'completed');
    report.baseline = baseline;
    record('idle-start', { durationMs: 120000 });
    await new Promise(done => setTimeout(done, 120000));
    const idle = snapshot(readFileSync(rollout, 'utf8'));
    assertIdle(baseline, idle);
    report.idle = idle;
    record('event', { id: EVENT, idleMs: Date.now() - started });
    // Only metadata/stdio was used above. The synthetic external event starts the sole new turn.
    if (delivery === 'tool-output') {
      const resumed = await client.call('thread/resume', { threadId: TARGET });
      assert.equal(resumed.thread.id, TARGET);
      report.resumedModel = resumed.model;
      assert.equal(resumed.model, baseline.model, 'Model changed; do not start');
      const result = await client.call('turn/start', {
        threadId: TARGET, input: [],
        toolOutput: { name: 'codeduet_observer_proof', namespace: null, output: EVENT + ': synthetic observer event, no task execution authority.' },
      });
      report.admittedTurn = { id: result.turn.id, status: result.turn.status };
      record('event-admitted', report.admittedTurn);
    } else {
      record('queue-attempt');
      await new Promise((done, reject) => {
        const queue = spawn(executable, ['queue', '--thread', TARGET, '--message', EVENT + ': synthetic observer event, no task execution authority.'], { windowsHide: true });
        let diagnostic = '';
        const capture = data => { diagnostic = (diagnostic + data.toString()).slice(-2000); };
        queue.stdout.on('data', capture);
        queue.stderr.on('data', capture);
        const timer = setTimeout(() => { queue.kill(); reject(new Error('Queue deadline; delivery uncertain; do not resend')); }, 25000);
        queue.on('error', error => { clearTimeout(timer); reject(error); });
        queue.on('close', code => {
          clearTimeout(timer);
          record('queue-exit', { code, diagnostic });
          if (code === 0) done();
          else reject(new Error('Queue failed; no automatic retry'));
        });
      });
    }
    // This bounded file check is ordinary code; no model calls or periodic wake messages.
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 1000));
      const after = snapshot(readFileSync(rollout, 'utf8'));
      if (after.completes > baseline.completes) {
        report.after = after;
        assert.equal(after.starts, 2);
        assert.equal(after.completes, 2);
        assert.equal(after.model, baseline.model);
        assert.equal(after.effort, baseline.effort);
        assert.equal(after.cwd, baseline.cwd);
        assert.ok(after.markers.includes(ACK), 'No event acknowledgment');
        report.status = 'local-roundtrip-passed-desktop-verification-required';
        record('local-roundtrip-complete');
        return;
      }
    }
    throw new Error('No confirmed completion before deadline; do not resend');
  } catch (error) {
    report.status = 'stopped-no-retry';
    record('error', { code: error.code ?? null, message: String(error.message).slice(0, 1000) });
    process.exitCode = 1;
  } finally {
    client.child.stdin.end();
    const kill = setTimeout(() => client.child.kill(), 5000);
    client.child.once('exit', () => clearTimeout(kill));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
