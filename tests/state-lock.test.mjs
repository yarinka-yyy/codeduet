import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { helper, stateLockStatus } from '../helper/binding.mjs';
import { diagnose } from '../helper/connection.mjs';
import { processOwner } from '../helper/process-owner.mjs';
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
  assert.equal(stateLockStatus({ stateRoot: f.stateRoot }).ownerStatus, 'unknown');
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.original);
  assert.equal(f.calls.length, 0);
});

for (const stage of ['state-directory', 'state-lock']) {
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED', 'ENOSPC', 'ENOTDIR', 'EEXIST', 'PRIVATE_PATH_CANARY']) {
    test(stage + ' classifies ' + code + ' without leaks or state mutation', async t => {
      const f = store(t), method = stage === 'state-directory' ? 'mkdirSync' : 'linkSync';
      const original = fs[method]; let attempts = 0;
      t.mock.method(fs, method, function (path, ...args) {
        if (stage === 'state-directory' ? path === f.stateRoot : args[0] === f.lockPath) {
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
        assert.ok(attempts > 1 && attempts <= 7); assert.ok(Date.now() - startedAt < 5000);
      } else assert.equal(attempts, 1);
      assert.equal(f.calls.length, 0);
      assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.original);
      assert.ok(!fs.existsSync(f.lockPath));
    });
  }
}

for (const stage of ['before-write', 'before-rename', 'after-rename']) test('state lock recovery after SIGKILL at ' + stage, async t => {
  const f = store(t), plan = join(f.root, 'plan.md');
  fs.writeFileSync(plan, '# Isolated state-write test\n');
  const module = new URL('../helper/binding.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { startCycle } from ${JSON.stringify(module)};
    const [stateRoot, path, workspace, planPath, stage] = process.argv.slice(1);
    const halt = () => {
      process.stdout.write('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    const write = fs.writeFileSync, rename = fs.renameSync;
    fs.writeFileSync = (target, ...args) => {
      if (typeof target === 'string' && target.startsWith(path + '.') && stage === 'before-write') halt();
      return write(target, ...args);
    };
    fs.renameSync = (from, to) => {
      if (to === path && stage === 'before-rename') halt();
      rename(from, to);
      if (to === path && stage === 'after-rename') halt();
    };
    syncBuiltinESMExports();
    startCycle(workspace, planPath, { stateRoot, chatID: 'state-lock-crash-fixture' });`,
  f.stateRoot, f.statePath, f.root, plan, stage], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await Promise.race([new Promise(resolve => child.stdout.once('data', resolve)), exited.then(() => assert.fail('Lock owner exited early'))]);
  const inspect = options => stateLockStatus({ stateRoot: f.stateRoot, ...options });
  const live = inspect();
  assert.equal(live.processID, child.pid);
  assert.equal(live.ownerStatus, 'live');
  assert.equal(inspect({ recoverToken: live.token }).kind, 'rejected');
  assert.equal(inspect({ probeOwner: () => ({ state: 'unknown' }) }).ownerStatus, 'unknown');
  assert.equal(inspect({ probeOwner: () => ({ state: 'present', start: 'another-process' }) }).reason, 'pid-reused');
  child.kill('SIGKILL'); await exited;
  assert.equal(inspect({ recoverToken: '00000000-0000-4000-8000-000000000000' }).kind, 'rejected');
  assert.equal(inspect({ recoverToken: live.token }).kind, 'state-lock-released');
  assert.equal(inspect().ownerStatus, 'absent');
  const persisted = fs.readFileSync(f.statePath, 'utf8');
  if (stage === 'after-rename') assert.deepEqual(JSON.parse(persisted), {
    schema: 1, plans: [{ workspace: f.root, planPath: plan, correctionCount: 0 }], bindings: [],
  });
  else assert.equal(persisted, f.original);
  assert.ok(fs.existsSync(join(f.stateRoot, 'state-lock-history', live.token + '.lock')));
});

const cli = fileURLToPath(new URL('../helper/cli.mjs', import.meta.url));

test('13: exact recovery can resume after EIO and refuses a tampered receipt', t => {
  const f = store(t), token = '00000000-0000-4000-8000-000000000013';
  const archive = join(f.stateRoot, 'state-lock-history'), receiptPath = join(archive, token + '.json');
  const lock = JSON.stringify({ schema: 1, token, process: { ...processOwner(), pid: 424242 } });
  fs.writeFileSync(f.lockPath, lock);
  const recover = () => stateLockStatus({ stateRoot: f.stateRoot, probeOwner: () => ({ state: 'absent' }), recoverToken: token });
  const rename = fs.renameSync;
  const hook = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === f.lockPath) throw Object.assign(new Error('Injected EIO'), { code: 'EIO' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(recover, error => error.diagnostic.category === 'state-io'); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  const original = fs.readFileSync(receiptPath, 'utf8');
  fs.writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(original), stateFingerprint: 'tampered' }));
  assert.throws(recover, /Unverifiable state lock recovery receipt/);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), lock);
  fs.writeFileSync(receiptPath, original);
  assert.equal(recover().kind, 'state-lock-released');
  assert.equal(fs.readFileSync(join(archive, token + '.lock'), 'utf8'), lock);
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.original);
});

test('13: a live recoverer excludes competitors; one successor archives after its exit', async t => {
  const f = store(t), token = '00000000-0000-4000-8000-000000000014';
  const lock = JSON.stringify({ schema: 1, token, process: { ...processOwner(), pid: 424242 } });
  fs.writeFileSync(f.lockPath, lock);
  const module = new URL('../helper/binding.mjs', import.meta.url).href;
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { stateLockStatus } from ${JSON.stringify(module)};
    const [stateRoot, recoverToken, lockPath, pause] = process.argv.slice(1);
    if (pause) {
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (from === lockPath) {
          process.stdout.write('claimed');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
    }
    try { console.log(stateLockStatus({ stateRoot, recoverToken, probeOwner: () => ({ state: 'absent' }) }).kind); }
    catch (error) { console.log(error.message); }`;
  const args = ['--input-type=module', '-e', code, f.stateRoot, token, f.lockPath];
  const child = spawn(process.execPath, [...args, 'pause'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await Promise.race([new Promise(resolve => child.stdout.once('data', resolve)), exited.then(() => assert.fail('Recoverer did not claim'))]);
  const run = async () => (await promisify(execFile)(process.execPath, args, { windowsHide: true })).stdout.trim();
  assert.match(await run(), /recovery is already in progress/);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), lock);
  child.kill('SIGKILL'); await exited;
  const outcomes = await Promise.all([run(), run()]);
  assert.equal(outcomes.filter(value => value === 'state-lock-released').length, 1);
  assert.equal(fs.readFileSync(join(f.stateRoot, 'state-lock-history', token + '.lock'), 'utf8'), lock);
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), f.original);
  const replacement = lock.replace(token, '00000000-0000-4000-8000-000000000015');
  fs.writeFileSync(f.lockPath, replacement, { flag: 'wx' });
  assert.equal(await run(), 'rejected');
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), replacement);
});

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

test('native process probe denial with a writable store has its own diagnosis', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), root = dirname(f.statePath);
  fs.mkdirSync(root, { recursive: true });
  const result = await promisify(execFile)(process.execPath,
    ['--no-warnings', '--permission', '--allow-fs-read=*', '--allow-fs-write=' + root, cli, ...f.bindArgs(0)],
    { cwd: f.workspace, env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_THREAD_ID: 'offline-http-chat-A' },
      windowsHide: true, timeout: 10000 }).catch(error => error);
  assert.equal(result.code, 1);
  const outcome = JSON.parse(result.stderr);
  assert.equal(outcome.diagnostic.category, 'process-identity', JSON.stringify(outcome));
  assert.equal(outcome.diagnostic.stage, 'process-probe');
  assert.deepEqual(fs.readdirSync(root), []);
  assert.ok(f.calls.every(call => call.method === 'GET'));
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
