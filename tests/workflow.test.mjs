import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { helper } from '../helper/binding.mjs';
import { MODEL } from '../helper/connection.mjs';

const source = fileURLToPath(new URL('./fixtures/workflow/', import.meta.url));
const baseline = 'Baseline: isolated offline workflow fixture';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function layoutWalkthroughFixtures() {
  const root = process.env.CODE_DUET_WORKFLOW_EVIDENCE;
  if (!root) return;
  const index = readFileSync(join(source, 'plans', 'README.md'), 'utf8');
  const plan = readFileSync(join(source, 'plans', '001-label.md'), 'utf8');
  const canonical = { 'plans/README.md': index, 'plans/001-label.md': plan };
  const fallback = { 'plans/README.md': 'Different project-owned purpose: schematic artifacts. Not execution plans.\n',
    'advisor-plans/README.md': index, 'advisor-plans/001-label.md': plan };
  const cases = [
    { name: 'established', files: canonical, decision: 'Reuse plans; no new directory or plan.' },
    { name: 'fallback', files: fallback, decision: 'Reuse advisor-plans; preserve unrelated plans purpose.' },
    { name: 'ambiguous', files: { ...canonical, 'advisor-plans/README.md': index, 'advisor-plans/001-label.md': plan }, decision: 'STOP: both directories claim canonical ownership.' },
    { name: 'no-active', files: { 'plans/README.md': index.replace('| ACTIVE |', '| TODO |'), 'plans/001-label.md': plan.replace('Status: ACTIVE', 'Status: TODO') }, decision: 'STOP: no ACTIVE; do not choose newest.' },
    { name: 'multiple-active', files: { ...canonical, 'plans/README.md': index + '\n| 002 | Another | P1 | S | — | ACTIVE |\n', 'plans/002-other.md': plan.replace('Plan 001', 'Plan 002') }, decision: 'STOP: two ACTIVE entries.' },
    { name: 'required-executor', files: { ...canonical, 'plans/001-label.md': plan + '\nSubstantive required executor: ordinary local executor only; resolve before changing route.\n' }, decision: 'STOP: substantive executor conflict; historical profile alone would not be a conflict.' },
    { name: 'missing-count', files: { ...canonical, 'plans/001-label.md': plan.replace('- Correction count: 0 (initial fixture baseline).\n', '') }, decision: 'STOP: accepted history exists but count is missing; never import guessed zero.' },
  ];
  for (const item of cases) for (const [path, content] of Object.entries(item.files)) {
    const destination = join(root, 'selection', item.name, path);
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, content);
  }
  evidence('selection-fixtures', cases.map(item => ({ name: item.name, files: Object.keys(item.files), manualDecision: item.decision })));
}
layoutWalkthroughFixtures();
function evidence(name, value) {
  const root = process.env.CODE_DUET_WORKFLOW_EVIDENCE;
  if (!root) return;
  assert.ok(isAbsolute(root)); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}

function engine() {
  const sessions = new Map(), timelines = new Map();
  const client = {
    engineID: 'offline-engine', calls: [], active: {}, forms: {}, permissions: {}, losePrompt: false,
    async request(route, body) {
      this.calls.push({ route, body });
      if (route === '/api/session' && body) {
        const id = 'ses_offline' + (sessions.size + 1);
        sessions.set(id, { id, model: MODEL, location: body.location, time: {} }); timelines.set(id, []);
        return { data: structuredClone(sessions.get(id)) };
      }
      if (route === '/api/session/active') return { data: structuredClone(this.active) };
      const id = route.split('/')[3];
      if (route.endsWith('/prompt')) {
        timelines.get(id).push({ id: body.id, type: 'user', text: body.text, time: { created: Date.now() } });
        this.active[id] = { type: 'running' };
        if (this.losePrompt) throw new Error('Engine mutation uncertain; do not retry');
        return { data: { id: body.id, sessionID: id } };
      }
      if (route.endsWith('/reply')) { this.forms[id] = []; return; }
      if (route.endsWith('/form')) return { data: structuredClone(this.forms[id] ?? []) };
      if (route.endsWith('/permission')) return { data: structuredClone(this.permissions[id] ?? []) };
      if (route.includes('/message?')) return { data: structuredClone(timelines.get(id)).reverse(), cursor: {} };
      if (route.startsWith('/api/shell?')) return { data: [] };
      if (route === '/api/session/' + id) return { data: structuredClone(sessions.get(id)) };
      throw new Error('Unexpected offline route');
    },
    async events(signal) {
      let detach;
      return new Response(new ReadableStream({
        start(controller) {
          const abort = () => { try { controller.error(new Error('Aborted')); } catch {} };
          signal.addEventListener('abort', abort, { once: true }); detach = () => signal.removeEventListener('abort', abort);
        },
        cancel() { detach(); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
    complete(id, text = 'Executor claims source check passed. Runtime/owner acceptance remains NOT_RUN.') {
      const end = Date.now() + 1, messages = timelines.get(id);
      for (const message of messages) if (message.type === 'assistant' && !message.time.completed) {
        message.time.completed = end;
        for (const tool of message.content.filter(part => part.type === 'tool')) { tool.state.status = 'completed'; tool.time.completed = end; }
      }
      const suffix = String(messages.length);
      messages.push({ id: 'msg_final' + suffix, type: 'assistant', model: MODEL, finish: 'stop', time: { created: end, completed: end }, content: [{ type: 'text', text }] },
        { id: 'msg_idle' + suffix, type: 'idle', outcome: 'succeeded', time: { created: end } });
      const session = sessions.get(id); session.time = { idle: end, updated: end }; session.outcome = 'succeeded'; delete this.active[id];
    },
    question(id) {
      const messageID = 'msg_question' + timelines.get(id).length;
      timelines.get(id).push({ id: messageID, type: 'assistant', model: MODEL, time: { created: Date.now() }, content: [
        { id: 'call_question', type: 'tool', name: 'question', time: { created: Date.now() }, state: { status: 'running', input: {} } },
      ] });
      this.forms[id] = [{ id: 'frm_choice', sessionID: id, title: 'Choice',
        metadata: { kind: 'question', tool: { messageID, id: 'call_question' } },
        fields: [{ key: 'q0', type: 'string', options: [{ value: 'Yes', label: 'Yes' }], custom: true }] }];
    },
    sessions, timelines,
  };
  return client;
}

async function setup(t, { count, git = false, planDirectory = 'plans' } = {}) {
  const temporary = realpathSync(tmpdir()), root = mkdtempSync(join(temporary, 'duet-workflow-'));
  t.after(() => { assert.ok(resolve(root).startsWith(temporary + sep)); rmSync(root, { recursive: true }); });
  const workspace = join(root, 'workspace space & test'); cpSync(source, workspace, { recursive: true });
  if (planDirectory === 'advisor-plans') {
    renameSync(join(workspace, 'plans'), join(workspace, 'advisor-plans'));
    mkdirSync(join(workspace, 'plans')); writeFileSync(join(workspace, 'plans', 'README.md'), 'This plans directory belongs to unrelated project artifacts, not execution plans.\n');
  }
  const plan = join(workspace, planDirectory, '001-label.md'), index = join(workspace, planDirectory, 'README.md');
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('Correction count: 0', 'Correction count: ' + (count ?? 0)) + '\n' + baseline + '\n');
  const gitCommand = (...args) => execFileSync('git', args, { cwd: workspace, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git) {
    gitCommand('init', '--quiet');
    gitCommand('add', '.');
    gitCommand('-c', 'user.name=Offline workflow fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Offline fixture baseline');
  }
  const protectedFile = join(workspace, 'protected.txt');
  writeFileSync(protectedFile, readFileSync(protectedFile, 'utf8') + 'PRE_EXISTING_OWNER_DIRTY_EDIT\n');
  const client = engine(), stateRoot = join(root, 'state');
  const adapter = helper(client, { stateRoot, chatID: 'offline-chat-A' });
  const pair = await adapter.bind(workspace, plan, baseline, count);
  return {
    root, workspace, plan, index, client, adapter, pair, stateRoot, protectedFile, gitCommand,
    state: () => JSON.parse(readFileSync(adapter.statePath, 'utf8')),
    promptCount: () => client.calls.filter(call => call.route.endsWith('/prompt')).length,
    submit: (id = 'initial-1', kind = 'initial') => adapter.submit(workspace, plan, id, join(workspace, kind === 'correction' ? 'correction.txt' : 'initial.txt'), baseline, kind),
    wait: () => adapter.wait(workspace, plan, { nonGitBaseline: baseline, timeoutMs: 500 }),
    next: kind => adapter.next(workspace, plan, kind, baseline),
    finish: () => adapter.finish(workspace, plan, baseline),
  };
}
async function complete(f) { f.client.complete(f.pair.sessionID); assert.equal((await f.wait()).kind, 'completed-for-review'); }

test('explicit advisor-plans fallback reuses that physical canonical plan without creating a parallel plan', async t => {
  const f = await setup(t, { planDirectory: 'advisor-plans' }); await f.submit(); await complete(f);
  assert.equal(f.state().bindings[0].planPath, realpathSync(f.plan));
  assert.match(f.state().bindings[0].planPath, /advisor-plans/);
  assert.equal(readFileSync(join(f.workspace, 'plans', 'README.md'), 'utf8'), 'This plans directory belongs to unrelated project artifacts, not execution plans.\n');
  assert.equal(f.state().plans.length, 1);
});

test('ordinary plan walkthrough: initial -> independent review -> one correction -> accepted block with pending owner gate', async t => {
  const f = await setup(t, { git: true });
  const before = { plan: readFileSync(f.plan, 'utf8'), index: readFileSync(f.index, 'utf8'), protectedHash: hash(f.protectedFile), head: f.gitCommand('rev-parse', 'HEAD'), status: f.gitCommand('status', '--short') };
  assert.match(before.status, /protected.txt/);
  evidence('workflow-before', before);
  await f.submit();
  const submitted = f.client.calls.find(call => call.route.endsWith('/prompt')).body.text;
  assert.ok(submitted.includes(f.plan) || submitted.includes(JSON.stringify(f.plan)));
  assert.match(submitted, /Do not edit canonical plans\/index\/checkpoints/);
  assert.equal(f.state().plans[0].correctionCount, 0);
  // Deterministic fake executor writes its intentional first-pass defect; no real OpenCode call.
  const modulePath = join(f.workspace, 'label.mjs');
  writeFileSync(modulePath, 'export function label(value) { return String(value).toUpperCase(); }\n');
  await complete(f);
  const first = await import(pathToFileURL(modulePath).href + '?initial');
  assert.equal(first.label(' alpha '), ' ALPHA ');
  assert.notEqual(first.label(' alpha '), 'ALPHA'); // Independent review finds lost accepted trimming.
  assert.equal(hash(f.protectedFile), before.protectedHash);
  assert.equal(readFileSync(f.plan, 'utf8'), before.plan);
  writeFileSync(f.plan, before.plan + '\n### Advisor review of initial-1\n- OpenCode offline session ' + f.pair.sessionID +
    ', Go/Flash/default. Source claim checked: padded input FAIL; accepted trim regressed.\n- One consolidated correction assigned. Runtime/owner NOT_RUN; plan ACTIVE.\n');
  await f.next('correction'); assert.equal(f.state().plans[0].correctionCount, 0);
  const reusedID = await f.submit('initial-1', 'correction');
  assert.equal(reusedID.kind, 'rejected'); assert.equal(reusedID.phase, 'PREPARING');
  assert.equal(reusedID.stateChange, 'unchanged');
  await f.submit('correction-1', 'correction'); assert.equal(f.state().plans[0].correctionCount, 1);
  writeFileSync(modulePath, 'export function label(value) { return String(value).trim().toUpperCase(); }\n');
  await complete(f);
  const fixed = await import(pathToFileURL(modulePath).href + '?corrected');
  assert.equal(fixed.label(' alpha '), 'ALPHA'); assert.equal(fixed.label('beta'), 'BETA');
  assert.equal(hash(f.protectedFile), before.protectedHash);
  writeFileSync(f.plan, readFileSync(f.plan, 'utf8').replace('- Correction count: 0', '- Correction count: 1')
    .replace('- [ ] Block 2 independently reviewed.', '- [x] Block 2 independently reviewed.') +
    '\n### Advisor accepted block and handoff\n- Block 2 actual source assertions PASS; protected file unchanged. Correction count 1.\n' +
    '- Next route: ordinary Improve Codex (not invoked), same canonical plan and checkout; runtime/owner gate NOT_RUN.\n');
  const released = await f.finish(); assert.equal(released.phase, 'FINISHED');
  const after = { plan: readFileSync(f.plan, 'utf8'), index: readFileSync(f.index, 'utf8'), protectedHash: hash(f.protectedFile),
    head: f.gitCommand('rev-parse', 'HEAD'), status: f.gitCommand('status', '--short'), diff: f.gitCommand('diff', '--', 'label.mjs'),
    correctionCount: released.correctionCount, sessionID: released.sessionID };
  assert.equal(after.head, before.head); assert.equal(after.index, before.index);
  assert.match(after.index, /\| ACTIVE \|/); assert.match(after.plan, /- \[ \] Runtime\/owner acceptance/);
  assert.match(after.plan, /Accepted history: block 1 trim/); assert.match(after.plan, /improve_executor\/gpt-6-luna\/max/);
  assert.equal(after.protectedHash, before.protectedHash); assert.equal(f.promptCount(), 2);
  assert.match(after.diff, /trim\(\)\.toUpperCase/);
  evidence('workflow-after', after);
});

test('questions and next preparation do not consume corrections; accepted next block keeps count', async t => {
  const f = await setup(t); await f.submit();
  f.client.question(f.pair.sessionID); assert.equal((await f.wait()).kind, 'question');
  await f.adapter.reply(f.workspace, f.plan, 'question', 'frm_choice', { answer: { q0: 'Yes' } }, baseline);
  assert.equal(f.state().plans[0].correctionCount, 0);
  await complete(f); await f.next('correction'); await f.submit('fix-1', 'correction'); await complete(f);
  assert.equal(f.state().plans[0].correctionCount, 1);
  await f.next('block'); await f.submit('block-3', 'block'); await complete(f);
  assert.equal(f.state().plans[0].correctionCount, 1); assert.equal(f.promptCount(), 3);
});

test('fresh offline chat and explicit same-pair continuation preserve count', async t => {
  const f = await setup(t, { count: 18 }); await f.submit('fix-19', 'correction'); await complete(f); await f.finish();
  assert.equal((await f.next('block')).correctionCount, 19);
  await f.submit('accepted-next', 'block'); await complete(f); await f.finish();
  const other = helper(f.client, { stateRoot: f.stateRoot, chatID: 'offline-chat-B' });
  const pair = await other.bind(f.workspace, f.plan, baseline, 19);
  assert.notEqual(pair.sessionID, f.pair.sessionID); assert.equal(pair.correctionCount, 19);
  await other.submit(f.workspace, f.plan, 'fix-20', join(f.workspace, 'correction.txt'), baseline, 'correction');
  f.client.complete(pair.sessionID); assert.equal((await other.wait(f.workspace, f.plan, { nonGitBaseline: baseline })).kind, 'completed-for-review');
  assert.equal((await other.finish(f.workspace, f.plan, baseline)).correctionCount, 20);
});

for (const accept of [true, false]) test('correction 20 may be reviewed and ' + (accept ? 'accepted' : 'remain in review without 21'), async t => {
  const f = await setup(t, { count: 19 }); await f.submit('fix-20', 'correction'); await complete(f);
  assert.equal(f.state().plans[0].correctionCount, 20);
  const result = accept ? await f.finish() : await f.next('correction');
  assert.equal(result.phase, accept ? 'FINISHED' : 'REVIEWING');
  assert.equal(result.kind, accept ? 'released' : 'correction-limit');
  if (!accept) assert.equal(result.stateChange, 'unchanged');
  assert.equal(f.promptCount(), 1); assert.equal(f.state().plans[0].correctionCount, 20);
  if (!accept) {
    const rejected = await f.submit('fix-21', 'correction');
    assert.equal(rejected.kind, 'rejected'); assert.equal(rejected.phase, 'REVIEWING');
    assert.equal(rejected.stateChange, 'unchanged');
  }
});

test('fresh pair already at 20 stops before any corrective prompt', async t => {
  const f = await setup(t, { count: 20 });
  assert.equal((await f.submit('fix-21', 'correction')).kind, 'correction-limit');
  assert.equal(f.promptCount(), 0); assert.equal(f.state().plans[0].correctionCount, 20);
});

test('lost corrective admission reserves one possible delivery and never retries or refunds', async t => {
  const f = await setup(t, { count: 19 }); f.client.losePrompt = true;
  await assert.rejects(f.submit('fix-20', 'correction'), /uncertain/);
  assert.equal(f.state().plans[0].correctionCount, 20);
  assert.equal(f.state().bindings[0].phase, 'STOPPED'); assert.equal(f.promptCount(), 1);
  f.client.losePrompt = false;
  await assert.rejects(f.submit('fix-20', 'correction'), /stopped or mutation uncertain/);
  const other = helper(f.client, { stateRoot: f.stateRoot, chatID: 'offline-chat-B' });
  await assert.rejects(other.bind(f.workspace, f.plan, baseline), /no new writer/);
  assert.equal(f.promptCount(), 1); assert.equal(f.state().plans[0].correctionCount, 20);
});

test('kind mismatch and out-of-workspace packet do not spend a correction', async t => {
  const f = await setup(t); await f.submit(); await complete(f); await f.next('correction');
  const mismatch = await f.submit('wrong-kind', 'block');
  assert.equal(mismatch.kind, 'rejected'); assert.equal(mismatch.phase, 'PREPARING');
  assert.equal(mismatch.stateChange, 'unchanged');
  const outside = join(f.root, 'outside.txt'); writeFileSync(outside, 'not authorized');
  await assert.rejects(f.adapter.submit(f.workspace, f.plan, 'fix-1', outside, baseline, 'correction'), /Packet outside/);
  assert.equal(f.state().plans[0].correctionCount, 0); assert.equal(f.promptCount(), 1);
});

test('plan change reuses released pair and preserves independent plan counters', async t => {
  const f = await setup(t, { count: 7 }); await f.submit(); await complete(f);
  const second = join(dirname(f.plan), '002-other.md'); writeFileSync(second, baseline);
  await assert.rejects(f.adapter.bind(f.workspace, second, baseline), /not released/);
  await f.finish();
  const pair = await f.adapter.bind(f.workspace, second, baseline, 3);
  assert.equal(pair.sessionID, f.pair.sessionID); assert.equal(pair.kind, 'reused-plan'); assert.equal(pair.correctionCount, 3);
  await f.adapter.submit(f.workspace, second, 'other-1', join(f.workspace, 'initial.txt'), baseline, 'block');
  f.client.complete(pair.sessionID); await f.adapter.wait(f.workspace, second, { nonGitBaseline: baseline }); await f.adapter.finish(f.workspace, second, baseline);
  const original = await f.adapter.bind(f.workspace, f.plan, baseline, 7);
  assert.equal(original.sessionID, f.pair.sessionID); assert.equal(original.correctionCount, 7);
  assert.equal(f.client.calls.filter(call => call.route === '/api/session').length, 1);
});

test('count import refuses invalid values and conflicts without overwriting history', async t => {
  const f = await setup(t, { count: 7 });
  for (const count of [-1, 21, 0]) await assert.rejects(f.adapter.bind(f.workspace, f.plan, baseline, count), /count/);
  assert.equal(f.state().plans[0].correctionCount, 7);
  assert.equal(f.client.calls.filter(call => call.route === '/api/session').length, 1);
});

test('plan switch rechecks old execution and keeps the old binding stopped if it resumed', async t => {
  const f = await setup(t); await f.submit(); await complete(f); await f.finish();
  const second = join(dirname(f.plan), '002-other.md'); writeFileSync(second, baseline);
  f.client.active[f.pair.sessionID] = { type: 'running' };
  assert.equal((await f.adapter.bind(f.workspace, second, baseline)).phase, 'STOPPED');
  assert.equal(f.state().bindings[0].planPath, realpathSync(f.plan));
  assert.equal(f.state().plans.length, 1); assert.equal(f.promptCount(), 1);
});

for (const action of ['next', 'finish']) {
  test(action + ' cannot release an active assignment or accept an executor final alone', async t => {
    const f = await setup(t); await f.submit();
    const result = action === 'next' ? await f.next('block') : await f.finish();
    assert.equal(result.kind, 'rejected'); assert.equal(result.phase, 'EXECUTING');
    assert.equal(result.stateChange, 'unchanged'); assert.equal(f.state().bindings[0].phase, 'EXECUTING');
    assert.equal(f.promptCount(), 1);
  });
  test(action + ' rechecks pending/active state even after REVIEWING', async t => {
    const f = await setup(t); await f.submit(); await complete(f);
    f.client.active[f.pair.sessionID] = { type: 'running' };
    const result = action === 'next' ? await f.next('correction') : await f.finish();
    assert.equal(result.phase, 'STOPPED'); assert.equal(f.state().plans[0].correctionCount, 0);
  });
  test(action + ' refuses a late interactive request after REVIEWING', async t => {
    const f = await setup(t); await f.submit(); await complete(f);
    f.client.permissions[f.pair.sessionID] = [{ id: 'per_late', sessionID: f.pair.sessionID }];
    const result = action === 'next' ? await f.next('block') : await f.finish();
    assert.equal(result.phase, 'STOPPED'); assert.equal(f.promptCount(), 1);
  });
}
