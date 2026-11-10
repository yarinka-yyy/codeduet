import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fixture, baseline, model } from './http-fixture.mjs';
import { connect } from '../helper/connection.mjs';
import { helper } from '../helper/binding.mjs';

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

test('Windows Next.js recovery requires the same retry, passing browser checks and stopped listener', { skip: process.platform !== 'win32' }, async t => {
  for (const scenario of ['resume', 'single launch', 'graceful retry', 'different stand', 'no readiness', 'wrong log',
    'failed tests', 'another failed test', 'wrong PID', 'no shutdown', 'another shell error']) {
    await t.test(scenario, async t => {
      const f = await fixture(t, undefined, '2.2.6');
      const client = await connect({ registrationPath: join(f.home, '.local/state/opencode/service.json') });
      const adapter = helper(client, { stateRoot: dirname(f.statePath), chatID: 'test-next-recovery' });
      const { sessionID } = await adapter.bind(f.workspace, f.plan, baseline, 1);
      const { messageID } = await adapter.submit(f.workspace, f.plan, 'next-recovery', f.packet, baseline);
      const frontend = await reservePort(), backend = await reservePort();
      const { port } = frontend, api = backend.port;
      t.after(frontend.close);
      await backend.close();
      if (scenario !== 'resume') await frontend.close();

      const cwd = join(f.workspace, 'app web'), bin = join(f.workspace, 'portable node'), logs = join(f.workspace, 'logs');
      const shim = join(cwd, 'node_modules/.bin/next.cmd'), log = join(logs, 'next.log'), node = join(bin, 'node.exe');
      for (const file of [shim, log, node]) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'disposable fixture');
      }
      writeFileSync(join(cwd, 'browser.cjs'), `const { chromium } = require('playwright'); const origin = "http://127.0.0.1:${port}";`);
      const now = Date.now() - 80, records = f.messages.get(sessionID);
      const logTime = new Date(now + (scenario === 'wrong log' ? 0 : 20));
      utimesSync(log, logTime, logTime);
      records[0].time = { created: now - 1 };
      const env = `$env:AUTOPENTEST_API='http://127.0.0.1:${api}'; $env:NEXT_TELEMETRY_DISABLED='1'; Set-Location "${cwd}"; `;
      const launch = env + String.raw`& .\node_modules\.bin\next.cmd dev -p ${port} *> "${log}"`;
      const retry = `$env:PATH="${bin};"+$env:PATH; ` +
        (scenario === 'different stand' ? launch.replace(`dev -p ${port}`, `dev -p ${api}`) : launch);
      function shell(id, command, at, output, exit = 0, shellID) {
        const metadata = shellID ? { status: 'running', truncated: false, shellID } : { status: 'completed', truncated: false, exit };
        records.push({ id: 'msg_' + id, type: 'assistant', model, time: { created: now + at - 1, completed: now + at + 1 },
          content: [{ id: 'call_' + id, type: 'tool', name: 'shell', time: { ran: now + at, completed: now + at + 1 },
            state: { status: 'completed', input: { command, ...(shellID ? { background: true } : {}) },
              content: [{ type: 'text', text: output }], metadata } }] });
      }
      function notice(id, command, at, exit = 1) {
        records.push({ id: 'msg_notice' + id, type: 'synthetic', description: command, time: { created: now + at },
          metadata: { source: 'shell', shellID: id, jobID: id, state: 'completed', truncated: false, exit },
          text: `<shell id="${id}" state="completed" command="${command}">\n(no output)\n\nExited with code ${exit}\n</shell>` });
      }
      shell('parse', `$log="${logs}"; ` + env + String.raw`Start-Process -FilePath "cmd.exe" -ArgumentList '/c','node_modules\.bin\next.cmd dev -p ${port} > "'+$log+'\next.log" 2>&1' -WindowStyle Hidden -PassThru | Select-Object Id,ProcessName | Format-Table -AutoSize | Out-String`,
        2, '    + FullyQualifiedErrorId : PositionalParameterNotFound,Microsoft.PowerShell.Commands.StartProcessCommand', 1);
      if (scenario !== 'single launch') {
        shell('first', launch, 6, '', 0, 'sh_first');
        notice('sh_first', launch, 9);
      }
      shell('retry', retry, 12, '', 0, 'sh_retry');
      shell('ready', `"ready=$false"; Get-Content "${log}" -TotalCount 6 -Encoding Unicode`, 15, scenario === 'no readiness' ? 'ready=False' :
        `ready=False\n▲ Next.js 16.2.9 (Turbopack)\n- Local: http://localhost:${port}\n✓ Ready in 4.7s\n`);
      const pid = 4294967294;
      shell('listener', `netstat -ano | Select-String ":${port}" | Out-String -Width 160`, 18,
        ` TCP  0.0.0.0:${port}  0.0.0.0:0  LISTENING  ${pid}\n TCP [::]:${port} [::]:0 LISTENING ${pid}\n`);
      const check = String.raw`$node="${node}"; $log="${logs}"; cd "${cwd}"; & $node browser.cjs *> "$log\browser.log"; "exit=$LASTEXITCODE"; Get-Content "$log\browser.log" | Out-String -Width 200`;
      shell('badcheck', check, 21, 'exit=1\nassertion failed');
      shell('check', check, 24, scenario === 'failed tests' ? 'exit=1\nassertion still failing' : 'exit=0\n{"scenario":"checked"}');
      if (scenario === 'another failed test') shell('othercheck', 'node --test extra.cjs', 25, 'assertion failed', 1);
      if (scenario !== 'no shutdown') {
        shell('stop', `$conns = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if($conns){ $pids=$conns.OwningProcess | Sort-Object -Unique; foreach($p in $pids){ $proc=Get-Process -Id $p -ErrorAction SilentlyContinue; "stopping pid=$p name=$($proc.ProcessName)"; & taskkill.exe /PID $p /T /F | Out-String } } else { "no listener on ${port}" }; Start-Sleep -Seconds 2; $left = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if($left){"still listening: $($left.OwningProcess)"} else {"${port} free"}; $left${api} = Get-NetTCPConnection -LocalPort ${api} -State Listen -ErrorAction SilentlyContinue; if($left${api}){"${api} busy: $($left${api}.OwningProcess)"} else {"${api} free"}`,
          27, `stopping pid=${scenario === 'wrong PID' ? pid - 1 : pid} name=node\n\n${port} free\n${api} free\n`);
      }
      notice('sh_retry', retry, 29, scenario === 'graceful retry' ? 0 : 1);
      if (scenario === 'another shell error') records.at(-2).content.push({ id: 'call_unrelated', type: 'tool', name: 'shell',
        time: { ran: now + 27, completed: now + 28 },
        state: { status: 'error', error: { type: 'tool.execution' }, input: { command: 'unrelated command' } } });
      f.finish(sessionID);
      const stopped = await adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 10000 });
      if (scenario === 'single launch' || scenario === 'graceful retry') {
        assert.equal(stopped.kind, 'completed-for-review', JSON.stringify(stopped));
        assert.equal(stopped.result.backgroundRecovery.failedLaunch, scenario === 'single launch' ? undefined : 'call_first');
        assert.equal(stopped.result.backgroundRecovery.launch, 'call_retry');
        assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
        return;
      }
      assert.equal(stopped.phase, 'STOPPED', JSON.stringify(stopped));
      if (scenario === 'another shell error') assert.equal(stopped.exchangeFailure?.toolID, 'call_unrelated');
      if (scenario === 'resume') {
        assert.match(stopped.error, /shutdown is not confirmed/);
        await frontend.close();
        const result = await adapter.wait(f.workspace, f.plan, { nonGitBaseline: baseline, timeoutMs: 10000,
          resume: { sessionID, messageID, assignmentID: 'next-recovery' } });
        assert.equal(result.kind, 'completed-for-review', JSON.stringify(result));
        assert.equal(result.correctionCount, 1);
        assert.equal(result.messageID, messageID);
        assert.equal(result.sessionID, sessionID);
        assert.deepEqual(result.result.backgroundRecovery, { failedLaunch: 'call_first', launch: 'call_retry',
          rejectedLaunches: ['call_parse'], stop: 'call_stop', checks: ['call_check'], pid, port, backendPort: api });
        assert.equal(result.result.toolErrors.filter(row => row.classification === 'recovered-background-shell').length, 2);
        assert.equal((await adapter.finish(f.workspace, f.plan, baseline)).phase, 'FINISHED');
      }
      assert.equal(f.posts('/api/session/' + sessionID + '/prompt'), 1);
    });
  }
});
