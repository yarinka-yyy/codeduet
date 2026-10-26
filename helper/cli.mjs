import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { connect, diagnose } from './connection.mjs';
import { helper, inspect, listSessions } from './binding.mjs';

try {
  const { positionals: args, values } = parseArgs({ allowPositionals: true, options: { 'non-git-baseline': { type: 'string' }, 'timeout-ms': { type: 'string' }, kind: { type: 'string' }, 'correction-count': { type: 'string' }, cursor: { type: 'string' } } });
  const [command, workspace, plan, assignment, packet] = args;
  if (!['inspect', 'sessions', 'adopt', 'bind', 'submit', 'wait', 'reply', 'next', 'finish'].includes(command) ||
    !(command === 'inspect' ? [1, 2].includes(args.length) : args.length === ({ sessions: 2, adopt: 4, bind: 3, submit: 5, wait: 3, reply: 6, next: 4, finish: 3 })[command])) {
    throw new Error('Usage: cli.mjs inspect [<workspace>] | sessions <workspace> [--cursor <cursor>] | adopt <workspace> <plan> <session-id> [--correction-count <0..20>] | bind <workspace> <plan> [--correction-count <0..20>] | submit <workspace> <plan> <assignment-id> <packet> [--kind initial|block|correction] | wait <workspace> <plan> [--timeout-ms <ms>] | reply <workspace> <plan> <question|permission> <request-id> <answer-json-file> | next <workspace> <plan> <block|correction> | finish <workspace> <plan> [--non-git-baseline <declaration>]; paths must be absolute');
  }
  if (values.kind !== undefined && command !== 'submit' || values['correction-count'] !== undefined && !['bind', 'adopt'].includes(command) || values.cursor !== undefined && command !== 'sessions') throw new Error('Assignment kind belongs to submit; correction-count to bind/adopt; cursor to sessions');
  let client, connectionError;
  try { client = await connect(); }
  catch (error) {
    if (command !== 'inspect') { if (command !== 'sessions') await helper(null).connectionLost(error); throw error; }
    connectionError = error;
  }
  let result;
  if (command === 'inspect') result = await inspect(client, { workspace, connectionError });
  else if (command === 'sessions') result = await listSessions(client, workspace, values.cursor);
  else {
    const adapter = helper(client);
    const baseline = values['non-git-baseline'];
    if (command === 'bind') result = await adapter.bind(workspace, plan, baseline, values['correction-count'] === undefined ? undefined : Number(values['correction-count']));
    else if (command === 'adopt') result = await adapter.adopt(workspace, plan, assignment, baseline, values['correction-count'] === undefined ? undefined : Number(values['correction-count']));
    else if (command === 'submit') result = await adapter.submit(workspace, plan, assignment, packet, baseline, values.kind ?? 'initial');
    else if (command === 'next') result = await adapter.next(workspace, plan, assignment, baseline);
    else if (command === 'finish') result = await adapter.finish(workspace, plan, baseline);
    else if (command === 'wait') {
      const abort = new AbortController();
      const interrupt = () => abort.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try { result = await adapter.wait(workspace, plan, { nonGitBaseline: baseline, signal: abort.signal, ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}) }); }
      finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
    } else {
      if (!isAbsolute(args[5])) throw new Error('Use absolute answer JSON path');
      let payload;
      try { payload = JSON.parse(readFileSync(args[5], 'utf8')); } catch { throw new Error('Invalid answer JSON file'); }
      result = await adapter.reply(workspace, plan, assignment, packet, payload, baseline);
    }
  }
  if (result.kind === 'stopped') console.error(JSON.stringify(result));
  else console.log(JSON.stringify(result));
  if (result.phase === 'STOPPED' || result.kind === 'stopped') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ kind: 'stopped', error: error.message, retried: false,
    ...(error.diagnostic ? { diagnostic: diagnose(error, 'unknown', 'connection') } : {}) }));
  process.exitCode = 1;
}
