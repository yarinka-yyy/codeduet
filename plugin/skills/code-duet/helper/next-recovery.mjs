import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const pathPart = String.raw`([^"\r\n\x00-\x1f\x60$;]+)`;
const launchPattern = new RegExp(String.raw`^(?:\$env:PATH="${pathPart};"\+\$env:PATH; )?\$env:AUTOPENTEST_API='http://127\.0\.0\.1:(\d{1,5})'; \$env:NEXT_TELEMETRY_DISABLED='1'; Set-Location "${pathPart}"; & \.\\node_modules\\\.bin\\next\.cmd dev -p (\d{1,5}) \*> "${pathPart}"$`, 'i');
const browserPattern = new RegExp(String.raw`^\$node="${pathPart}"; \$log="${pathPart}"; cd "${pathPart}"; & \$node ([\w.-]+\.cjs) \*> "\$log\\([\w.-]+\.log)"; "[\w -]*exit=\$LASTEXITCODE"; Get-Content "\$log\\\5" \| Out-String -Width \d+$`, 'i');
const rejectedStart = new RegExp(String.raw`^\$log="${pathPart}"; \$env:AUTOPENTEST_API='http://127\.0\.0\.1:(\d{1,5})'; \$env:NEXT_TELEMETRY_DISABLED='1'; Set-Location "${pathPart}"; Start-Process -FilePath "cmd\.exe" -ArgumentList '/c','node_modules\\\.bin\\next\.cmd dev -p (\d{1,5}) > "'\+\$log\+'\\next\.log" 2>&1' -WindowStyle Hidden -PassThru \| Select-Object Id,ProcessName \| Format-Table -AutoSize \| Out-String$`, 'i');

function physical(workspace, path, directory = false) {
  if (!isAbsolute(path)) return;
  try {
    const actual = realpathSync(path), rel = relative(workspace, actual);
    const entry = lstatSync(actual);
    if (!relative(path, actual) && rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) &&
      (directory ? entry.isDirectory() : entry.isFile())) return entry;
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
}

const commandOf = tool => tool.state.input?.command;
function foreground(tool, exit) {
  const { metadata, content } = tool.state;
  if (tool.name !== 'shell' || tool.state.status !== 'completed' || metadata?.status !== 'completed' ||
    metadata.truncated !== false || !Number.isSafeInteger(metadata.exit) || exit !== undefined && metadata.exit !== exit ||
    metadata.shellID !== undefined || metadata.signal !== undefined || metadata.timeout === true ||
    tool.state.input?.background === true || !Number.isSafeInteger(tool.time?.ran) ||
    !Number.isSafeInteger(tool.time?.completed) || tool.time.ran > tool.time.completed ||
    !Array.isArray(content) || !content.length || !content.every(part => part.type === 'text' && typeof part.text === 'string')) return;
  return content.map(part => part.text.replace(/\r\n/g, '\n')).join('\n').trimEnd();
}

function stopCommand(port, backend) {
  return `$conns = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if($conns){ $pids=$conns.OwningProcess | Sort-Object -Unique; foreach($p in $pids){ $proc=Get-Process -Id $p -ErrorAction SilentlyContinue; "stopping pid=$p name=$($proc.ProcessName)"; & taskkill.exe /PID $p /T /F | Out-String } } else { "no listener on ${port}" }; Start-Sleep -Seconds 2; $left = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if($left){"still listening: $($left.OwningProcess)"} else {"${port} free"}; $left${backend} = Get-NetTCPConnection -LocalPort ${backend} -State Listen -ErrorAction SilentlyContinue; if($left${backend}){"${backend} busy: $($left${backend}.OwningProcess)"} else {"${backend} free"}`;
}

function browserChecks(workspace, tools, port, node, readyAt) {
  const checks = new Map();
  for (const tool of tools) {
    const command = commandOf(tool);
    const match = typeof command === 'string' && command.match(browserPattern);
    if (!match) {
      // A separate failed runner is still unresolved even when a supported check passed.
      const metadata = tool.state.metadata;
      if (tool.name === 'shell' && typeof command === 'string' &&
        /(?:^|[;\r\n])\s*(?:&\s*)?(?:\$node\b|(?:node|npm|npx|playwright)(?:\.exe|\.cmd)?\s)/i.test(command) &&
        (metadata?.timeout === true || metadata?.signal !== undefined ||
          Number.isSafeInteger(metadata?.exit) && metadata.exit !== 0 ||
          /^[\w -]*exit=[1-9]\d*$/im.test(foreground(tool) ?? ''))) return;
      continue;
    }
    const [, exe, log, cwd, script] = match;
    if (relative(node, exe) || !physical(workspace, log, true) || !physical(workspace, cwd, true)) return;
    const path = join(cwd, script), info = physical(workspace, path);
    if (!info || info.size > 262144) return;
    const source = readFileSync(path, 'utf8');
    if (!source.includes('playwright') || !new RegExp('["\\x27]http://127\\.0\\.0\\.1:' + port + '["\\x27]').test(source)) return;
    const output = foreground(tool);
    const status = output?.match(/^[\w -]*exit=(\d+)\n(?=[^\n])/i);
    const prior = checks.get(path);
    if (prior && prior.tool.time.completed >= tool.time?.ran) return;
    checks.set(path, { tool, passed: tool.time?.ran >= readyAt && tool.state.metadata?.exit === 0 && status?.[1] === '0' });
  }
  const values = [...checks.values()];
  if (values.length && values.every(check => check.passed)) return values.map(check => check.tool.id);
}

// shortcut: recover only the supported literal Windows Next.js launch/retry/cleanup sequence.
export function nextRecovery(binding, tools, backgroundShells, final, idle) {
  if (process.platform !== 'win32' || !binding.workspace || final?.finish !== 'stop' ||
    !Number.isSafeInteger(final.time?.completed) || idle?.type !== 'idle' || idle.outcome !== 'succeeded') return;
  const candidates = [];
  for (const tool of tools) {
    const command = commandOf(tool), match = typeof command === 'string' && command.match(launchPattern);
    const launch = backgroundShells.get(tool.state.metadata?.shellID), notice = launch?.notice;
    if (!match || !notice || launch.toolID !== tool.id || launch.messageID !== tool.messageID ||
      notice.metadata.state !== 'completed' || ![0, 1].includes(notice.metadata.exit) || notice.metadata.truncated !== false ||
      notice.metadata.signal !== undefined || notice.metadata.timeout === true ||
      notice.time.created > final.time.completed) continue;
    candidates.push({ tool, command, match, notice, ran: launch.ran });
  }
  if (!candidates.length || candidates.length > 2) return;
  const retry = candidates.at(-1), failed = candidates.length === 2 ? candidates[0] : null;
  const [, bin, backend, cwd, port, log] = retry.match;
  if (!bin || failed && (failed.notice.metadata.exit !== 1 || failed.match[1] ||
    retry.command.slice(retry.command.indexOf('; ') + 2) !== failed.command ||
    failed.notice.time.created >= retry.ran) || Number(port) < 1 || Number(port) > 65535 ||
    Number(backend) < 1 || Number(backend) > 65535 || port === backend ||
    !physical(binding.workspace, cwd, true) || !physical(binding.workspace, join(cwd, 'node_modules/.bin/next.cmd')) ||
    !isAbsolute(bin) || !physical(binding.workspace, join(bin, 'node.exe')))
    return { missing: 'Next.js launch/retry paths, ports or shell timestamps do not match' };
  const stop = tools.filter(tool => commandOf(tool) === stopCommand(port, backend) &&
    tool.time?.ran > retry.ran && tool.time.ran <= retry.notice.time.created &&
    tool.time.completed <= final.time.completed);
  if (stop.length !== 1) return { missing: 'Next.js needs a matching taskkill and free ports before terminal idle' };
  const cleanup = stop[0], stopped = foreground(cleanup, 0);
  const stoppedPids = [...(stopped ?? '').matchAll(/^stopping pid=(\d+) name=node$/gm)];
  if (stoppedPids.length !== 1 || !stopped.endsWith('\n' + port + ' free\n' + backend + ' free'))
    return { missing: 'Next.js cleanup did not record a single Node PID and both ports free' };
  const pid = Number(stoppedPids[0][1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return;
  const probes = tools.filter(tool => tool.time?.ran > retry.ran && tool.time.completed < cleanup.time.ran);
  const ready = probes.find(tool => {
    const command = commandOf(tool), output = foreground(tool, 0);
    return typeof command === 'string' && command.endsWith('; Get-Content "' + log + '" -TotalCount 6 -Encoding Unicode') &&
      output && /Next\.js [\d.]+/.test(output) &&
      new RegExp('^- Local:\\s+http://(?:localhost|127\\.0\\.0\\.1):' + port + '$', 'm').test(output) &&
      /^. Ready in [\d.]+m?s$/m.test(output);
  });
  const logInfo = physical(binding.workspace, log);
  if (!ready || !logInfo || logInfo.mtimeMs < retry.ran || logInfo.mtimeMs > cleanup.time.completed)
    return { missing: 'Next.js readiness is missing; preserve the original run log and its timestamp' };
  const listenerLine = new RegExp('^\\s*TCP\\s+(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]|\\[::1\\]):' +
    port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$', 'gm');
  const listeners = probes.filter(tool => tool.time.ran > ready.time.completed && typeof commandOf(tool) === 'string' &&
    commandOf(tool).endsWith('netstat -ano | Select-String ":' + port + '" | Out-String -Width 160')).flatMap(tool =>
    [...(foreground(tool, 0) ?? '').matchAll(listenerLine)].map(row => ({ tool, pid: Number(row[1]) })));
  if (!listeners.length || listeners.some(row => row.pid !== pid))
    return { missing: 'Next.js cleanup PID does not match the recorded listener' };
  const checks = browserChecks(binding.workspace, probes, port, join(bin, 'node.exe'),
    listeners.reduce((first, row) => Math.min(first, row.tool.time.completed), Infinity));
  if (!checks) return { missing: 'Next.js needs passing browser checks against that listener, including any failed check repeated successfully' };
  const rejected = tools.filter(tool => {
    const command = commandOf(tool), match = typeof command === 'string' && command.match(rejectedStart);
    return match && match[2] === backend && match[3] === cwd && match[4] === port &&
      join(match[1], 'next.log') === log && tool.time?.completed < (failed ?? retry).ran &&
      /^\s*\+ FullyQualifiedErrorId\s*:\s*PositionalParameterNotFound,Microsoft\.PowerShell\.Commands\.StartProcessCommand\s*$/m
        .test(foreground(tool, 1) ?? '');
  });
  return { failed: failed?.tool, retry: retry.tool, rejected, cleanup, checks, pid, port: Number(port), backend: Number(backend) };
}

export function nextStandEnded({ pid, port, backend }) {
  const exe = join(process.env.SystemRoot ?? '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    $processes = @(Get-CimInstance Win32_Process);
    if (!$processes.Count -or ($processes | Where-Object { $_.ProcessId -eq ${pid} -or $_.ParentProcessId -eq ${pid} -or
      ($_.Name -in 'node.exe','cmd.exe' -and $_.CommandLine -match '(?i)(?:--?port|-p)\s+${port}(?:\s|["'']|$)') })) { exit }
    $listeners = @(Get-NetTCPConnection -State Listen);
    if (!($listeners | Where-Object { $_.LocalPort -in ${port},${backend} })) { 'idle' }`;
  if (!isAbsolute(exe)) return false;
  try {
    return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 4096 }).trim() === 'idle';
  } catch { return false; }
}
