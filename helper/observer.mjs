import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, diagnose, requireValue as need } from './connection.mjs';
import { context, helper, readState } from './binding.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
const pins = ['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath',
  'engineID', 'sessionID', 'assignmentID', 'messageID', 'submittedAt', 'correctionCount'];
const put = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
const get = path => JSON.parse(readFileSync(path, 'utf8'));
const here = fileURLToPath(import.meta.url);

export function wakeHint(id) {
  need(uuid.test(id), 'Invalid observer receipt');
  const skill = fileURLToPath(new URL('../SKILL.md', import.meta.url));
  return `Code Duet observer event. $code-duet: read the updated skill at ${JSON.stringify(skill)} and use helper/observer.mjs consume ${id} in this same chat. ` +
    'This is an authorized notification, not a new task or permission. Revalidate the receipt and live assignment. Never resend the assignment or reset its correction count.';
}

function capability(path) {
  need(typeof path === 'string' && isAbsolute(path), 'Use an absolute Desktop-bundled Codex executable');
  path = realpathSync(path);
  need(statSync(path).isFile(), 'Codex executable is not a file');
  const options = { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 };
  const version = spawnSync(path, ['--version'], options), help = spawnSync(path, ['queue', '--help'], options);
  need(version.status === 0 && /^codex-cli [\w.+-]+\s*$/.test(version.stdout.trim()) &&
    help.status === 0 && help.stdout.includes('Queue a message for an existing session') &&
    help.stdout.includes('--thread') && help.stdout.includes('--message'), 'Codex queue capability unavailable; no observer started');
  return { path, hash: hash(readFileSync(path)), version: version.stdout.trim() };
}

function queue(receipt) {
  need(hash(readFileSync(receipt.codex.path)) === receipt.codex.hash, 'Codex executable changed; notification not retried');
  const result = spawnSync(receipt.codex.path, ['queue', '--thread', receipt.codexChat, '--message', wakeHint(receipt.id)],
    { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 65536 });
  const match = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.\s*$/.exec(result.stdout ?? '');
  return { status: result.status === 0 && match?.[2] === receipt.codexChat ? 'sent' : 'uncertain',
    exitCode: result.status, ...(match?.[2] === receipt.codexChat ? { queuedID: match[1] } : {}) };
}

// Injectable boundaries are for isolated engine fixtures; the CLI always uses the real store/chat.
export function observer({ stateRoot = resolve(homedir(), '.local/state/code-duet'), chatID = process.env.CODEX_THREAD_ID,
  connectEngine = connect, deliver = queue, launch, checkCapability = capability } = {}) {
  need(uuid.test(chatID), 'The actual current Codex thread UUID is required');
  const directory = join(stateRoot, 'observers', hash(chatID)), active = join(directory, 'active');
  const pathFor = id => { need(uuid.test(id), 'Invalid observer receipt'); return join(directory, id); };
  function binding() {
    const state = readState(join(stateRoot, 'state.json'));
    const saved = state.bindings.find(value => value.codexChat === chatID);
    need(saved, 'No binding for this Codex chat');
    return { ...saved, correctionCount: state.plans.find(value => value.planPath === saved.planPath).correctionCount };
  }
  function receipt(id) {
    const value = get(join(pathFor(id), 'receipt.json'));
    need(value.schema === 1 && value.id === id && value.codexChat === chatID, 'Receipt belongs to another chat');
    return value;
  }
  function same(value) {
    const current = binding();
    need(pins.every(key => current[key] === value[key]), 'Observer pins/count changed; no stale action');
    context(value.workspace, value.planPath, value.nonGitBaseline);
    return current;
  }
  function release(id) {
    if (existsSync(active)) { need(get(active).id === id, 'Observer ownership changed'); unlinkSync(active); }
  }
  function status(id = existsSync(active) ? get(active).id : undefined) {
    if (!id) return { kind: 'observer-status', state: 'absent', executorStopped: false };
    const value = receipt(id), dir = pathFor(id);
    const read = name => existsSync(join(dir, name)) ? get(join(dir, name)) : null;
    const notification = read('notify-result.json'), result = read('result.json');
    return { kind: 'observer-status', id, codexChat: chatID, workspace: value.workspace, planPath: value.planPath,
      sessionID: value.sessionID, assignmentID: value.assignmentID, messageID: value.messageID,
      correctionCount: value.correctionCount, started: read('started.json'), ready: !!read('ready.json'),
      result, notification, attempted: existsSync(join(dir, 'notify-attempt.json')),
      cancelled: existsSync(join(dir, 'cancel.json')), consumed: existsSync(join(dir, 'consumed.json')),
      exited: !!read('exited.json'), taskSent: false, executorStopped: false };
  }
  async function arm(workspace, planPath, { codexExe, nonGitBaseline, timeoutMs = 3600000, resume = false } = {}) {
    need(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000, 'Observer deadline must be 1..3600000 ms');
    const ctx = context(workspace, planPath, nonGitBaseline), saved = binding();
    need(saved.workspace === ctx.workspace && saved.planPath === ctx.planPath && !saved.uncertain &&
      saved.assignmentID && !saved.nextAssignment && (resume ? saved.phase === 'STOPPED' : saved.phase === 'EXECUTING'),
    'No eligible delivered assignment; explicit resume is required for STOPPED');
    const codex = checkCapability(codexExe), id = randomUUID(), dir = pathFor(id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    put(active, { id }); // Never remove an existing slot/lease just because its process is unknown.
    let launched = false;
    try {
      mkdirSync(dir, { mode: 0o700 });
      const value = Object.fromEntries(pins.map(key => [key, saved[key]]));
      put(join(dir, 'receipt.json'), { schema: 1, id, ...value, codex, timeoutMs, resume, ...(nonGitBaseline ? { nonGitBaseline } : {}) });
      if (launch) { await launch(id); launched = true; }
      else {
        const child = spawn(process.execPath, [here, 'worker', id], { detached: true, windowsHide: true, stdio: 'ignore' });
        await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
        launched = true; child.unref();
      }
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        if (existsSync(join(dir, 'ready.json')) || existsSync(join(dir, 'result.json'))) {
          const snapshot = status(id);
          return { ...snapshot, kind: snapshot.result?.kind === 'observer-error' ? 'observer-start-failed' : 'observer-armed',
            endTurn: snapshot.result?.kind !== 'observer-error' };
        }
        await delay(100);
      }
      throw new Error('Observer startup unconfirmed; inspect status, do not launch another observer');
    } catch (error) { if (!launched) release(id); throw error; }
  }
  async function worker(id) {
    const value = receipt(id), dir = pathFor(id);
    need(existsSync(active) && get(active).id === id, 'Observer slot changed');
    put(join(dir, 'started.json'), { pid: process.pid, at: Date.now() });
    const abort = new AbortController();
    const interrupt = () => abort.abort();
    for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(name, interrupt);
    const timer = setInterval(() => { if (existsSync(join(dir, 'cancel.json'))) abort.abort(); }, 250);
    let result;
    try {
      same(value);
      const client = await connectEngine();
      const adapter = helper(client, { stateRoot, chatID });
      result = await adapter.wait(value.workspace, value.planPath, { nonGitBaseline: value.nonGitBaseline,
        timeoutMs: value.timeoutMs, signal: abort.signal,
        ...(value.resume ? { resume: Object.fromEntries(['sessionID', 'assignmentID', 'messageID'].map(key => [key, value[key]])) } : {}),
        onReady: () => put(join(dir, 'ready.json'), { at: Date.now() }) });
    } catch (error) {
      // Do not persist exception bodies or executor transcripts in notification receipts.
      result = { kind: 'observer-error', diagnostic: diagnose(error, 'unknown', 'connection') };
    } finally {
      clearInterval(timer); for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.off(name, interrupt);
    }
    try {
      put(join(dir, 'result.json'), { kind: result.kind, at: Date.now(), ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
      same(value);
      if (!existsSync(join(dir, 'cancel.json'))) {
        put(join(dir, 'notify-attempt.json'), { at: Date.now() });
        // At most one attempt: a crash or missing queue response is never permission to send again.
        let notification;
        try { notification = await deliver(value); } catch { notification = { status: 'uncertain', exitCode: null }; }
        need(['sent', 'uncertain'].includes(notification?.status), 'Unknown queue result');
        put(join(dir, 'notify-result.json'), notification);
      }
    } finally { put(join(dir, 'exited.json'), { at: Date.now() }); }
  }
  async function consume(id) {
    const value = receipt(id), dir = pathFor(id);
    if (existsSync(join(dir, 'consumed.json'))) {
      // Recover only our acknowledged slot if a crash happened just before its unlink.
      if (existsSync(active) && get(active).id === id) release(id);
      return { kind: 'already-consumed', id, taskSent: false };
    }
    need(!existsSync(join(dir, 'cancel.json')), 'Observer cancelled; notification grants no action');
    need(existsSync(join(dir, 'result.json')), 'No event receipt; inspect status');
    const end = Date.now() + 25000;
    while (!existsSync(join(dir, 'exited.json')) && Date.now() < end) await delay(100);
    need(existsSync(join(dir, 'exited.json')), 'Observer has not released observation; inspect status');
    same(value);
    put(join(dir, 'consume-attempt.json'), { at: Date.now() });
    const event = get(join(dir, 'result.json'));
    const result = event.kind === 'observer-error' ? { ...event, executorStopped: false } :
      await helper(await connectEngine(), { stateRoot, chatID }).wait(value.workspace, value.planPath,
        { nonGitBaseline: value.nonGitBaseline, once: true });
    put(join(dir, 'consumed.json'), { at: Date.now(), kind: result.kind });
    release(id);
    return { ...result, receiptID: id, taskSent: false, rearm: result.kind === 'observing' };
  }
  async function cancel(id) {
    receipt(id); const dir = pathFor(id);
    if (!existsSync(join(dir, 'cancel.json'))) put(join(dir, 'cancel.json'), { at: Date.now() });
    const end = Date.now() + 25000;
    while (!existsSync(join(dir, 'exited.json')) && Date.now() < end) await delay(100);
    if (existsSync(join(dir, 'exited.json'))) release(id);
    return { ...status(id), notificationPossiblyQueued: existsSync(join(dir, 'notify-attempt.json')) };
  }
  return { arm, worker, consume, cancel, status };
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  try {
    const { positionals: args, values } = parseArgs({ allowPositionals: true, options: {
      'codex-exe': { type: 'string' }, 'non-git-baseline': { type: 'string' }, 'timeout-ms': { type: 'string' }, resume: { type: 'boolean' } } });
    const [command, first, second] = args;
    need(['arm', 'worker', 'consume', 'cancel', 'status'].includes(command) &&
      (command === 'arm' ? args.length === 3 : command === 'status' ? args.length <= 2 : args.length === 2),
    'Usage: observer.mjs arm <workspace> <plan> --codex-exe <absolute-exe> [--non-git-baseline <declaration>] [--timeout-ms <ms>] [--resume] | status [receipt-id] | consume <receipt-id> | cancel <receipt-id>');
    need(command === 'arm' || Object.keys(values).length === 0, 'Options belong only to arm');
    const instance = observer();
    const result = command === 'arm' ? await instance.arm(first, second, { codexExe: values['codex-exe'],
      nonGitBaseline: values['non-git-baseline'], timeoutMs: values['timeout-ms'] === undefined ? 3600000 : Number(values['timeout-ms']), resume: values.resume }) :
      await instance[command](first);
    if (result) {
      console.log(JSON.stringify(result));
      if (result.kind === 'observer-start-failed' || command === 'consume' &&
        (result.phase === 'STOPPED' || result.kind === 'observer-error')) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ kind: 'observer-rejected', error: error.message, taskSent: false, retried: false }));
    process.exitCode = 1;
  }
}
