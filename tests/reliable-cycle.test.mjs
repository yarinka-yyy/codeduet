import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';

const chatID = 'offline-http-chat-A';
const nonGit = ['--non-git-baseline', baseline];
const clientFor = f => connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
const adapterFor = (f, client) => helper(client, { stateRoot: dirname(f.statePath), chatID });
const saved = f => f.state().bindings[0];
const prompt = f => `/api/session/${saved(f).sessionID}/prompt`;
const wait = f => ['wait', f.workspace, f.plan, '--timeout-ms', '4000', ...nonGit];
const pins = ({ sessionID, assignmentID, messageID }) => ({ sessionID, assignmentID, messageID });
const resume = (f, b) => ['resume-watch', f.workspace, f.plan, b.assignmentID, b.messageID, '--session', b.sessionID, ...nonGit];

async function send(f) {
  assert.equal((await f.call(f.bindArgs(1))).result.kind, 'created');
  assert.equal((await f.call(f.submitArgs)).result.kind, 'admitted');
  return saved(f);
}

for (const [command, safe] of [
  ['Select-String -Path "*.md" -SimpleMatch -Pattern "start"', true],
  ['git log --oneline --grep="start"', true],
  ['Select-String -Path "*.md" -Pattern "$(Start-Process node.exe)"', false],
  ['git log --oneline --grep="start"; Start-Process node.exe', false],
]) test(`02: completed shell ${command}`, async t => {
  const f = await fixture(t, undefined, '2.2.7'), b = await send(f);
  f.messages.get(b.sessionID).push({ type: 'assistant', id: 'msg_tools', model, time: { completed: Date.now() }, content: [{
    type: 'tool', id: 'call_shell', name: 'shell', time: { ran: b.submittedAt, completed: Date.now() },
    state: { status: 'completed', input: { command }, metadata: { status: 'completed', exit: 0 } },
  }] });
  f.finish(b.sessionID);
  const { result } = await f.call(wait(f));
  if (safe) assert.equal(result.kind, 'completed-for-review', JSON.stringify(result));
  else {
    assert.equal(result.phase, 'STOPPED');
    assert.match(result.error, /possible detached launcher/);
    assert.match(result.report.text, /Simulator completed/);
    assert.equal(result.reviewAllowed, false);
    assert.equal(result.dispatchAllowed, false);
    assert.equal(result.result, undefined);
  }
  assert.equal(result.messageID, b.messageID);
  assert.equal(f.posts(prompt(f)), 1);
});

test('03–04: SSE 429 and disabled model leave the original result readable, but forbid new submission', async t => {
  const f = await fixture(t, undefined, '2.2.7'), b = await send(f);
  f.finish(b.sessionID);
  f.eventFault = 'http';
  f.models = [{ ...model, enabled: false }];
  const mark = f.calls.length;
  const { result } = await f.call(wait(f));
  assert.equal(result.kind, 'completed-for-review', JSON.stringify(result));
  assert.deepEqual(pins(result), pins(b));
  assert.equal(result.correctionCount, 2);
  assert.ok(f.calls.slice(mark).every(call => call.method === 'GET' && call.route !== '/api/model'));
  assert.equal(f.calls.slice(mark).filter(call => call.route === '/api/event').length, 1);
  assert.equal((await f.call(['inspect', f.workspace])).result.live.verified, true);
  assert.equal((await f.call(['finish', f.workspace, f.plan, ...nonGit])).result.kind, 'released');
  const refusal = await f.call([...f.submitArgs.slice(0, 3), 'disabled', ...f.submitArgs.slice(4)]);
  assert.match(refusal.result.error, /Required Go model unavailable/);
  assert.equal(f.posts(prompt(f)), 1);
});

test('08: an unavailable engine for a separate project leaves the original owner and assignment intact', async t => {
  const f = await fixture(t, undefined, '2.2.7'); await send(f);
  const other = join(f.root, 'other-project'), otherPlan = join(other, 'other.md');
  mkdirSync(other); writeFileSync(otherPlan, baseline);
  const before = readFileSync(f.statePath), mark = f.calls.length;
  f.fault = 'bootstrap-offline';
  const offline = await f.call(['bind', other, otherPlan, '--correction-count', '0', ...nonGit]);
  assert.equal(offline.result.diagnostic.httpStatus, 503);
  assert.equal(offline.result.stateChange, 'unchanged');
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.ok(f.calls.slice(mark).every(call => call.method === 'GET'));
  assert.equal(f.posts(prompt(f)), 1);
});

test('09: the observation deadline cancels an in-flight GET', async t => {
  const f = await fixture(t, undefined, '2.2.7'), b = await send(f);
  let readActive = false;
  f.onRequest = async route => {
    if (route === '/api/session/active') { readActive = true; await delay(2500); }
  };
  const { result } = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '650', ...nonGit]);
  assert.ok(readActive);
  assert.equal(result.diagnostic.category, 'deadline');
  assert.ok(result.diagnostic.elapsedMs < 2100, JSON.stringify(result));
  assert.equal(saved(f).messageID, b.messageID);
  assert.equal(f.posts(prompt(f)), 1);
});

test('10 and 15: a stopped archived delivery survives registration change without another POST', async t => {
  const f = await fixture(t, undefined, '2.2.7'), live = await clientFor(f);
  const old = adapterFor(f, { ...live, engineID: 'previous-engine' });
  await old.bind(f.workspace, f.plan, baseline, 1);
  await old.submit(f.workspace, f.plan, 'old-delivery', f.packet, baseline, 'correction');
  const b = saved(f);
  f.finish(b.sessionID);
  f.sessions.get(b.sessionID).time.archived = Date.now();
  await old.connectionLost(new Error('Observation interrupted'));
  const mark = f.calls.length;
  const rebound = ['rebind-engine', f.workspace, f.plan, b.messageID, '--session', b.sessionID, ...nonGit];
  const user = f.messages.get(b.sessionID).find(item => item.id === b.messageID), original = user.text;
  user.text += '\nchanged';
  assert.match((await f.call(rebound)).result.error, /prompt checksum changed/);
  assert.equal(saved(f).engineID, b.engineID);
  user.text = original;
  const { result: rebind } = await f.call(rebound);
  assert.equal(rebind.kind, 'engine-rebound', JSON.stringify(rebind));
  assert.equal(rebind.phase, 'STOPPED');
  const { result } = await f.call(resume(f, b));
  assert.equal(result.kind, 'completed-for-review', JSON.stringify(result));
  assert.deepEqual(pins(result), pins(b));
  assert.equal(result.correctionCount, 2);
  assert.match((await f.call(['next', f.workspace, f.plan, 'correction', ...nonGit])).result.error, /unavailable|archived/i);
  assert.ok(f.calls.slice(mark).every(call => call.method === 'GET'));
  assert.equal(f.posts(prompt(f)), 1);
});

test('11: inspect and wait see a live shell in the same parent checkout', async t => {
  const f = await fixture(t, undefined, '2.2.7');
  execFileSync('git', ['init', '--quiet', f.root], { windowsHide: true });
  const b = await send(f); f.finish(b.sessionID);
  const parent = '/api/shell?location[directory]=' + encodeURIComponent(f.root);
  f.onRequest = route => {
    if (route.startsWith('/api/shell?')) f.shells = route === parent ? [{ id: 'sh_parent', status: 'running', time: {} }] : [];
  };
  const { result: inspect } = await f.call(['inspect', f.workspace]);
  assert.equal(inspect.live.runningShells, 1);
  const { result } = await f.call(wait(f));
  assert.equal(result.phase, 'STOPPED');
  assert.match(result.error, /Project shell still running/);
  assert.match(result.report.text, /Simulator completed/);
  assert.equal(result.reviewAllowed, false);
  f.messages.get(b.sessionID).find(item => item.id === b.messageID).text += '\nUnexpected replacement';
  const changed = await f.call(resume(f, b));
  assert.equal(changed.result.phase, 'STOPPED');
  assert.equal(changed.result.report, undefined);
  assert.equal(f.posts(prompt(f)), 1);
});

test('12: native and legacy acceptance receipts permit only the template status change', async t => {
  const f = await fixture(t, undefined, '2.2.7');
  const original = `${baseline}\n## Status\n- Status: ACTIVE; Priority: P1; Effort: M; Risk: MED.\n## Scope\n- Preserve the supported API.\n`;
  writeFileSync(f.plan, original);
  const b = await send(f); f.finish(b.sessionID);
  assert.equal((await f.call(wait(f))).result.kind, 'completed-for-review');
  assert.equal((await f.call(['finish', f.workspace, f.plan, ...nonGit])).result.kind, 'released');
  const receiptPath = join(dirname(f.statePath), 'accepted-deliveries', b.messageID + '.json');
  const check = () => f.call(['acceptance-status', f.workspace, f.plan, b.messageID]);
  const checkpoint = `\n## Review checkpoint (advisor-owned)\n<!-- code-duet-accepted ${b.messageID} -->\n`;
  const done = original.replace('Status: ACTIVE', 'Status: DONE');
  writeFileSync(f.plan, done + checkpoint);
  assert.equal((await check()).result.checkpointRecorded, true);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.planHash = createHash('sha256').update(original.trimEnd()).digest('hex');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.equal((await check()).result.checkpointRecorded, true);
  for (const changed of [done.replace('Priority: P1', 'Priority: P2'), done.replace('Preserve', 'Remove'), done.replace(baseline, 'Changed baseline')]) {
    writeFileSync(f.plan, changed + checkpoint);
    assert.match((await check()).result.error, /Plan does not match/);
  }
});

test('14: pre-POST save failure refunds exactly the reservation; a lost ACK does not', async t => {
  const f = await fixture(t, undefined, '2.2.7');
  const adapter = adapterFor(f, await clientFor(f));
  await adapter.bind(f.workspace, f.plan, baseline, 1);
  const before = f.state(), rename = fs.renameSync;
  let interrupted = false;
  const hook = t.mock.method(fs, 'renameSync', (src, dst) => {
    const reserving = dst === f.statePath && JSON.parse(readFileSync(src, 'utf8')).bindings[0]?.uncertain === 'submit';
    rename(src, dst);
    if (reserving && !interrupted) { interrupted = true; throw Object.assign(new Error('Injected EIO before POST'), { code: 'EIO' }); }
  });
  syncBuiltinESMExports();
  const submit = () => adapter.submit(f.workspace, f.plan, 'send-once', f.packet, baseline, 'correction');
  try { await assert.rejects(submit(), error => error.stateOutcome?.taskSent === false && error.stateOutcome?.phase === 'PREPARING'); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(interrupted);
  assert.equal(f.posts(prompt(f)), 0);
  assert.deepEqual(f.state(), before);
  f.fault = 'prompt-ack-lost';
  await assert.rejects(submit());
  assert.equal(saved(f).uncertain, 'submit');
  assert.equal(f.state().plans[0].correctionCount, 2);
  assert.equal(f.posts(prompt(f)), 1);
  const messageID = saved(f).messageID;
  f.fault = null;
  assert.equal((await adapter.reconcile(f.workspace, f.plan, baseline)).messageID, messageID);
  assert.equal(f.posts(prompt(f)), 1);
});

test('isolated complete cycle: 12 corrections, one observation interruption, each delivery sent once', async t => {
  const f = await fixture(t, undefined, '2.2.7');
  const adapter = adapterFor(f, await clientFor(f));
  await adapter.bind(f.workspace, f.plan, baseline, 0);
  const sent = [];
  for (let round = 0; round <= 12; round++) {
    if (round) assert.equal((await adapter.next(f.workspace, f.plan, 'correction', baseline)).phase, 'PREPARING');
    const admitted = await adapter.submit(f.workspace, f.plan, `round-${round}`, f.packet, baseline, round ? 'correction' : 'initial');
    assert.equal(admitted.kind, 'admitted');
    sent.push(admitted.messageID);
    if (round === 6) await adapter.connectionLost(new Error('Simulated interruption during observation'));
    f.finish(admitted.sessionID);
    const result = await adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, once: true, ...(round === 6 ? { resume: pins(admitted) } : {}) });
    assert.equal(result.kind, 'completed-for-review', JSON.stringify(result));
    assert.deepEqual(pins(result), pins(admitted));
    assert.equal(result.correctionCount, round);
  }
  const finished = await adapter.finish(f.workspace, f.plan, baseline);
  assert.equal(finished.phase, 'FINISHED');
  assert.equal(finished.correctionCount, 12);
  assert.equal(f.posts(prompt(f)), 13);
  assert.deepEqual(f.messages.get(saved(f).sessionID).filter(item => item.type === 'user').map(item => item.id), sent);
  assert.equal(new Set(sent).size, 13);
});
