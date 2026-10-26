import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MODEL, connect } from '../helper/connection.mjs';
import { context, helper } from '../helper/binding.mjs';

const baseline = 'Baseline: isolated test';
function fixture(t) {
  const temporaryRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryRoot, 'code-duet-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(temporaryRoot + sep) && root !== temporaryRoot);
    rmSync(root, { recursive: true });
  });
  const workspace = join(root, 'workspace space & test');
  mkdirSync(join(workspace, 'plans'), { recursive: true });
  const plan = join(workspace, 'plans', '001-test.md');
  const packet = join(workspace, 'packet.txt');
  writeFileSync(plan, baseline);
  writeFileSync(packet, 'No-op packet');
  return { root, workspace, plan, packet, stateRoot: join(root, 'state') };
}

function fakeEngine() {
  const calls = [];
  const sessions = new Map();
  const client = {
    engineID: 'engine1', active: {}, forms: [], loseSubmit: false, wrongAdmission: false, loseCreate: false, calls, sessions,
    async request(route, body) {
      calls.push({ route, body });
      if (route === '/api/session/active') return { data: structuredClone(client.active) };
      if (route === '/api/session' && body) {
        if (client.loseCreate) throw new Error('Creation connection uncertain');
        const session = { id: 'ses_test' + (sessions.size + 1), model: structuredClone(body.model), location: structuredClone(body.location) };
        sessions.set(session.id, session);
        return { data: session };
      }
      if (route.endsWith('/form')) return { data: structuredClone(client.forms) };
      if (route.endsWith('/permission')) return { data: [] };
      if (route.endsWith('/prompt')) {
        if (client.loseSubmit) throw new Error('Submission connection uncertain');
        return { data: { id: client.wrongAdmission ? 'msg_wrong' : body.id, sessionID: route.split('/')[3] } };
      }
      if (route.startsWith('/api/session/')) return { data: structuredClone(sessions.get(route.split('/')[3])) };
      throw new Error('Unexpected mock route');
    },
  };
  return client;
}
const options = (f, chatID = 'offline-chat-A') => ({ stateRoot: f.stateRoot, chatID });
const bind = (adapter, f) => adapter.bind(f.workspace, f.plan, baseline);
const submit = (adapter, f) => adapter.submit(f.workspace, f.plan, 'block-1', f.packet, baseline);
const stored = f => JSON.parse(readFileSync(join(f.stateRoot, 'state.json'), 'utf8'));
const update = (f, state) => writeFileSync(join(f.stateRoot, 'state.json'), JSON.stringify(state));
const mutations = client => client.calls.filter(call => call.body !== undefined);

test('bind creates only once, reuses the exact session, and a different offline chat gets a fresh pair without resetting count', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f));
  const first = await bind(a, f);
  assert.equal(first.kind, 'created'); assert.deepEqual(first.model, MODEL);
  assert.equal((await bind(a, f)).sessionID, first.sessionID);
  const state = stored(f); state.plans[0].correctionCount = 7; update(f, state);
  const second = await bind(helper(client, options(f, 'offline-chat-B')), f);
  assert.notEqual(first.sessionID, second.sessionID); assert.equal(second.correctionCount, 7);
  assert.equal(mutations(client).length, 2);
});

test('different physical copy and substituted remote directory/model/engine block mutation', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f));
  const first = await bind(a, f);
  const other = join(f.root, 'other', 'workspace space & test'); mkdirSync(join(other, 'plans'), { recursive: true });
  const otherPlan = join(other, 'plans', '001-test.md'); writeFileSync(otherPlan, baseline);
  await assert.rejects(a.bind(other, otherPlan, baseline), /identity changed/);
  client.sessions.get(first.sessionID).location.directory = other;
  await assert.rejects(submit(a, f), /directory mismatch/);
  client.sessions.get(first.sessionID).location.directory = f.workspace;
  client.sessions.get(first.sessionID).model = { ...MODEL, providerID: 'opencode' };
  await assert.rejects(submit(a, f), /session\/model/);
  client.sessions.get(first.sessionID).model = MODEL;
  client.engineID = 'restarted';
  await assert.rejects(submit(a, f), /Engine changed/);
  assert.equal(mutations(client).length, 1);
});

test('non-Git baseline and plan/packet containment are explicit', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f));
  assert.throws(() => context(f.workspace, f.plan), /baseline declaration/);
  assert.throws(() => context(f.workspace, f.plan, 'invented baseline'), /baseline declaration/);
  const outside = join(f.root, 'outside.md'); writeFileSync(outside, baseline);
  assert.throws(() => context(f.workspace, outside, baseline), /inside the physical workspace/);
  await bind(a, f);
  await assert.rejects(a.submit(f.workspace, f.plan, 'block-1', outside, baseline), /Packet outside/);
  assert.equal(mutations(client).length, 1);
});

test('active executor anywhere in the same Git checkout blocks bind and submit', async t => {
  const f = fixture(t); execFileSync('git', ['init', '--quiet'], { cwd: f.root, windowsHide: true });
  const sibling = join(f.root, 'other-subdirectory'); mkdirSync(sibling);
  const client = fakeEngine(); client.sessions.set('ses_old', { id: 'ses_old', location: { directory: sibling } });
  client.active = { ses_old: { type: 'running' } };
  const a = helper(client, options(f));
  await assert.rejects(bind(a, f), /Active executor/);
  assert.equal(mutations(client).length, 0);
  client.active = {}; await bind(a, f);
  client.active = { ses_old: { type: 'running' } };
  await assert.rejects(submit(a, f), /Active executor/);
  assert.equal(mutations(client).length, 1);
});

test('an unrelated active project does not redirect or block the bound no-op assignment', async t => {
  const f = fixture(t); const client = fakeEngine(); const unrelated = join(f.root, 'unrelated'); mkdirSync(unrelated);
  client.sessions.set('ses_other', { id: 'ses_other', location: { directory: unrelated } });
  client.active = { ses_other: { type: 'running' } };
  const a = helper(client, options(f)); const pair = await bind(a, f); const result = await submit(a, f);
  assert.equal(result.kind, 'admitted'); assert.equal(result.phase, 'EXECUTING');
  const prompt = mutations(client).at(-1); assert.equal(prompt.route, `/api/session/${pair.sessionID}/prompt`);
  assert.ok(prompt.body.text.includes(f.plan.replaceAll('\\', '\\\\')) || prompt.body.text.includes(f.plan));
  assert.equal(stored(f).bindings[0].messageID, result.messageID);
  await assert.rejects(submit(a, f), /Previous assignment/);
});

test('uncertain or mismatched submit is retained before POST and never retried', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f)); await bind(a, f);
  client.loseSubmit = true;
  await assert.rejects(submit(a, f), /uncertain/);
  assert.equal(stored(f).bindings[0].phase, 'STOPPED'); assert.equal(stored(f).bindings[0].uncertain, 'submit');
  client.loseSubmit = false;
  await assert.rejects(submit(a, f), /uncertain/);
  await assert.rejects(bind(helper(client, options(f, 'offline-chat-B')), f), /no new writer/);
  assert.equal(client.calls.filter(call => call.route.endsWith('/prompt')).length, 1);
});

test('wrong admitted ID is not a successful submit', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f)); await bind(a, f);
  client.wrongAdmission = true;
  await assert.rejects(submit(a, f), /identity uncertain/);
  assert.equal(stored(f).bindings[0].phase, 'STOPPED');
});

test('lost create response cannot create another pair on retry', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f)); client.loseCreate = true;
  await assert.rejects(bind(a, f), /uncertain/);
  client.loseCreate = false;
  await assert.rejects(bind(a, f), /stopped or mutation uncertain/);
  assert.equal(mutations(client).length, 1);
});

test('corrupt state, unexpected secret fields, counters and stale locks are not overwritten', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f)); await bind(a, f);
  const good = stored(f);
  for (const bad of ['{"password":"canary"}', '{broken', JSON.stringify({ ...good, plans: [{ ...good.plans[0], correctionCount: -1 }] })]) {
    writeFileSync(join(f.stateRoot, 'state.json'), bad);
    await assert.rejects(bind(a, f), /Invalid helper state/);
    assert.equal(readFileSync(join(f.stateRoot, 'state.json'), 'utf8'), bad);
  }
  update(f, good); writeFileSync(join(f.stateRoot, 'state.lock'), 'old owner');
  await assert.rejects(bind(a, f), /state locked/);
  assert.equal(mutations(client).length, 1);
});

test('local concurrency admits one creator and never steals another helper lock', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f));
  const results = await Promise.allSettled([bind(a, f), bind(a, f)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(mutations(client).length, 1); assert.ok(!existsSync(join(f.stateRoot, 'state.lock')));
});

test('another chat cannot dispatch while the prior advisor is reviewing', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f)); await bind(a, f);
  const state = stored(f); state.bindings[0].phase = 'REVIEWING'; update(f, state);
  await assert.rejects(bind(helper(client, options(f, 'offline-chat-B')), f), /no new writer/);
  assert.equal(mutations(client).length, 1);
});

test('pending forms and malformed active state stop new work', async t => {
  const f = fixture(t); const client = fakeEngine(); const a = helper(client, options(f)); await bind(a, f);
  client.forms = [{ id: 'frm_pending' }];
  await assert.rejects(submit(a, f), /Pending\/unknown/);
  client.forms = []; client.active = [];
  await assert.rejects(submit(a, f), /Unknown engine/);
  assert.equal(mutations(client).length, 1);
});

test('credentials stay in HTTP headers, not exposed client/state/result or error bodies', async t => {
  const f = fixture(t); const registrationPath = join(f.root, 'service.json');
  const secret = 'SECRET_CANARY_002';
  writeFileSync(registrationPath, JSON.stringify({ id: 'engine1', version: '2.1.4', url: 'http://127.0.0.1:1234', password: secret }));
  const requests = [];
  const client = await connect({ registrationPath, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, 'Basic ' + Buffer.from('opencode:' + secret).toString('base64'));
    return Response.json(url.endsWith('/api/info') ? { version: '2.1.4' } : { data: [{ ...MODEL, enabled: true, status: 'active' }] });
  } });
  assert.ok(!JSON.stringify(client).includes(secret)); assert.ok(!('headers' in client));
  assert.equal(requests.length, 2); assert.ok(requests.every(r => r.init.redirect === 'error'));
  const engine = fakeEngine(); const a = helper(engine, options(f)); const result = await bind(a, f);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!readFileSync(join(f.stateRoot, 'state.json'), 'utf8').includes(secret));
  await assert.rejects(connect({ registrationPath, fetchImpl: async () => new Response(secret, { status: 401 }) }), error => error.message.includes('HTTP 401') && !error.message.includes(secret));
});

test('discovery refuses missing/corrupt registration, changed versions, unavailable model and malformed responses without mutation', async t => {
  const f = fixture(t); const registrationPath = join(f.root, 'service.json');
  await assert.rejects(connect({ registrationPath }), /registration/);
  writeFileSync(registrationPath, '{"password":"PRIVATE_SNIPPET",broken');
  await assert.rejects(connect({ registrationPath }), error => !error.message.includes('PRIVATE_SNIPPET'));
  const reg = { id: 'engine1', version: 'wrong', url: 'http://127.0.0.1:1234', password: 'canary' };
  writeFileSync(registrationPath, JSON.stringify(reg));
  await assert.rejects(connect({ registrationPath }), /Unsupported engine/);
  reg.version = '2.1.4'; writeFileSync(registrationPath, JSON.stringify(reg));
  await assert.rejects(connect({ registrationPath, fetchImpl: async url => Response.json(url.endsWith('/api/info') ? { version: '2.1.4' } : { data: [{ ...MODEL, enabled: false, status: 'active' }] }) }), /unavailable/);
  await assert.rejects(connect({ registrationPath, fetchImpl: async () => Response.json({}) }), /Invalid engine info/);
});

for (const fault of ['read', 'http', 'json']) test('connection ' + fault + ' keeps safe diagnosis without body or raw cause', async t => {
  const f = fixture(t), registrationPath = join(f.root, 'service.json'), secret = 'PRIVATE_TRANSPORT_007';
  writeFileSync(registrationPath, JSON.stringify({ id: 'engine1', version: '2.1.4', url: 'http://127.0.0.1:1234', password: secret }));
  await assert.rejects(connect({ registrationPath, fetchImpl: async () => {
    if (fault === 'read') throw Object.assign(new TypeError(secret), { cause: { code: 'ECONNRESET', message: secret } });
    return new Response(secret, { status: fault === 'http' ? 429 : 200 });
  } }), error => {
    assert.equal(error.diagnostic.category, { read: 'request-read', http: 'request-http', json: 'request-json' }[fault]);
    if (fault === 'read') assert.equal(error.diagnostic.errorCode, 'ECONNRESET');
    if (fault === 'http') assert.equal(error.diagnostic.httpStatus, 429);
    assert.ok(!error.message.includes(secret) && !JSON.stringify(error.diagnostic).includes(secret)); return true;
  });
});
