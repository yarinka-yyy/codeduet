import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, baseline } from './http-fixture.mjs';

const oldChat = 'offline-http-chat-A', newChat = 'offline-http-chat-B';
const baselineArgs = ['--non-git-baseline', baseline];

async function artex(t, scenario = 'ended') {
  const f = await fixture(t, undefined, '2.2.5');
  const target = join(dirname(f.plan), '002-windows-native.md');
  writeFileSync(f.plan, baseline + '\n\nB1a: BLOCKED. Linux acceptance discontinued.\n');
  writeFileSync(target, baseline + '\n\nWindows stage 1: TODO.\n');
  assert.equal((await f.call(f.bindArgs(5))).status, 0);
  const sessionID = f.state().bindings[0].sessionID;
  if (scenario === 'uncertain') f.fault = 'drop';
  const old = await f.call(['submit', f.workspace, f.plan, 'B1a-tool-output-fix-01', f.packet,
    '--kind', 'correction', ...baselineArgs]);
  assert.equal(old.status, scenario === 'uncertain' ? 1 : 0, JSON.stringify(old));
  f.fault = null;
  if (!['uncertain', 'active'].includes(scenario)) {
    f.finish(sessionID);
    f.messages.get(sessionID).at(-2).content[0].text = 'BLOCKED: Linux acceptance is unavailable.';
    const waited = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '3000', ...baselineArgs]);
    assert.equal(waited.result.phase, 'REVIEWING', JSON.stringify(waited));
  }
  const source = f.state().bindings[0];
  return Object.assign(f, { source, target, sessionID,
    preflight: ['preflight', f.workspace, target, ...baselineArgs],
    transition: ['transition', f.workspace, target, source.messageID, 'blocked', ...baselineArgs],
    submit: ['submit', f.workspace, target, 'windows-stage-1', f.packet, ...baselineArgs],
    prompt: `/api/session/${sessionID}/prompt` });
}

for (const chat of [oldChat, newChat]) {
  test(`ARTEX: advance from BLOCKED to the Windows plan from ${chat}`, async t => {
    const f = await artex(t), before = readFileSync(f.statePath), oldPlan = readFileSync(f.plan);
    const history = structuredClone(f.messages.get(f.sessionID)), callCount = f.calls.length;
    const report = (await f.call(f.preflight, chat)).result;
    assert.equal(report.status, 'blocked');
    assert.equal(report.transition.status, 'ready', JSON.stringify(report));
    assert.equal(report.transition.messageID, f.source.messageID);
    assert.deepEqual(readFileSync(f.statePath), before);
    const args = [report.transition.command, ...report.transition.args, 'blocked', ...report.transition.options];
    const prepared = await f.call(args, chat);
    assert.equal(prepared.status, 0, JSON.stringify(prepared));
    assert.equal(prepared.result.previous.disposition, 'blocked');
    assert.equal(prepared.result.previous.correctionCount, 6);
    assert.deepEqual((await f.call(args, chat)).result, prepared.result);
    assert.ok(f.calls.slice(callCount).every(call => call.method === 'GET'));
    assert.deepEqual(f.messages.get(f.sessionID), history);
    assert.deepEqual(readFileSync(f.plan), oldPlan);
    const receipt = JSON.parse(readFileSync(join(dirname(f.statePath), 'assignment-transitions', f.source.messageID + '.json')));
    assert.deepEqual(receipt.source, f.source);
    assert.deepEqual(f.state().bindings.map(item => [item.codexChat, item.planPath]), [[chat, f.target]]);
    const ready = await f.call(f.preflight, chat);
    assert.equal(ready.status, 0, JSON.stringify(ready));
    assert.equal(ready.result.correctionCount.effective, 0);
    assert.equal((await f.call([ready.result.nextCommand.command, ...ready.result.nextCommand.args], chat)).status, 0);
    assert.equal((await f.call(f.submit, chat)).result.kind, 'admitted');
    assert.equal((await f.call(f.submit, chat)).status, 1);
    assert.deepEqual((await f.call(args, chat)).result, prepared.result);
    assert.equal(f.posts(f.prompt), 2);
    assert.equal(f.posts('/api/session'), 1);
    assert.deepEqual(f.state().plans.map(plan => plan.correctionCount), [6, 0]);
  });
}

for (const scenario of ['active', 'uncertain', 'pending question', 'no terminal idle']) {
  test(`ARTEX: ${scenario} keeps the original owner and prevents new execution`, async t => {
    const f = await artex(t, scenario);
    if (scenario === 'pending question') f.forms = [{ sessionID: f.sessionID, id: 'frm_pending' }];
    if (scenario === 'no terminal idle') f.messages.get(f.sessionID).pop();
    const before = readFileSync(f.statePath), callCount = f.calls.length;
    const report = await f.call(f.preflight, newChat);
    assert.equal(report.result.transition.status, 'blocked', JSON.stringify(report));
    assert.match(report.result.transition.reason, /active|awaiting|uncertain|terminal idle/i);
    assert.equal((await f.call(f.transition, newChat)).status, 1);
    assert.equal((await f.call(['bind', f.workspace, f.target, ...baselineArgs], newChat)).status, 1);
    assert.deepEqual(readFileSync(f.statePath), before);
    assert.ok(f.calls.slice(callCount).every(call => call.method === 'GET'));
  });
}

test('competing transitions and concurrent submits have one winner', async t => {
  const f = await artex(t);
  const outcomes = await Promise.all([f.call(f.transition, oldChat), f.call(f.transition, newChat)]);
  assert.deepEqual(outcomes.map(item => item.status).sort(), [0, 1], JSON.stringify(outcomes));
  const winner = f.state().bindings[0].codexChat, loser = winner === oldChat ? newChat : oldChat;
  assert.equal((await f.call(['bind', f.workspace, f.target, ...baselineArgs], loser)).status, 1);
  assert.equal((await f.call(f.transition, loser)).status, 1);
  const sends = await Promise.all([f.call(f.submit, winner), f.call(f.submit, winner), f.call(f.submit, loser)]);
  assert.equal(sends.filter(item => item.result.kind === 'admitted').length, 1, JSON.stringify(sends));
  assert.equal(f.posts(f.prompt), 2);
  assert.equal(f.state().bindings.length, 1);
});

test('a shell starting after transition preflight keeps the reviewed owner', async t => {
  const f = await artex(t);
  const ready = await f.call(f.preflight, newChat);
  assert.equal(ready.result.transition.status, 'ready', JSON.stringify(ready.result));
  const before = readFileSync(f.statePath), start = f.calls.length;
  f.shells = [{ id: 'sh_late', status: 'running' }];
  const outcome = await f.call(f.transition, newChat);
  assert.equal(outcome.status, 1, JSON.stringify(outcome.result));
  assert.match(outcome.result.error, /shell.*running/i);
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.ok(f.calls.slice(start).every(call => call.method === 'GET'));
});

for (const variant of ['low', 'foreign']) {
  test('review and transition agree on a late model change: ' + variant, async t => {
    const f = await artex(t), session = f.sessions.get(f.sessionID);
    const previous = session.model;
    session.model = { ...previous, variant: 'low' };
    f.messages.get(f.sessionID).push({ id: 'msg_lateModel', type: 'model-switched',
      previous, model: variant === 'low' ? session.model : { ...session.model, providerID: 'other' },
      time: { created: session.time.idle + 1 } });
    const preview = (await f.call(['preflight', f.workspace, f.plan, ...baselineArgs], oldChat)).result;
    const history = preview.checks.find(check => check.name === 'history');
    assert.equal(history.status, variant === 'low' ? 'pass' : 'blocked', JSON.stringify(preview));
    const accepted = ['transition', f.workspace, f.target, f.source.messageID, 'accepted', ...baselineArgs];
    if (variant === 'foreign') {
      assert.equal(preview.transition.status, 'blocked');
      assert.equal((await f.call(accepted, newChat)).status, 1);
      assert.equal(f.state().bindings[0].phase, 'REVIEWING');
      return;
    }
    assert.equal(preview.transition.status, 'ready');
    const waited = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '3000', ...baselineArgs]);
    assert.equal(waited.result.kind, 'completed-for-review', JSON.stringify(waited.result));
    const finished = await f.call(['finish', f.workspace, f.plan, ...baselineArgs]);
    assert.equal(finished.result.kind, 'released', JSON.stringify(finished.result));
    assert.equal((await f.call(accepted, newChat)).result.kind, 'transition-prepared');
    const result = await f.call(f.submit, newChat);
    assert.equal(result.status, 0, JSON.stringify(result.result));
    assert.equal(session.model.variant, 'high');
    assert.equal(f.posts(f.prompt), 2);
  });
}

test('an archived result remains reviewable while dispatch and transition are blocked', async t => {
  const f = await artex(t);
  f.sessions.get(f.sessionID).time.archived = Date.now();
  const start = f.calls.length;
  const preview = (await f.call(['preflight', f.workspace, f.plan, ...baselineArgs])).result;
  assert.equal(preview.checks.find(check => check.name === 'history').status, 'pass');
  assert.equal(preview.checks.find(check => check.name === 'session-availability').status, 'blocked');
  assert.match(preview.nextStep, /unarchive.*preflight/i);
  const waited = await f.call(['wait', f.workspace, f.plan, '--timeout-ms', '3000', ...baselineArgs]);
  assert.equal(waited.result.kind, 'completed-for-review', JSON.stringify(waited.result));
  assert.equal((await f.call(f.transition, newChat)).status, 1);
  assert.equal((await f.call(['next', f.workspace, f.plan, 'block', ...baselineArgs])).status, 1);
  assert.equal(f.state().bindings[0].phase, 'REVIEWING');
  const finished = await f.call(['finish', f.workspace, f.plan, ...baselineArgs]);
  assert.equal(finished.result.kind, 'released', JSON.stringify(finished.result));
  assert.ok(f.calls.slice(start).every(call => call.method === 'GET'));
  delete f.sessions.get(f.sessionID).time.archived;
  assert.equal((await f.call(['next', f.workspace, f.plan, 'block', ...baselineArgs])).status, 0);
  f.sessions.get(f.sessionID).time.archived = Date.now();
  const submit = await f.call(['submit', f.workspace, f.plan, 'archived-block', f.packet, '--kind', 'block', ...baselineArgs]);
  assert.equal(submit.status, 1);
  assert.match(submit.result.error, /unarchive.*preflight/i);
  assert.equal(f.posts(f.prompt), 1);
});

test('restoring High cannot dispatch against an exchange modified during model selection', async t => {
  const f = await artex(t), session = f.sessions.get(f.sessionID);
  const previous = session.model;
  session.model = { ...previous, variant: 'low' };
  const history = f.messages.get(f.sessionID);
  const final = history.at(-2);
  history.push({ id: 'msg_lateLow', type: 'model-switched', previous, model: session.model,
    time: { created: session.time.idle + 1 } });
  const accepted = ['transition', f.workspace, f.target, f.source.messageID, 'accepted', ...baselineArgs];
  assert.equal((await f.call(accepted, newChat)).status, 0);
  f.onRequest = route => {
    if (route.endsWith('/model')) final.content[0].text = 'Replaced during model selection';
  };
  const result = await f.call(f.submit, newChat);
  assert.equal(result.status, 1);
  assert.match(result.result.error, /changed since review/i);
  assert.equal(f.posts(f.prompt), 1);
  assert.equal(f.state().bindings[0].phase, 'PREPARING');
});

test('reconciled High preserves the prepared transition boundary', async t => {
  const f = await artex(t), session = f.sessions.get(f.sessionID), previous = session.model;
  session.model = { ...previous, variant: 'low' };
  f.messages.get(f.sessionID).push({ id: 'msg_lateLow', type: 'model-switched', previous, model: session.model,
    time: { created: session.time.idle + 1 } });
  assert.equal((await f.call(f.transition, newChat)).status, 0);
  f.rejectRequest = (method, route) => method === 'GET' && route.endsWith('/message?limit=2&order=desc') ?
    { _tag: 'InvalidRequestError' } : undefined;
  assert.equal((await f.call(f.submit, newChat)).result.phase, 'STOPPED');
  f.rejectRequest = undefined;
  const result = await f.call(['reconcile', f.workspace, f.target, ...baselineArgs], newChat);
  assert.equal(result.result.kind, 'mutation-reconciled', JSON.stringify(result.result));
  assert.equal((await f.call(f.preflight, newChat)).status, 0);
  assert.equal((await f.call(f.submit, newChat)).result.kind, 'admitted');
  assert.equal(f.posts(f.prompt), 2);
  assert.equal(f.posts(`/api/session/${f.sessionID}/model`), 1);
  assert.equal(f.state().plans.find(plan => plan.planPath === f.plan).correctionCount, 6);
});

for (const action of ['finish', 'transition']) {
  test(action + ' refuses a replaced reviewed result with unchanged IDs and timestamps', async t => {
    const f = await artex(t);
    f.messages.get(f.sessionID).at(-2).content[0].text = 'Replaced after review';
    const start = f.calls.length;
    const preview = (await f.call(['preflight', f.workspace, f.plan, ...baselineArgs])).result;
    assert.match(preview.checks.find(check => check.name === 'history').reason, /changed since review/i);
    const outcome = action === 'finish' ? await f.call(['finish', f.workspace, f.plan, ...baselineArgs]) :
      await f.call(['transition', f.workspace, f.target, f.source.messageID, 'accepted', ...baselineArgs], newChat);
    assert.equal(outcome.status, 1);
    assert.match(outcome.result.error, /changed since review/i);
    assert.ok(f.calls.slice(start).every(call => call.method === 'GET'));
  });
}

test('same-plan continuation requires a disposition and keeps the correction count until submit', async t => {
  const f = await artex(t);
  const args = ['transition', f.workspace, f.plan, f.source.messageID];
  assert.equal((await f.call([...args, ...baselineArgs])).status, 1);
  const prepared = await f.call([...args, 'without-acceptance', '--kind', 'correction', ...baselineArgs]);
  assert.equal(prepared.status, 0, JSON.stringify(prepared));
  assert.equal(f.state().plans[0].correctionCount, 6);
  assert.equal((await f.call(['submit', f.workspace, f.plan, 'B1a-follow-up', f.packet, '--kind', 'correction',
    ...baselineArgs])).result.kind, 'admitted');
  assert.equal(f.state().plans[0].correctionCount, 7);
});

test('a changed OpenCode registration needs the exact prior plan and delivered history', async t => {
  const f = await artex(t);
  const previous = f.state();
  previous.bindings[0].engineID = 'previous-opencode-instance';
  writeFileSync(f.statePath, JSON.stringify(previous));
  const records = f.messages.get(f.sessionID), text = records[0].text;
  records[0].text = `Assignment ID: ${f.source.assignmentID}\nCanonical plan: "other"\n`;
  const rejected = await f.call(f.transition, newChat);
  assert.match(rejected.result.error, /Prior plan was not confirmed/);
  assert.deepEqual(f.state(), previous);
  records[0].text = text;
  const prepared = await f.call(f.transition, newChat);
  assert.equal(prepared.status, 0, JSON.stringify(prepared));
  assert.equal(prepared.result.engineChanged, true);
  assert.equal(f.state().bindings[0].engineID, f.source.engineID);
  assert.equal((await f.call(f.submit, newChat)).result.kind, 'admitted');
  assert.equal(f.posts(f.prompt), 2);
});
