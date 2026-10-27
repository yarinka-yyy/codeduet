import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { connect, MODEL } from '../helper/connection.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'duet-retry-'));
  const registrationPath = join(root, 'service.json');
  const registration = { id: 'offline-engine', version: '2.1.4', url: 'http://127.0.0.1:1234', password: 'PRIVATE_RETRY_CANARY' };
  writeFileSync(registrationPath, JSON.stringify(registration));
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); rmSync(root, { recursive: true }); });
  return { root, registrationPath, registration };
}

function clock() {
  let value = 0, nextTimer = 0;
  const timeouts = [], cleared = [], sleeps = [];
  return {
    now: () => value,
    advance: ms => { value += ms; },
    sleep: async ms => { sleeps.push(ms); value += ms; },
    setTimer: (callback, ms) => { const id = ++nextTimer; timeouts.push({ id, ms, callback }); return id; },
    clearTimer: id => { cleared.push(id); },
    timeouts, cleared, sleeps,
  };
}

const goodInfo = () => Response.json({ version: '2.1.4' });
const goodModel = () => Response.json({ data: [{ ...MODEL, enabled: true, status: 'active' }] });

test('bootstrap retries only safe GETs, rereads registration, aborts sibling and clears attempt timers', async t => {
  const f = fixture(t), time = clock(), calls = [], authorizations = [], siblingSignals = [];
  let infoAttempt = 0;
  const client = await connect({
    registrationPath: f.registrationPath, now: time.now, sleep: async ms => {
      await time.sleep(ms);
      if (time.sleeps.length === 1) writeFileSync(f.registrationPath,
        JSON.stringify({ ...f.registration, password: 'PRIVATE_RETRY_CANARY_2' }));
    },
    setTimer: time.setTimer, clearTimer: time.clearTimer,
    fetchImpl: async (url, init) => {
      const route = new URL(url).pathname;
      calls.push(route); authorizations.push(init.headers.Authorization);
      if (route === '/api/info') {
        infoAttempt++;
        return infoAttempt < 3 ? new Response('', { status: 503 }) : goodInfo();
      }
      if (infoAttempt < 3) {
        siblingSignals.push(init.signal);
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
      return goodModel();
    },
  });
  assert.equal(client.bootstrap.attempts, 3);
  assert.equal(client.bootstrap.retried, true);
  assert.deepEqual(time.sleeps, [500, 1000]);
  assert.deepEqual(calls, ['/api/info', '/api/model', '/api/info', '/api/model', '/api/info', '/api/model']);
  assert.equal(siblingSignals.length, 2);
  assert.ok(siblingSignals.every(signal => signal.aborted));
  assert.equal(time.cleared.length, time.timeouts.length);
  assert.ok(authorizations.some(value => value === 'Basic ' + Buffer.from('opencode:PRIVATE_RETRY_CANARY').toString('base64')));
  assert.ok(authorizations.some(value => value === 'Basic ' + Buffer.from('opencode:PRIVATE_RETRY_CANARY_2').toString('base64')));
  assert.ok(!JSON.stringify(client.bootstrap).includes('PRIVATE_RETRY'));
});

test('502/504 and allowlisted transport reset/refused codes retry; request timeout remains bounded', async t => {
  for (const status of [502, 504]) {
    const f = fixture(t), time = clock(); let infoAttempt = 0;
    const client = await connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep,
      setTimer: time.setTimer, clearTimer: time.clearTimer,
      fetchImpl: async url => {
        if (new URL(url).pathname === '/api/info') {
          infoAttempt++;
          return infoAttempt === 1 ? new Response('', { status }) : goodInfo();
        }
        return goodModel();
      },
    });
    assert.equal(client.bootstrap.attempts, 2);
    assert.deepEqual(time.sleeps, [500]);
  }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET']) {
    const f = fixture(t), time = clock(); let infoAttempt = 0;
    const client = await connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep,
      setTimer: time.setTimer, clearTimer: time.clearTimer,
      fetchImpl: async (url, init) => {
        if (new URL(url).pathname === '/api/info') {
          infoAttempt++;
          if (infoAttempt === 1) throw Object.assign(new TypeError('PRIVATE_TRANSPORT'), { cause: { code } });
          return goodInfo();
        }
        if (infoAttempt === 1) return new Promise((resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
        return goodModel();
      },
    });
    assert.equal(client.bootstrap.attempts, 2);
    assert.deepEqual(time.sleeps, [500]);
  }
  const f = fixture(t), time = clock();
  let timerID = 0, infoCalls = 0;
  const client = await connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep,
    setTimer: (callback, ms) => {
      const id = ++timerID;
      if (id <= 2) queueMicrotask(callback);
      return id;
    },
    clearTimer() {},
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/api/info') {
        infoCalls++;
        if (infoCalls === 1) return new Promise((resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
        return goodInfo();
      }
      if (infoCalls === 1) return new Promise((resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      return goodModel();
    },
  });
  assert.equal(client.bootstrap.attempts, 2);
  assert.deepEqual(time.sleeps, [500]);
});

test('bootstrap immediate success uses one attempt and the 30-second budget clips request timeout', async t => {
  const f = fixture(t), time = clock();
  let requests = 0;
  const client = await connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep,
    setTimer: time.setTimer, clearTimer: time.clearTimer,
    fetchImpl: async url => { requests++; return new URL(url).pathname === '/api/info' ? goodInfo() : goodModel(); } });
  assert.equal(client.bootstrap.attempts, 1);
  assert.equal(requests, 2);

  const budget = clock(), clipped = fixture(t);
  let infoAttempt = 0, error;
  await assert.rejects(connect({ registrationPath: clipped.registrationPath, now: budget.now,
    sleep: budget.sleep, setTimer: budget.setTimer, clearTimer: budget.clearTimer,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/api/info') {
        infoAttempt++;
        budget.advance(infoAttempt === 1 ? 20_000 : 9_400);
        return new Response('', { status: 503 });
      }
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    },
  }), failure => {
    error = failure;
    return failure.bootstrap.attempts === 2 && failure.bootstrap.lastDiagnostic.httpStatus === 503;
  });
  assert.deepEqual(budget.sleeps, [500]);
  assert.deepEqual(budget.timeouts.map(item => item.ms), [20_000, 20_000, 9_500, 9_500]);
  assert.equal(budget.cleared.length, budget.timeouts.length);
  assert.equal(error.bootstrap.retried, true);
});

test('HTTP access/client errors and unknown transport codes are not retried', async t => {
  for (const status of [400, 401, 403, 429, 500]) {
    const f = fixture(t), time = clock(); let infoCalls = 0, modelCalls = 0;
    await assert.rejects(connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep,
      setTimer: time.setTimer, clearTimer: time.clearTimer,
      fetchImpl: async url => {
        if (new URL(url).pathname === '/api/info') infoCalls++; else modelCalls++;
        return new Response('PRIVATE_HTTP_BODY', { status });
      },
    }), error => {
      assert.equal(error.bootstrap.attempts, 1);
      assert.equal(error.bootstrap.lastDiagnostic.httpStatus, status);
      assert.ok(!error.message.includes('PRIVATE_HTTP_BODY') && !JSON.stringify(error.bootstrap).includes('PRIVATE_HTTP_BODY'));
      return true;
    });
    assert.equal(infoCalls, 1);
    assert.equal(modelCalls, 1);
    assert.deepEqual(time.sleeps, []);
  }
  const f = fixture(t), time = clock(); let infoCalls = 0, modelCalls = 0;
  await assert.rejects(connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep,
    setTimer: time.setTimer, clearTimer: time.clearTimer,
    fetchImpl: async url => {
      if (new URL(url).pathname === '/api/info') infoCalls++; else modelCalls++;
      throw Object.assign(new TypeError('PRIVATE_TRANSPORT'), { cause: { code: 'ENOTFOUND' } });
    },
  }), error => error.bootstrap.attempts === 1 && error.bootstrap.lastDiagnostic.errorCode === undefined &&
    !error.message.includes('PRIVATE_TRANSPORT'));
  assert.equal(infoCalls, 1);
  assert.equal(modelCalls, 1);
  assert.deepEqual(time.sleeps, []);
});

test('registration, version, response shape and model mismatch stop after one bootstrap attempt', async t => {
  const f = fixture(t), time = clock();
  writeFileSync(f.registrationPath, '{broken PRIVATE_JSON');
  await assert.rejects(connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep }),
    error => error.bootstrap.attempts === 1 && !error.message.includes('PRIVATE_JSON'));
  assert.deepEqual(time.sleeps, []);
  writeFileSync(f.registrationPath, JSON.stringify({ ...f.registration, version: '3.0' }));
  await assert.rejects(connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep }),
    error => error.bootstrap.attempts === 1 && /Unsupported engine/.test(error.message));
  writeFileSync(f.registrationPath, JSON.stringify(f.registration));
  for (const response of [
    () => Response.json({}),
    () => Response.json({ version: '2.1.4' }),
  ]) {
    let infoCalls = 0, modelCalls = 0;
    await assert.rejects(connect({ registrationPath: f.registrationPath, now: time.now, sleep: time.sleep,
      setTimer: time.setTimer, clearTimer: time.clearTimer,
      fetchImpl: async url => {
        if (new URL(url).pathname === '/api/info') infoCalls++; else modelCalls++;
        return response();
      },
    }), error => error.bootstrap.attempts === 1);
    assert.equal(infoCalls, 1);
    assert.equal(modelCalls, 1);
  }
  assert.deepEqual(time.sleeps, []);
});
