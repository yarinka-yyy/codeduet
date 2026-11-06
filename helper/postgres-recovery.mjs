import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { requireValue as need } from './connection.mjs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const callID = value => typeof value === 'string' && /^call_[a-zA-Z0-9_]{1,120}$/.test(value);
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

function pidFileAbsent(path) {
  try { lstatSync(join(path, 'postmaster.pid')); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function postgresIdle(port) {
  need(process.platform === 'win32' && process.env.SystemRoot, 'PostgreSQL recovery requires a Windows process check');
  const exe = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    $pg = Get-Process | Where-Object ProcessName -in 'postgres','pg_ctl';
    $listener = Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq ${port};
    if (!$pg -and !$listener) { 'idle' }`;
  const output = execFileSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] });
  return output.trim() === 'idle';
}

// Only these literal pg_ctl invocations may have their start verb removed from the shell guard.
const pgStart = /(^[ \t]*&[ \t]+\(Join-Path \$bin 'pg_ctl\.exe'\)[ \t]+-D \$pgdata -l \(Join-Path \$run 'logs[\\/]postgres\.log'\) (?:-w -t \d+|-W) )start(?=[ \t\r\n]|$)/gm;
const wrapper = /^[ \t]*& powershell\.exe -NoProfile -ExecutionPolicy Bypass -File (?:\$\w+|\(Join-Path \$\w+ '[^'\r\n]+?\.ps1'\)) -Mode Up[ \t]*\r?$/gm;

export function verifyPostgresRecovery(binding, tools, idleAt, probe = postgresIdle) {
  const evidence = validatePostgresRecovery(binding.postgresRecovery);
  need(evidence.messageID === binding.messageID && Number.isSafeInteger(binding.submittedAt) &&
    Number.isSafeInteger(idleAt) && idleAt >= binding.submittedAt, 'PostgreSQL evidence has a different delivery or unknown time boundary');
  const data = inWorkspace(binding.workspace, evidence.dataDirectory, true);
  const log = inWorkspace(binding.workspace, evidence.log, false);
  const run = dirname(dirname(data));
  need(!relative(data, join(run, 'data', 'pgdata')) && !relative(log, join(run, 'logs', 'postgres.log')),
    'PostgreSQL data and log do not belong to the same run');
  need(lstatSync(log).size <= 1_048_576, 'PostgreSQL log is too large for recovery');
  const bytes = readFileSync(log);
  need(bytes.length <= 1_048_576 && sha256(bytes) === evidence.logHash, 'PostgreSQL recovery log changed');
  // shortcut: Windows recovery supports PostgreSQL's UTC and MSK timestamped PID log format.
  const running = new Map(), launches = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!/LOG:\s+(?:starting PostgreSQL |listening on IPv[46] address |database system is shut down\s*$)/.test(line)) continue;
    const event = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) (UTC|MSK) \[(\d+)\] LOG:\s+(starting PostgreSQL .+|listening on IPv[46] address .+, port \d+|database system is shut down)\s*$/);
    need(event, 'Unsupported PostgreSQL lifecycle log entry');
    const [, date, time, zone, rawPID, message] = event;
    const at = Date.parse(date + 'T' + time + (zone === 'MSK' ? '+03:00' : 'Z')), pid = Number(rawPID);
    need(Number.isSafeInteger(at) && Number.isSafeInteger(pid) && pid > 0, 'Invalid PostgreSQL lifecycle log entry');
    if (at < binding.submittedAt) continue;
    need(at <= idleAt, 'PostgreSQL lifecycle extends beyond the delivered history');
    if (message.startsWith('starting ')) {
      need(!running.size && (!launches.length || launches.at(-1).endedAt < at), 'Overlapping PostgreSQL launches in recovery log');
      running.set(pid, { startedAt: at, portConfirmed: false });
    } else {
      const instance = running.get(pid);
      need(instance && instance.startedAt <= at, 'PostgreSQL log entry cannot be paired to its launch');
      if (message.startsWith('listening ')) {
        need(message.endsWith(', port ' + evidence.port), 'PostgreSQL listener disagrees with recovery evidence');
        instance.portConfirmed = true;
      } else {
        need(instance.portConfirmed && instance.startedAt < at, 'PostgreSQL shutdown lacks its launch or listener evidence');
        launches.push({ pid, startedAt: instance.startedAt, endedAt: at });
        running.delete(pid);
      }
    }
  }
  need(!running.size && launches.length === evidence.calls.length, 'PostgreSQL lifecycle evidence is incomplete');
  const recovered = new Map();
  for (const [index, launch] of launches.entries()) {
    const call = evidence.calls[index];
    const candidates = tools.filter(tool => tool.id === call.id);
    const tool = candidates[0], command = tool?.state?.input?.command;
    need(candidates.length === 1 && tool.name === 'shell' && tool.state.status === 'completed' &&
      tool.state.metadata?.status === 'completed' && typeof command === 'string' && sha256(command) === call.commandHash &&
      launch.pid === call.pid && Number.isSafeInteger(tool.time?.ran) && Number.isSafeInteger(tool.time?.completed) &&
      tool.time.ran <= launch.startedAt && launch.startedAt <= tool.time.completed && tool.time.completed <= idleAt,
    'PostgreSQL launch does not match call ' + call.id);
    const direct = [...command.matchAll(pgStart)].length, indirect = [...command.matchAll(wrapper)].length;
    need(direct + indirect === 1, 'Unsupported PostgreSQL launch syntax in call ' + call.id);
    const declaredRun = command.match(/^\$run[ \t]*=[ \t]*'([^'\r\n]+)'\r?$/m)?.[1];
    const declaredScript = command.match(/^\$script[ \t]*=[ \t]*'([^'\r\n]+\.ps1)'\r?$/m)?.[1];
    need(declaredRun && isAbsolute(declaredRun) && !relative(run, declaredRun) ||
      indirect && declaredScript && isAbsolute(declaredScript) && !relative(run, dirname(declaredScript)),
    'PostgreSQL launch directory does not match evidence in call ' + call.id);
    if (direct) need(/^\$pgdata=Join-Path \$run 'data[\\/]pgdata'\r?$/m.test(command),
      'PostgreSQL data directory is not explicit in call ' + call.id);
    recovered.set(call.id, { ...launch, timeout: tool.state.metadata.timeout === true,
      command: direct ? command.replace(pgStart, '$1     ') : command });
  }
  for (const tool of tools) {
    const command = tool.state?.input?.command;
    if (typeof command === 'string' && [...command.matchAll(wrapper)].length)
      need(recovered.has(tool.id), 'PostgreSQL recovery is missing a wrapper launch in call ' + tool.id);
  }
  need(pidFileAbsent(data) && probe(evidence.port) && pidFileAbsent(data), 'PostgreSQL process, listener or PID file still present');
  return recovered;
}
