// Explicit long-running CLI/SSE simulator, excluded from node --test. No model calls.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fixture, baseline } from './http-fixture.mjs';

const [evidenceRoot, durationText, cli] = process.argv.slice(2);
const durationMs = Number(durationText);
assert.ok(isAbsolute(evidenceRoot || '') && !existsSync(evidenceRoot), 'New absolute evidence directory required');
assert.ok(Number.isInteger(durationMs) && durationMs > 0 && durationMs <= 3_400_000, 'Duration: 1..3400000 ms');
assert.ok(cli === undefined || isAbsolute(cli), 'CLI override must be absolute and simulator-only');
mkdirSync(evidenceRoot);
const cleanup = [];
let finishTimer;
try {
  const f = await fixture({ after: callback => cleanup.push(callback) }, cli);
  const bound = await f.call(f.bindArgs(0)); assert.equal(bound.status, 0);
  const sessionID = bound.result.sessionID;
  const admitted = await f.call(['submit', f.workspace, f.plan, 'long-wait-007', f.packet, '--non-git-baseline', baseline]);
  assert.equal(admitted.status, 0);
  const stateBeforeWait = readFileSync(f.statePath);
  const startedAt = Date.now();
  writeFileSync(join(evidenceRoot, 'started.json'), JSON.stringify({ startedAt, durationMs, cli: cli ?? 'source', modelCalls: 0 }));
  const waiting = f.call(['wait', f.workspace, f.plan, '--timeout-ms', String(durationMs + 120_000),
    '--non-git-baseline', baseline], undefined, durationMs + 150_000);
  let quietSnapshot;
  finishTimer = setTimeout(() => {
    quietSnapshot = { at: Date.now(), pid: f.running.pid, stdoutBytes: f.running.stdoutBytes, stderrBytes: f.running.stderrBytes,
      historyReads: f.calls.filter(call => call.route.includes('/message?')).length, streamOpens: f.streamOpens,
      stateUnchanged: readFileSync(f.statePath).equals(stateBeforeWait) };
    f.finish(sessionID);
  }, durationMs);
  const outcome = await waiting;
  writeFileSync(join(evidenceRoot, 'wait-outcome.json'), JSON.stringify({ ...outcome,
    observedAt: Date.now(), elapsedMs: Date.now() - startedAt, streamOpens: f.streamOpens,
    historyReads: f.calls.filter(call => call.route.includes('/message?')).length,
    requests: f.calls.length, posts: f.calls.filter(call => call.method === 'POST').length,
    quietSnapshot: quietSnapshot ?? null }, null, 2) + '\n');
  assert.equal(outcome.status, 0); assert.equal(outcome.result.kind, 'completed-for-review');
  assert.ok(quietSnapshot.at - startedAt >= durationMs - 10);
  assert.equal(quietSnapshot.stdoutBytes, 0); assert.equal(quietSnapshot.stderrBytes, 0);
  assert.equal(quietSnapshot.historyReads, 1); assert.equal(quietSnapshot.streamOpens, 1);
  assert.equal(quietSnapshot.stateUnchanged, true);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(f.calls.filter(call => call.route.includes('/message?')).length, 2);
  const report = { kind: 'long-wait-passed', durationMs, elapsedMs: Date.now() - startedAt,
    quietSnapshot, outcome: outcome.result.kind, phase: outcome.result.phase,
    cliProcessesDuringWait: 1, streamOpens: f.streamOpens, historyReads: 2,
    requests: f.calls.length, posts: 2, modelCalls: 0, hostModelRequests: 'NOT_OBSERVABLE' };
  writeFileSync(join(evidenceRoot, 'wait-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(finishTimer);
  for (const callback of cleanup.reverse()) await callback();
}
