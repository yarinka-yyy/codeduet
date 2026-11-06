import { parseArgs } from 'node:util';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { connect, diagnose } from './connection.mjs';
import { context, helper, inspect, listSessions, maintainTasks, preflight, startCycle, WAIT_TIMEOUT_MS } from './binding.mjs';

let client;
try {
  const { positionals: args, values } = parseArgs({ allowPositionals: true, options: { action: { type: 'string' }, 'non-git-baseline': { type: 'string' }, 'timeout-ms': { type: 'string' }, kind: { type: 'string' }, 'correction-count': { type: 'string' }, cursor: { type: 'string' }, session: { type: 'string' }, 'postgres-evidence': { type: 'string' } } });
  const [command, workspace, plan, assignment, packet] = args;
  const ownershipUsage = 'ownership <workspace> <plan> <lease-token> [--action inspect|stop|recover] [--non-git-baseline <declaration>]';
  const closeUsage = 'close-assignment <workspace> <plan> <assignment-id> <message-id> --session <exact-id>';
  const transitionUsage = 'transition <workspace> <target-plan> <prior-message-id> <accepted|blocked|without-acceptance> [--kind block|correction] [--non-git-baseline <declaration>]';
  if (command === 'task-maintenance' && args.length !== 3) throw new Error('Usage: cli.mjs task-maintenance <absolute-workspace> <absolute-plan.md>');
  if (command === 'start-cycle' && args.length !== 3) throw new Error('Usage: cli.mjs start-cycle <absolute-workspace> <absolute-plan.md>');
  if (command === 'ownership' && args.length !== 4) throw new Error('Usage: cli.mjs ' + ownershipUsage);
  if (command === 'close-assignment' && args.length !== 5) throw new Error('Usage: cli.mjs ' + closeUsage);
  if (command === 'transition' && (args.length !== 5 || !/^msg_[a-zA-Z0-9]+$/.test(assignment) ||
    !['accepted', 'blocked', 'without-acceptance'].includes(packet))) throw new Error('Usage: cli.mjs ' + transitionUsage);
  if (!['ownership', 'task-maintenance', 'start-cycle', 'retire-legacy', 'inspect', 'sessions', 'preflight', 'adopt', 'bind', 'submit', 'wait', 'resume-watch', 'reply', 'next', 'finish', 'close-assignment', 'transition'].includes(command) ||
    !(command === 'inspect' ? [1, 2].includes(args.length) : args.length === ({ ownership: 4, 'task-maintenance': 3, 'start-cycle': 3, 'retire-legacy': 4, sessions: 2, preflight: 3, adopt: 4, bind: 3, submit: 5, wait: 3, 'resume-watch': 5, reply: 6, next: 4, finish: 3, 'close-assignment': 5, transition: 5 })[command])) {
    throw new Error('Usage: cli.mjs inspect [<workspace>] | sessions <workspace> [--cursor <cursor>] | preflight <workspace> <plan> [--session <exact-id>] [--correction-count <0..20>] [--non-git-baseline <declaration>] | adopt <workspace> <plan> <session-id> [--correction-count <0..20>] | bind <workspace> <plan> [--correction-count <0..20>] | submit <workspace> <plan> <assignment-id> <packet> [--kind initial|block|correction] | resume-watch <workspace> <plan> <assignment-id> <message-id> --session <exact-id> [--timeout-ms <ms>] | wait <workspace> <plan> [--timeout-ms <ms>] | reply <workspace> <plan> <question|permission> <request-id> <answer-json-file> | next <workspace> <plan> <block|correction> | finish <workspace> <plan> [--non-git-baseline <declaration>] | retire-legacy <workspace> <old-plan> <lease-token>; paths must be absolute');
  }
  if (values.kind !== undefined && !['submit', 'transition'].includes(command) || values['correction-count'] !== undefined && !['bind', 'adopt', 'preflight'].includes(command) || values.cursor !== undefined && command !== 'sessions' || values.session !== undefined && !['preflight', 'resume-watch', 'close-assignment'].includes(command)) throw new Error('Assignment kind belongs to submit/transition; correction-count to bind/adopt/preflight; session to preflight/resume-watch/close-assignment; cursor to sessions');
  if (values.action !== undefined && command !== 'ownership' || command === 'ownership' &&
    !['inspect', 'stop', 'recover'].includes(values.action ?? 'inspect')) throw new Error('Usage: cli.mjs ' + ownershipUsage);
  if (values['timeout-ms'] !== undefined && !['wait', 'resume-watch'].includes(command)) throw new Error('timeout-ms belongs to wait/resume-watch');
  let postgresRecovery;
  if (values['postgres-evidence'] !== undefined) {
    const path = values['postgres-evidence'];
    if (command !== 'resume-watch' || !isAbsolute(path)) throw new Error('postgres-evidence requires resume-watch and an absolute JSON file path');
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 65536) throw new Error('Invalid PostgreSQL evidence file');
    postgresRecovery = JSON.parse(readFileSync(path, 'utf8'));
  }
  if (command === 'resume-watch' && (!/^ses_[a-zA-Z0-9]+$/.test(values.session) ||
    !/^[a-zA-Z0-9._-]{1,120}$/.test(assignment) || !/^msg_[a-zA-Z0-9]+$/.test(packet)))
    throw new Error('resume-watch <workspace> <plan> <assignment-id> <message-id> requires --session <exact-id>');
  if (command === 'close-assignment' && (!/^ses_[a-zA-Z0-9]+$/.test(values.session) ||
    !/^[a-zA-Z0-9._-]{1,120}$/.test(assignment) || !/^msg_[a-zA-Z0-9]+$/.test(packet)))
    throw new Error('Usage: cli.mjs ' + closeUsage);
  let importedCount, timeoutMs, replyPayload;
  if (values['correction-count'] !== undefined) {
    importedCount = Number(values['correction-count']);
    if (!Number.isInteger(importedCount) || importedCount < 0 || importedCount > 20) throw new Error('Invalid correction count');
  }
  if (values['timeout-ms'] !== undefined) {
    timeoutMs = Number(values['timeout-ms']);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WAIT_TIMEOUT_MS) throw new Error('Wait timeout must be 1..' + WAIT_TIMEOUT_MS + ' ms');
  }
  if (command === 'preflight') {
    if (!isAbsolute(workspace) || !isAbsolute(plan)) throw new Error('Use absolute workspace and plan paths');
  } else if (['retire-legacy', 'task-maintenance', 'start-cycle', 'close-assignment'].includes(command)) {
    if (!isAbsolute(workspace) || !isAbsolute(plan)) throw new Error('Use absolute workspace and plan paths');
  } else if (command !== 'inspect' && command !== 'sessions') {
    if (!isAbsolute(workspace) || !isAbsolute(plan)) throw new Error('Use absolute workspace and plan paths');
    context(workspace, plan, values['non-git-baseline']);
  } else if (command === 'sessions' && !isAbsolute(workspace)) throw new Error('Use an absolute discovery workspace');
  if (command === 'submit' && !isAbsolute(packet)) throw new Error('Use absolute packet path');
  if (command === 'reply') {
    if (!isAbsolute(args[5])) throw new Error('Use absolute answer JSON path');
    try { replyPayload = JSON.parse(readFileSync(args[5], 'utf8')); } catch { throw new Error('Invalid answer JSON file'); }
  }
  let connectionError, result;
  if (command === 'task-maintenance') result = maintainTasks(workspace, plan);
  if (command === 'start-cycle') result = startCycle(workspace, plan);
  if (command === 'ownership') result = await helper(null).observationOwner(workspace, plan, assignment,
    { action: values.action, nonGitBaseline: values['non-git-baseline'] });
  try { if (!['ownership', 'task-maintenance', 'start-cycle'].includes(command)) client = await connect(); }
  catch (error) {
    if (['inspect', 'preflight', 'close-assignment', 'transition'].includes(command)) connectionError = error;
    else {
      try { if (!['sessions', 'retire-legacy'].includes(command)) result = await helper(null).connectionLost(error); }
      catch (stateError) {
        error.persistenceFailure = diagnose(stateError, 'state-io', 'state-write');
      }
      result ??= { kind: 'stopped', error: error.message, diagnostic: diagnose(error, 'unknown', 'connection'),
        stateChange: error?.persistenceFailure ? 'unconfirmed' : 'unchanged', retried: error?.bootstrap?.retried ?? false };
      if (error?.bootstrap) result.bootstrap = error.bootstrap;
      if (error?.persistenceFailure) result.persistenceFailure = error.persistenceFailure;
    }
  }
  if (result === undefined && command === 'inspect') result = await inspect(client, { workspace, connectionError });
  else if (result === undefined && command === 'sessions') result = await listSessions(client, workspace, values.cursor);
  else if (result === undefined && command === 'preflight') result = await preflight(client, { workspace, planPath: plan,
    sessionID: values.session, correctionCount: importedCount, nonGitBaseline: values['non-git-baseline'], connectionError });
  else if (result === undefined) {
    const adapter = helper(client);
    const baseline = values['non-git-baseline'];
    if (command === 'bind') result = await adapter.bind(workspace, plan, baseline, importedCount);
    else if (command === 'retire-legacy') result = await adapter.retireLegacy(workspace, plan, assignment);
    else if (command === 'adopt') result = await adapter.adopt(workspace, plan, assignment, baseline, importedCount);
    else if (command === 'submit') result = await adapter.submit(workspace, plan, assignment, packet, baseline, values.kind ?? 'initial');
    else if (command === 'next') result = await adapter.next(workspace, plan, assignment, baseline);
    else if (command === 'finish') result = await adapter.finish(workspace, plan, baseline);
    else if (command === 'transition') result = await adapter.transition(workspace, plan, assignment, packet,
      { kind: values.kind, nonGitBaseline: baseline, connectionError });
    else if (command === 'close-assignment') result = await adapter.closeAssignment(workspace, plan,
      { sessionID: values.session, assignmentID: assignment, messageID: packet }, connectionError);
    else if (['wait', 'resume-watch'].includes(command)) {
      const abort = new AbortController();
      const interrupt = () => abort.abort();
      for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(name, interrupt);
      try { result = await adapter.wait(workspace, plan, { nonGitBaseline: baseline, signal: abort.signal, postgresRecovery,
        ...(timeoutMs ? { timeoutMs } : {}), ...(command === 'resume-watch' ? {
          resume: { sessionID: values.session, assignmentID: assignment, messageID: packet } } : {}) }); }
      finally { for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.off(name, interrupt); }
    } else {
      result = await adapter.reply(workspace, plan, assignment, packet, replyPayload, baseline);
    }
  }
  if (client?.bootstrap && command !== 'preflight') result.bootstrap = { attempts: client.bootstrap.attempts, retried: client.bootstrap.retried };
  if (result.kind === 'stopped') console.error(JSON.stringify(result));
  else console.log(JSON.stringify(result));
  if (command === 'ownership') {
    if (['rejected', 'observation-stop-pending'].includes(result.kind)) process.exitCode = 1;
  } else if (result.phase === 'STOPPED' || ['close-assignment', 'transition'].includes(command) && result.ownershipReleaseFailure ||
    ['stopped', 'connection-unavailable', 'correction-limit', 'rejected'].includes(result.kind) ||
    result.kind === 'preflight' && result.status !== 'pass') process.exitCode = 1;
} catch (error) {
  const outcome = error.stateOutcome ?? { kind: error.diagnostic ? 'stopped' : 'rejected',
    error: error.message, retried: false, stateChange: 'unchanged',
    ...(['unchanged', 'unconfirmed'].includes(error.adoptionState) ?
      { adoption: { bindingState: error.adoptionState, engineMutation: 'none' } } : {}),
    ...(error.diagnostic ? { diagnostic: diagnose(error, 'unknown', 'connection') } : {}) };
  if (error.adoptionState && !outcome.adoption) outcome.adoption = { bindingState: error.adoptionState, engineMutation: 'none' };
  if (error.ownershipReleaseFailure && !outcome.ownershipReleaseFailure) outcome.ownershipReleaseFailure = error.ownershipReleaseFailure;
  if (error.persistenceFailure && !outcome.persistenceFailure) outcome.persistenceFailure = error.persistenceFailure;
  if (error.bootstrap) outcome.bootstrap = error.bootstrap;
  if (client?.bootstrap && !outcome.bootstrap) outcome.bootstrap = { attempts: client.bootstrap.attempts, retried: client.bootstrap.retried };
  console.error(JSON.stringify(outcome));
  process.exitCode = 1;
}
