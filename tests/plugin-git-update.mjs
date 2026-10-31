// Real Codex/Git integration against a disposable localhost marketplace; no model or OpenCode.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixture, baseline } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';

const [codex] = process.argv.slice(2);
assert.ok(codex, 'Pass the installed Codex executable');
const root = mkdtempSync(join(tmpdir(), 'duet-plugin-git-'));
const repo = join(root, 'market.git'), home = join(root, 'codex-home');
mkdirSync(repo); mkdirSync(home);
const source = resolve('..');
cpSync(join(source, 'app', 'plugin'), join(repo, 'plugin'), { recursive: true });
cpSync(join(source, 'app', '.agents'), join(repo, '.agents'), { recursive: true });
function run(exe, args, cwd = repo, env = process.env) {
  const result = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, `${exe} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
run('git', ['init', '-b', 'main']);
run('git', ['config', 'user.email', 'fixture@example.invalid']);
run('git', ['config', 'user.name', 'Code Duet fixture']);
run('git', ['add', '.']); run('git', ['commit', '-m', 'fixture v1']);
run('git', ['update-server-info']);
const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
const port = portProbe.address().port; await new Promise(done => portProbe.close(done));
const serverSource = `const http=require('http'),fs=require('fs'),path=require('path');
  const root=process.argv[1],port=Number(process.argv[2]);
  http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');
    if(!u.pathname.startsWith('/market.git/')){res.writeHead(404).end();return}
    const file=path.resolve(root,'.git',decodeURIComponent(u.pathname.slice('/market.git/'.length)));
    if(!file.startsWith(path.resolve(root,'.git')+path.sep)){res.writeHead(403).end();return}
    try{const data=fs.readFileSync(file);res.writeHead(200,{'content-type':'application/octet-stream'});res.end(data)}catch{res.writeHead(404).end()}
  }).listen(port,'127.0.0.1',()=>process.stdout.write('ready\\n'));`;
const daemon = spawn(process.execPath, ['-e', serverSource, repo, String(port)],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const env = { ...process.env, CODEX_HOME: home };
let daemonError = ''; daemon.stderr.on('data', data => { daemonError += data; });
const cleanup = [];
let worker;
try {
  await once(daemon.stdout, 'data');
  const url = `http://127.0.0.1:${port}/market.git`;
  run(codex, ['plugin', 'marketplace', 'add', url, '--ref', 'main', '--json'], root, env);
  run(codex, ['plugin', 'add', 'code-duet@code-duet', '--json'], root, env);
  const v1 = join(home, 'plugins/cache/code-duet/code-duet/1.0.0/skills/code-duet/SKILL.md');
  assert.ok(existsSync(v1), 'v1 missing');
  const f = await fixture({ after: callback => cleanup.push(callback) }), stateRoot = dirname(f.statePath);
  const chatID = '00000000-0000-4000-8000-000000000073';
  const registration = join(f.home, '.local/state/opencode/service.json');
  const connectEngine = () => connect({ registrationPath: registration });
  const adapter = helper(await connectEngine(), { stateRoot, chatID });
  await adapter.bind(f.workspace, f.plan, baseline, 8);
  await adapter.submit(f.workspace, f.plan, 'git-update-fixture', f.packet, baseline, 'correction');
  const before = readFileSync(f.statePath), oldModule = await import(pathToFileURL(join(dirname(v1), 'helper/observer.mjs')).href);
  let hint, workerError = '';
  const watcher = oldModule.observer({ stateRoot, chatID, connectEngine,
    checkCapability: () => ({ path: process.execPath, hash: 'fixture', version: 'fixture' }),
    launch: async id => {
      const snapshot = join(stateRoot, 'observers', createHash('sha256').update(chatID).digest('hex'), id, 'code-duet');
      const source = `import {observer,wakeHint} from ${JSON.stringify(pathToFileURL(join(snapshot, 'helper/observer.mjs')).href)};
        import {connect} from ${JSON.stringify(pathToFileURL(join(snapshot, 'helper/connection.mjs')).href)};
        await observer({stateRoot:${JSON.stringify(stateRoot)},chatID:${JSON.stringify(chatID)},
          connectEngine:()=>connect({registrationPath:${JSON.stringify(registration)}}),
          deliver:async()=>{process.send({hint:wakeHint(${JSON.stringify(id)})});return {status:'sent',exitCode:0}}}).worker(${JSON.stringify(id)});`;
      worker = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      worker.stderr.on('data', data => { workerError += data; }); worker.on('message', value => { hint = value.hint; });
      await once(worker, 'spawn');
    } });
  const armed = await watcher.arm(f.workspace, f.plan, { codexExe: process.execPath, nonGitBaseline: baseline, timeoutMs: 30000 });
  assert.equal(armed.kind, 'observer-armed');
  const manifestPath = join(repo, 'plugin/.codex-plugin/plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath)); manifest.version = '1.0.1';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const skill = join(repo, 'plugin/skills/code-duet/SKILL.md');
  writeFileSync(skill, readFileSync(skill, 'utf8') + '\n<!-- isolated update fixture -->\n');
  run('git', ['add', '.']); run('git', ['commit', '-m', 'fixture v2']);
  run('git', ['update-server-info']);
  const server = spawn(codex, ['app-server'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', data => { stderr += data; });
  const exited = once(server, 'exit');
  server.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'duet-update-test', version: '1.0.0' } } }) + '\n');
  const v2 = join(home, 'plugins/cache/code-duet/code-duet/1.0.1/skills/code-duet/SKILL.md');
  try {
    const deadline = Date.now() + 30000;
    while (!existsSync(v2) && Date.now() < deadline) await new Promise(done => setTimeout(done, 200));
    assert.ok(existsSync(v2), 'startup auto-update did not install v2: ' + stderr);
    assert.ok(readFileSync(v2, 'utf8').includes('isolated update fixture'));
    assert.deepEqual(readFileSync(f.statePath), before, 'update changed task binding');
    f.finish(f.state().bindings[0].sessionID);
    const [workerExit] = await once(worker, 'exit'); assert.equal(workerExit, 0, workerError);
    assert.ok(hint.includes(armed.id), 'observer did not deliver a hint');
    const newModule = await import(pathToFileURL(join(dirname(v2), 'helper/observer.mjs')).href);
    assert.equal((await newModule.observer({ stateRoot, chatID, connectEngine }).consume(armed.id)).kind, 'completed-for-review');
    assert.equal(f.state().plans[0].correctionCount, 9);
    assert.equal(f.posts(`/api/session/${f.state().bindings[0].sessionID}/prompt`), 1);
    console.log(JSON.stringify({ kind: 'git-startup-auto-update-and-active-observer-passed', root, v1, v2 }));
  } finally { server.stdin.end(); await exited; }
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, 'exit'); worker.kill(); await exited; }
  daemon.kill(); for (const callback of cleanup) await callback();
}
