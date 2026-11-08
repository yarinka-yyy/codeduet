import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { requireValue as need } from './connection.mjs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const callID = value => typeof value === 'string' && /^(?:call_[a-zA-Z0-9_]{1,120}|chatcmpl-tool-[a-zA-Z0-9_-]{1,120})$/.test(value);
const record = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validatePostgresRecovery(value) {
  need(record(value, ['messageID', 'dataDirectory', 'log', 'logHash', 'port', 'calls']) &&
    typeof value.messageID === 'string' && /^msg_[a-zA-Z0-9]+$/.test(value.messageID) &&
    [value.dataDirectory, value.log].every(path => typeof path === 'string' && path.length <= 1024 && isAbsolute(path)) &&
    hash(value.logHash) && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 &&
    Array.isArray(value.calls) && value.calls.length > 0 && value.calls.length <= 64 && value.calls.every(call =>
      record(call, ['id', 'commandHash', 'pid']) && callID(call.id) && hash(call.commandHash) &&
      Number.isSafeInteger(call.pid) && call.pid > 0) &&
    new Set(value.calls.map(call => call.id)).size === value.calls.length, 'Invalid PostgreSQL recovery evidence');
  return value;
}

function inWorkspace(workspace, path, directory) {
  const physical = realpathSync(path), inside = relative(realpathSync(workspace), physical);
  need(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep) &&
    (directory ? lstatSync(physical).isDirectory() : lstatSync(physical).isFile()), 'PostgreSQL evidence path outside workspace or wrong type');
  return physical;
}

function recoveryData(run, path) {
  const layout = relative(run, path);
  need(layout === 'pgdata' || layout === join('data', 'pgdata'), 'PostgreSQL data and log must belong to the same run');
  let current = run;
  for (const part of layout.split(sep)) {
    current = join(current, part);
    let entry;
    try { entry = lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return join(run, layout); throw error; }
    need(entry.isDirectory() && !entry.isSymbolicLink() && !relative(current, realpathSync(current)),
      'PostgreSQL data path is redirected or is not a directory');
  }
  return current;
}

function pidFileAbsent(path) {
  try { lstatSync(join(path, 'postmaster.pid')); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function readRecoveryLog(workspace, path) {
  let log;
  try { log = inWorkspace(workspace, path, false); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing PostgreSQL logs/postgres.log; recover the original run log and its SHA-256');
    throw error;
  }
  need(!relative(log, path) && lstatSync(log).size <= 1_048_576, 'PostgreSQL recovery log is redirected or too large');
  const bytes = readFileSync(log);
  need(bytes.length <= 1_048_576, 'PostgreSQL log is too large for recovery');
  return bytes;
}

function postgresIdle(port, includeClients, data, pids) {
  need(process.platform === 'win32' && process.env.SystemRoot, 'PostgreSQL recovery requires a Windows process check');
  const exe = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    $pg = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe' OR Name='pg_ctl.exe'");
    if (${includeClients ? '$true' : '$false'} -and (Get-Process -Name psql,initdb,pg_isready,createdb -ErrorAction SilentlyContinue)) { exit }
    $related = @{}; $other = @{};
    foreach ($p in $pg) {
      if (($env:DUET_PG_RECOVERY_PIDS -split ',') -contains [string]$p.ProcessId) { exit }
      $m = [regex]::Match([string]$p.CommandLine, '(?i)(?:^|\s)-D\s+(?:"([^"]+)"|(\S+))(?=\s|$)');
      if ($m.Success) {
        $path = $m.Groups[1].Value + $m.Groups[2].Value;
        if (![IO.Path]::IsPathRooted($path)) { exit }
        $path = (Resolve-Path -LiteralPath $path).ProviderPath;
        if ($path -ieq $env:DUET_PG_RECOVERY_DATA) { exit }
        $other[[int]$p.ProcessId] = $p.CreationDate;
      } else { $related[[int]$p.ProcessId] = $p }
    }
    foreach ($p in $related.Values) {
      if (!$other.ContainsKey([int]$p.ParentProcessId) -or $other[[int]$p.ParentProcessId] -gt $p.CreationDate) { exit }
    }
    $listener = Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq ${port};
    if (!$listener) { 'idle' }`;
  const output = execFileSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DUET_PG_RECOVERY_DATA: data, DUET_PG_RECOVERY_PIDS: pids.join(',') } });
  return output.trim() === 'idle';
}

// Only these literal pg_ctl invocations may have their start verb removed from the shell guard.
const pgStart = /(^[ \t]*&[ \t]+\(Join-Path \$bin 'pg_ctl\.exe'\)[ \t]+-D \$pgdata -l \(Join-Path \$run 'logs[\\/]postgres\.log'\) (?:-w -t \d+|-W) )start(?=[ \t\r\n]|$)/gm;
const wrapper = /^[ \t]*& powershell\.exe -NoProfile -ExecutionPolicy Bypass -File (?:\$\w+|\(Join-Path \$\w+ '[^'\r\n]+?\.ps1'\)) -Mode Up[ \t]*\r?$/gm;
const portableStart = /((?:^|;)[ \t]*& "\$pgbin[\\/]pg_ctl\.exe" -D "\$run[\\/]pgdata" -l "\$run[\\/]logs[\\/]postgres\.log" -o (?:"-p (\d+) -c listen_addresses=127\.0\.0\.1" -w |'"-p (\d+) -c listen_addresses=127\.0\.0\.1 -c logging_collector=off"' ))start(?=[ \t;\r\n]|$)/gm;
const nativeCall = /(^|[;\r\n])([ \t]*)&([ \t]+\(Join-Path \$bin 'pg_ctl\.exe'\) -D \$data )(?:-l \$log (start)|(-m fast stop|status))(?=[ \t]*(?:[;\r\n]|$))/gim;

function nativePostgresCall(tool) {
  const command = tool.state?.input?.command;
  if (tool.name !== 'shell' || typeof command !== 'string') return;
  const invocations = [...command.matchAll(nativeCall)];
  const verbs = invocations.map(match => (match[4] ?? match[5]).toLowerCase()).join(',');
  if (!['start,status', '-m fast stop,status'].includes(verbs)) return;
  const declared = name => {
    const assignments = [...command.matchAll(new RegExp(`(?:^|[;\\r\\n])[ \\t]*\\$${name}[ \\t]*=[ \\t]*([^;\\r\\n]+)`, 'gi'))];
    return assignments.length === 1 && assignments[0].index < invocations[0].index ? assignments[0][1].trim() : undefined;
  };
  const path = name => declared(name)?.match(/^'([^']+)'$/)?.[1];
  const run = path('run'), data = path('data'), bin = path('bin');
  if (![run, data, bin].every(value => value && isAbsolute(value))) return;
  const start = verbs.startsWith('start');
  if (start && !/^Join-Path \$run 'logs[\\/]postgres\.log'$/i.test(declared('log') ?? '')) return;
  const ports = [...command.matchAll(/\bGet-NetTCPConnection -State Listen -LocalPort (\d+)\b/gi)];
  if (ports.length !== 1) return;
  const port = Number(ports[0][1]);
  const { status, exit, signal, timeout, background, truncated } = tool.state.metadata ?? {};
  if (tool.state.status !== 'completed' || status !== 'completed' || exit !== 0 || signal !== undefined ||
    timeout === true || background === true || tool.state.input.background === true || truncated === true ||
    !Array.isArray(tool.state.content)) return;
  const lines = tool.state.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .flatMap(part => part.text.split(/\r?\n/).map(line => line.trim()));
  const field = name => {
    const matches = lines.filter(line => line.startsWith(name + '='));
    return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
  };
  const pid = Number(field('postmaster_pid'));
  if (start ? field('start_exit') !== '0' || field('status_exit') !== '0' || !Number.isSafeInteger(pid) || pid <= 0 ||
    !lines.some(line => line.split(/\s+/).join(' ') === `127.0.0.1 ${port} ${pid}`) :
    field('stop_exit') !== '0' || field('status_exit') !== '3' || field('pid_file_exists') !== 'False' || field('listeners') !== '0') return;
  return { tool, run, data, bin, port, start, pid, command: command.replace(nativeCall,
    (match, boundary, indent, args, startVerb, stopVerb) => boundary + indent + ' ' + args +
      (startVerb ? '-l $log      ' : stopVerb)) };
}

export function inferPostgresRecovery(binding, tools) {
  if (!Number.isSafeInteger(binding.submittedAt) || !binding.messageID) return;
  const starts = tools.map(nativePostgresCall).filter(call => call?.start);
  if (starts.length !== 1) return;
  const { tool, run, data, port, pid } = starts[0];
  const log = join(run, 'logs', 'postgres.log');
  return validatePostgresRecovery({ messageID: binding.messageID, dataDirectory: data, log,
    logHash: sha256(readRecoveryLog(binding.workspace, log)), port,
    calls: [{ id: tool.id, commandHash: sha256(tool.state.input.command), pid }] });
}

export function verifyPostgresRecovery(binding, tools, idleAt, probe = postgresIdle, backgroundShells) {
  const evidence = validatePostgresRecovery(binding.postgresRecovery);
  need(evidence.messageID === binding.messageID && Number.isSafeInteger(binding.submittedAt) &&
    Number.isSafeInteger(idleAt) && idleAt >= binding.submittedAt, 'PostgreSQL evidence has a different delivery or unknown time boundary');
  const run = inWorkspace(binding.workspace, dirname(dirname(evidence.log)), true);
  const native = evidence.calls.length === 1 && nativePostgresCall(tools.find(tool => tool.id === evidence.calls[0].id) ?? {});
  let cluster = run;
  if (native?.start) {
    cluster = inWorkspace(binding.workspace, dirname(dirname(native.data)), true);
    need(!relative(run, native.run) && !relative(dirname(run), dirname(cluster)) &&
      !relative(native.data, join(cluster, 'data', 'pgdata')) && !relative(native.data, evidence.dataDirectory) &&
      !relative(native.bin, join(cluster, 'tools', 'pgsql', 'bin')) && native.port === evidence.port &&
      native.pid === evidence.calls[0].pid, 'PostgreSQL run, cluster, PID or listener does not match the launch call');
  }
  const data = recoveryData(cluster, evidence.dataDirectory);
  need(!relative(evidence.log, join(run, 'logs', 'postgres.log')), 'Expected logs/postgres.log in the PostgreSQL run directory');
  let launches;
  if (binding.postgresTimeline) {
    need(!relative(evidence.log, join(run, 'logs', 'postgres.log')) && binding.postgresTimeline.length === evidence.calls.length &&
      binding.postgresTimeline.every((item, index) => item.id === evidence.calls[index].id && item.pid === evidence.calls[index].pid &&
        Number.isSafeInteger(item.startedAt) && Number.isSafeInteger(item.endedAt) && item.startedAt >= binding.submittedAt &&
        item.startedAt < item.endedAt && item.endedAt <= idleAt && typeof item.timeout === 'boolean' &&
        (!index || binding.postgresTimeline[index - 1].endedAt < item.startedAt)), 'Invalid saved PostgreSQL lifecycle');
    launches = binding.postgresTimeline.map(({ pid, startedAt, endedAt }) => ({ pid, startedAt, endedAt }));
  } else {
    const bytes = readRecoveryLog(binding.workspace, evidence.log);
    need(sha256(bytes) === evidence.logHash, 'PostgreSQL recovery log changed');
    launches = parsePostgresLog(bytes, evidence.port, binding.submittedAt, idleAt);
    need(launches.length === evidence.calls.length, 'PostgreSQL lifecycle evidence is incomplete');
  }
  const recovered = new Map();
  // shortcut: Windows recovery supports PostgreSQL's UTC and MSK timestamped PID log format.
  function parsePostgresLog(bytes, port, submittedAt, idleAt) {
    const running = new Map(), launches = [];
    for (const line of bytes.toString('utf8').split(/\r?\n/)) {
      if (!/LOG:\s+(?:starting PostgreSQL |listening on IPv[46] address |database system is shut down\s*$)/.test(line)) continue;
      const event = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) (UTC|MSK) \[(\d+)\] LOG:\s+(starting PostgreSQL .+|listening on IPv[46] address .+, port \d+|database system is shut down)\s*$/);
      need(event, 'Unsupported PostgreSQL lifecycle log entry');
      const [, date, time, zone, rawPID, message] = event;
      const at = Date.parse(date + 'T' + time + (zone === 'MSK' ? '+03:00' : 'Z')), pid = Number(rawPID);
      need(Number.isSafeInteger(at) && Number.isSafeInteger(pid) && pid > 0, 'Invalid PostgreSQL lifecycle log entry');
      if (at < submittedAt) continue;
      need(at <= idleAt, 'PostgreSQL lifecycle extends beyond the delivered history');
      if (message.startsWith('starting ')) {
        need(!running.size && (!launches.length || launches.at(-1).endedAt < at), 'Overlapping PostgreSQL launches in recovery log');
        running.set(pid, { startedAt: at, portConfirmed: false });
      } else {
        const instance = running.get(pid);
        need(instance && instance.startedAt <= at, 'PostgreSQL log entry cannot be paired to its launch');
        if (message.startsWith('listening ')) {
          need(message.endsWith(', port ' + port), 'PostgreSQL listener disagrees with recovery evidence');
          instance.portConfirmed = true;
        } else {
          need(instance.portConfirmed && instance.startedAt < at, 'PostgreSQL shutdown lacks its launch or listener evidence');
          launches.push({ pid, startedAt: instance.startedAt, endedAt: at });
          running.delete(pid);
        }
      }
    }
    need(!running.size, 'PostgreSQL lifecycle evidence is incomplete');
    return launches;
  }
  let includeClients = binding.legacyPostgresClients === true;
  for (const [index, launch] of launches.entries()) {
    const call = evidence.calls[index];
    const candidates = tools.filter(tool => tool.id === call.id);
    const tool = candidates[0], command = tool?.state?.input?.command;
    const background = backgroundShells?.get(tool?.state?.metadata?.shellID);
    const notice = background?.toolID === call.id && background.messageID === tool?.messageID &&
      background.notice?.metadata?.state === 'completed' && background.notice.metadata.exit === 0 ? background.notice : undefined;
    const endedAt = notice?.time?.created ?? tool?.time?.completed;
    need(candidates.length === 1 && tool.name === 'shell' && tool.state.status === 'completed' &&
      (tool.state.metadata?.status === 'completed' || notice) && typeof command === 'string' && sha256(command) === call.commandHash &&
      launch.pid === call.pid && Number.isSafeInteger(tool.time?.ran) && Number.isSafeInteger(tool.time?.completed) &&
      Number.isSafeInteger(endedAt) && tool.time.ran <= launch.startedAt && launch.startedAt <= endedAt &&
      tool.time.completed <= endedAt && endedAt <= idleAt && (!launches[index + 1] || endedAt < launches[index + 1].startedAt),
    'PostgreSQL launch does not match call ' + call.id + '; check the command SHA-256, PID and correlated launch/completion timestamps');
    const direct = [...command.matchAll(pgStart)].length, indirect = [...command.matchAll(wrapper)].length;
    const portable = [...command.matchAll(portableStart)];
    if (native?.start) {
      const stops = tools.map(nativePostgresCall).filter(stop => stop && !stop.start && !relative(run, stop.run) &&
        !relative(data, stop.data) && !relative(native.bin, stop.bin) && stop.port === evidence.port &&
        Number.isSafeInteger(stop.tool.time?.ran) && Number.isSafeInteger(stop.tool.time?.completed) &&
        endedAt <= stop.tool.time.ran && stop.tool.time.ran <= launch.endedAt &&
        launch.endedAt <= stop.tool.time.completed && stop.tool.time.completed <= idleAt);
      need(tool.time.ran >= binding.submittedAt && stops.length === 1,
        'PostgreSQL shutdown lacks a matching stop and status=3 call for the same cluster and port');
      recovered.set(call.id, { ...launch, timeout: false, command: native.command, stop: stops[0] });
      continue;
    }
    need(direct + indirect + portable.length === 1, 'Unsupported PostgreSQL launch syntax in call ' + call.id);
    const declaredRun = command.match(/^\$run[ \t]*=[ \t]*'([^'\r\n]+)'(?=[ \t]*(?:;|\r?$))/m)?.[1];
    const declaredScript = command.match(/^\$script[ \t]*=[ \t]*'([^'\r\n]+\.ps1)'\r?$/m)?.[1];
    need(declaredRun && isAbsolute(declaredRun) && !relative(run, declaredRun) ||
      indirect && declaredScript && isAbsolute(declaredScript) && !relative(run, dirname(declaredScript)),
    'PostgreSQL launch directory does not match evidence in call ' + call.id);
    if (direct || indirect) need(!relative(data, join(run, 'data', 'pgdata')), 'PostgreSQL command and evidence data paths disagree');
    if (direct) need(/^\$pgdata=Join-Path \$run 'data[\\/]pgdata'\r?$/m.test(command),
      'PostgreSQL data directory is not explicit in call ' + call.id);
    if (portable.length) {
      const [, , waitingPort, foregroundPort] = portable[0];
      need(!relative(data, join(run, 'pgdata')) && Number(waitingPort ?? foregroundPort) === evidence.port &&
        [...command.matchAll(/(?:^|;)[ \t]*\$run[ \t]*=/gmi)].length === 1 &&
        /(?:^|;)[ \t]*\$pgbin[ \t]*=[ \t]*'[^'\r\n]+'(?=[ \t]*(?:;|\r?$))/m.test(command) &&
        [...command.matchAll(/(?:^|;)[ \t]*\$pgbin[ \t]*=/gmi)].length === 1,
      'PostgreSQL run directory, launcher path or port is not explicit in call ' + call.id);
    }
    const timeout = tool.state.metadata.timeout === true;
    includeClients ||= portable.length > 0 && timeout;
    recovered.set(call.id, { ...launch, timeout,
      command: direct ? command.replace(pgStart, '$1     ') : portable.length ?
        command.replace(portableStart, '$1     ').replace(/"pg_ctl (start) exit: \$LASTEXITCODE"/g, '"pg_ctl       exit: $LASTEXITCODE"') : command });
  }
  for (const tool of tools) {
    const command = tool.state?.input?.command;
    if (typeof command === 'string' && [...command.matchAll(wrapper)].length)
      need(recovered.has(tool.id), 'PostgreSQL recovery is missing a wrapper launch in call ' + tool.id);
  }
  let idle;
  try { idle = pidFileAbsent(data) && probe(evidence.port, includeClients, data, evidence.calls.map(call => call.pid)) && pidFileAbsent(data); }
  catch (error) { throw new Error('Cannot verify PostgreSQL process/port ownership; check Windows CIM and listener access', { cause: error }); }
  need(idle, 'PostgreSQL process, listener or PID file still present or its owner is unknown; check the recorded PIDs and port');
  return recovered;
}
