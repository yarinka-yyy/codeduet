import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { MODEL, connect } from './connection.mjs';
import { helper } from './binding.mjs';

try {
  const { positionals: args, values } = parseArgs({ allowPositionals: true, options: { 'non-git-baseline': { type: 'string' }, 'timeout-ms': { type: 'string' } } });
  const [command, workspace, plan, assignment, packet] = args;
  if (!['inspect', 'bind', 'submit', 'wait', 'reply'].includes(command) || args.length !== ({ inspect: 1, bind: 3, submit: 5, wait: 3, reply: 6 })[command]) {
    throw new Error('Usage: cli.mjs inspect | bind <workspace> <plan> | submit <workspace> <plan> <assignment-id> <packet> | wait <workspace> <plan> [--timeout-ms <ms>] | reply <workspace> <plan> <question|permission> <request-id> <answer-json-file> [--non-git-baseline <declaration>]; paths must be absolute');
  }
  let client;
  try { client = await connect(); }
  catch (error) {
    if (command !== 'inspect') await helper(null).connectionLost();
    throw error;
  }
  let result;
  if (command === 'inspect') result = { kind: 'connected', version: client.version, model: MODEL };
  else {
    const adapter = helper(client);
    const baseline = values['non-git-baseline'];
    if (command === 'bind') result = await adapter.bind(workspace, plan, baseline);
    else if (command === 'submit') result = await adapter.submit(workspace, plan, assignment, packet, baseline);
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
  console.log(JSON.stringify(result));
  if (result.phase === 'STOPPED') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ kind: 'stopped', error: error.message, retried: false }));
  process.exitCode = 1;
}
