import { parseArgs } from 'node:util';
import { MODEL, connect } from './connection.mjs';
import { helper } from './binding.mjs';

try {
  const { positionals: args, values } = parseArgs({ allowPositionals: true, options: { 'non-git-baseline': { type: 'string' } } });
  const [command, workspace, plan, assignment, packet] = args;
  if (!['inspect', 'bind', 'submit'].includes(command) || args.length !== ({ inspect: 1, bind: 3, submit: 5 })[command]) {
    throw new Error('Usage: cli.mjs inspect | bind <absolute-workspace> <absolute-plan> | submit <absolute-workspace> <absolute-plan> <assignment-id> <absolute-packet> [--non-git-baseline <declaration>]');
  }
  const client = await connect();
  let result;
  if (command === 'inspect') result = { kind: 'connected', version: client.version, model: MODEL };
  else {
    const adapter = helper(client);
    result = command === 'bind'
      ? await adapter.bind(workspace, plan, values['non-git-baseline'])
      : await adapter.submit(workspace, plan, assignment, packet, values['non-git-baseline']);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ kind: 'stopped', error: error.message, retried: false }));
  process.exitCode = 1;
}
