import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { helper } from '../helper/binding.mjs';
import { diagnose } from '../helper/connection.mjs';
import { baseline, fixture } from './http-fixture.mjs';

function store(t) {
  const parent = fs.realpathSync(tmpdir()), root = fs.mkdtempSync(join(parent, 'duet-lock-'));
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); fs.rmSync(root, { recursive: true }); });
  const stateRoot = join(root, 'state'); fs.mkdirSync(stateRoot);
  const statePath = join(stateRoot, 'state.json'), lockPath = join(stateRoot, 'state.lock');
  const original = JSON.stringify({ schema: 1, bindings: [], plans: [] });
  fs.writeFileSync(statePath, original);
  const calls = [];
  const adapter = helper({ request(...args) { calls.push(args); throw new Error('Unexpected engine call'); } },
    { stateRoot, chatID: 'offline-lock-test' });
  return { root, stateRoot, statePath, lockPath, original, calls, adapter };
}

test('native EEXIST preserves a foreign lock and state without engine access', async t => {
  const f = store(t); fs.writeFileSync(f.lockPath, 'FOREIGN_WRITER');
  await assert.rejects(f.adapter.adopt('unused', 'unused', 'ses_unused'), error => {
    assert.match(error.message, /state locked/);
    assert.equal(error.diagnostic.category, 'state-locked');
    assert.equal(error.diagnostic.stage, 'state-lock');
    assert.equal(error.diagnostic.errorCode, 'EEXIST');
    return true;
  });
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), 'FOREIGN_WRITER');
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.original);
  assert.equal(f.calls.length, 0);
});

for (const stage of ['state-directory', 'state-lock']) {
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED', 'ENOSPC', 'ENOTDIR', 'EEXIST', 'PRIVATE_PATH_CANARY']) {
    test(stage + ' classifies ' + code + ' without leaks or state mutation', async t => {
      const f = store(t), method = stage === 'state-directory' ? 'mkdirSync' : 'openSync';
      const original = fs[method]; let attempts = 0;
      t.mock.method(fs, method, function (path, ...args) {
        if (path === (stage === 'state-directory' ? f.stateRoot : f.lockPath)) {
          attempts++;
          throw Object.assign(new Error('PRIVATE_PATH_CANARY password=PRIVATE_SECRET'), { code, path: 'PRIVATE_PATH_CANARY' });
        }
        return original(path, ...args);
      });
      syncBuiltinESMExports();
      const startedAt = Date.now();
      try {
        await assert.rejects(f.adapter.adopt('unused', 'unused', 'ses_unused'), error => {
          const conflict = stage === 'state-lock' && code === 'EEXIST';
          const denied = ['EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED'].includes(code);
          assert.equal(error.diagnostic.category, conflict ? 'state-locked' : denied ? 'state-access' : 'state-io');
          assert.equal(error.diagnostic.stage, stage);
          assert.equal(error.diagnostic.errorCode, code === 'PRIVATE_PATH_CANARY' ? undefined : code);
          // This is the CLI catch's normal sanitizing path.
          const outcome = JSON.stringify({ kind: 'stopped', error: error.message, retried: false,
            diagnostic: diagnose(error, 'unknown', 'connection') });
          assert.ok(!outcome.includes('PRIVATE_') && !outcome.includes(f.root));
          assert.equal(error.message.includes('state locked'), conflict);
          return true;
        });
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
      if (stage === 'state-lock' && code === 'EEXIST') {
        assert.ok(attempts > 1 && attempts <= 7); assert.ok(Date.now() - startedAt < 120);
      } else assert.equal(attempts, 1);
      assert.equal(f.calls.length, 0);
      assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.original);
      assert.ok(!fs.existsSync(f.lockPath));
    });
  }
}

const cli = fileURLToPath(new URL('../helper/cli.mjs', import.meta.url));
async function deniedCLI(f, args) {
  const result = await promisify(execFile)(process.execPath,
    ['--no-warnings', '--permission', '--allow-fs-read=*', cli, ...args],
    { cwd: f.workspace, env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_THREAD_ID: 'offline-http-chat-A' },
      windowsHide: true, timeout: 10_000 }).catch(error => {
        assert.equal(error.code, 1); return error;
      });
  assert.equal(result.stdout, '');
  const outcome = JSON.parse(result.stderr.trim());
  assert.equal(outcome.kind, 'stopped', JSON.stringify(outcome)); assert.equal(outcome.retried, false);
  assert.equal(outcome.diagnostic.category, 'state-access');
  assert.equal(outcome.diagnostic.errorCode, 'ERR_ACCESS_DENIED');
  assert.ok(!result.stderr.includes(f.home));
  return outcome;
}

test('native CLI access denial during adoption has a diagnostic, no binding and no engine POST', async t => {
  const f = await fixture(t);
  fs.mkdirSync(dirname(f.statePath), { recursive: true });
  const before = fs.readdirSync(dirname(f.statePath));
  await deniedCLI(f, ['adopt', f.workspace, f.plan, 'ses_unused', '--correction-count', '0', '--non-git-baseline', baseline]);
  assert.deepEqual(fs.readdirSync(dirname(f.statePath)), before);
  assert.ok(!fs.existsSync(f.statePath));
  assert.ok(f.calls.length >= 2 && f.calls.every(call => call.method === 'GET'));
});

test('native CLI lock/access failures preserve STOPPED uncertain intent and never repeat its POST', async t => {
  const f = await fixture(t);
  const pair = await f.call(f.bindArgs(19)); assert.equal(pair.status, 0);
  f.fault = 'drop';
  assert.equal((await f.call(f.submitArgs)).status, 1);
  const before = fs.readFileSync(f.statePath);
  assert.equal(f.state().bindings[0].phase, 'STOPPED');
  assert.equal(f.state().bindings[0].uncertain, 'submit');
  assert.equal(f.state().plans[0].correctionCount, 20);
  const lockPath = join(dirname(f.statePath), 'state.lock');
  fs.writeFileSync(lockPath, 'OWNED_TEST_LOCK');
  const conflict = await f.call(f.submitArgs);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.result.diagnostic.category, 'state-locked');
  assert.equal(conflict.result.diagnostic.errorCode, 'EEXIST');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'OWNED_TEST_LOCK');
  fs.unlinkSync(lockPath);
  await deniedCLI(f, f.submitArgs);
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  f.fault = null;
  assert.equal((await f.call(f.submitArgs)).status, 1);
  assert.equal((await f.call(['inspect'])).result.binding.phase, 'STOPPED');
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  assert.equal(f.posts('/api/session/' + pair.result.sessionID + '/prompt'), 1);
  assert.equal(f.posts('/api/session'), 1);
});
