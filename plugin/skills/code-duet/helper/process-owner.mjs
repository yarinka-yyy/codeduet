import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const host = createHash('sha256').update(process.platform + ':' + hostname()).digest('hex');
export const validProcessOwner = value => value && Object.keys(value).length === 3 &&
  Number.isSafeInteger(value.pid) && value.pid > 0 && /^[a-f0-9]{64}$/.test(value.host) &&
  (value.start === null || typeof value.start === 'string' && /^[a-zA-Z0-9:-]{1,160}$/.test(value.start));

export function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try { process.kill(pid, 0); }
  catch (error) { return { state: error.code === 'ESRCH' ? 'absent' : 'unknown' }; }
  try {
    let start;
    if (process.platform === 'win32') {
      const exe = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      start = execFileSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!/^\d+$/.test(start)) return { state: 'unknown' };
    } else if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      start = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' +
        stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } else return { state: 'unknown' };
    return { state: 'present', start };
  } catch {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return { state: 'absent' }; }
    return { state: 'unknown' };
  }
}
let own;
export function processOwner() {
  return own ??= { pid: process.pid, host, start: probeProcess(process.pid).start ?? null };
}
export function ownerLiveness(owner, probe = probeProcess) {
  if (!validProcessOwner(owner)) return { status: 'unknown', reason: 'legacy-owner-unverifiable' };
  if (owner.host !== host) return { status: 'unknown', reason: 'different-host' };
  let current;
  try { current = probe(owner.pid); } catch { return { status: 'unknown', reason: 'process-query-unavailable' }; }
  if (current?.state === 'absent') return { status: 'dead', reason: 'process-absent' };
  if (current?.state !== 'present' || !owner.start || !current.start)
    return { status: 'unknown', reason: 'process-query-unavailable' };
  return current.start === owner.start ? { status: 'live', reason: 'same-process-start' } :
    { status: 'dead', reason: 'pid-reused' };
}
