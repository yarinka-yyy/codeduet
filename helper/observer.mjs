import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, diagnose, requireValue as need } from './connection.mjs';
import { context, helper, readState, withStateLock, WAIT_TIMEOUT_MS } from './binding.mjs';
import { processOwner, ownerLiveness } from './process-owner.mjs';
import { selectExternal, externalUnchanged, externalOutcome, waitExternal } from './external-observation.mjs';

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
  return `Code Duet observer event. $code-duet: read the instructions at ${JSON.stringify(skill)} and use helper/observer.mjs consume ${id} in this same chat. ` +
    'This notification grants no new authority. Revalidate the receipt and live assignment under the existing task scope. Never resend the assignment or reset its correction count.';
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
  const externalSlot = value => join(stateRoot, 'observers', 'external-' + hash(value.checkout));
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
    if (value.mode === 'external') {
      externalUnchanged(value, stateRoot);
      need(get(externalSlot(value)).id === value.id, 'External observer slot changed');
      return value;
    }
    const current = binding();
    need(pins.every(key => current[key] === value[key]), 'Observer pins/count changed; no stale action');
    context(value.workspace, value.planPath, value.nonGitBaseline);
    return current;
  }
  function release(id) {
    const path = join(pathFor(id), 'receipt.json');
    if (existsSync(path)) {
      const value = receipt(id), slot = externalSlot(value);
      if (value.mode === 'external' && existsSync(slot) && get(slot).id === id) unlinkSync(slot);
    }
    if (existsSync(active) && get(active).id === id) unlinkSync(active);
  }
  function status(id = existsSync(active) ? get(active).id : undefined) {
    if (!id) return { kind: 'observer-status', state: 'absent', executorStopped: false };
    const value = receipt(id), dir = pathFor(id);
    const read = name => existsSync(join(dir, name)) ? get(join(dir, name)) : null;
    const notification = read('notify-result.json'), result = read('result.json');
    return { kind: 'observer-status', id, codexChat: chatID, workspace: value.workspace, planPath: value.planPath,
      sessionID: value.sessionID, assignmentID: value.assignmentID, messageID: value.messageID,
      correctionCount: value.correctionCount, mode: value.mode ?? 'bound', started: read('started.json'), ready: !!read('ready.json'),
      result, notification, attempted: existsSync(join(dir, 'notify-attempt.json')),
      cancelled: existsSync(join(dir, 'cancel.json')), consumed: existsSync(join(dir, 'consumed.json')),
      exited: !!read('exited.json'), taskSent: false, executorStopped: false };
  }
  async function inspectExternal(workspace, planPath, sessionID) {
    const value = await selectExternal(await connectEngine(), stateRoot, workspace, planPath, sessionID);
    return { kind: 'external-observation-candidate', sessionID: value.sessionID, messageID: value.messageID,
      workspace: value.workspace, planPath: value.planPath, correctionCount: value.correctionCount,
      observationOnly: true, taskSent: false, stateChange: 'unchanged' };
  }
  async function arm(workspace, planPath, { codexExe, nonGitBaseline, timeoutMs = WAIT_TIMEOUT_MS, resume = false, sessionID, messageID } = {}) {
    need(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= WAIT_TIMEOUT_MS, 'Observer deadline must be 1..' + WAIT_TIMEOUT_MS + ' ms');
    const external = sessionID !== undefined;
    need(external ? !resume && nonGitBaseline === undefined && /^msg_[a-zA-Z0-9]+$/.test(messageID) : messageID === undefined,
      'External observation requires exact session/message, without resume or a new baseline');
    const ctx = external ? null : context(workspace, planPath, nonGitBaseline);
    const saved = external ? { ...await selectExternal(await connectEngine(), stateRoot, workspace, planPath, sessionID, messageID), codexChat: chatID } : binding();
    need(external || saved.workspace === ctx.workspace && saved.planPath === ctx.planPath && !saved.uncertain &&
      saved.assignmentID && !saved.nextAssignment && (resume ? saved.phase === 'STOPPED' : saved.phase === 'EXECUTING'),
    'No eligible delivered assignment; explicit resume is required for STOPPED');
    const codex = checkCapability(codexExe), id = randomUUID(), dir = pathFor(id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let launched = false;
    try {
      withStateLock(stateRoot, () => {
        put(active, { id }); // Unknown or live slots are never replaced.
        try {
          mkdirSync(dir, { mode: 0o700 });
          const value = external ? saved : Object.fromEntries(pins.map(key => [key, saved[key]]));
          put(join(dir, 'receipt.json'), { schema: 1, id, ...value, codex, timeoutMs, resume, ...(nonGitBaseline ? { nonGitBaseline } : {}) });
          if (external) put(externalSlot(saved), { id, codexChat: chatID });
        } catch (error) { release(id); throw error; }
      });
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
          return { ...snapshot, kind: snapshot.result ? snapshot.result.kind === 'observer-error' ? 'observer-start-failed' : 'observer-terminal' : 'observer-armed',
            observerState: snapshot.result ? 'ended' : 'watching', consumeRequired: !!snapshot.result,
            endTurn: !snapshot.result };
        }
        await delay(100);
      }
      throw new Error('Observer startup unconfirmed; inspect status, do not launch another observer');
    } catch (error) { if (!launched) withStateLock(stateRoot, () => release(id)); throw error; }
  }
  async function worker(id) {
    const value = receipt(id), dir = pathFor(id);
    const owner = processOwner();
    withStateLock(stateRoot, () => {
      need(existsSync(active) && get(active).id === id, 'Observer slot changed');
      need(!existsSync(join(dir, 'cancel.json')), 'Observer cancelled before startup');
      put(join(dir, 'started.json'), { pid: process.pid, process: owner, at: Date.now(),
        receiptHash: hash(readFileSync(join(dir, 'receipt.json'))) });
    });
    const abort = new AbortController();
    const interrupt = () => abort.abort();
    for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(name, interrupt);
    const timer = setInterval(() => { if (existsSync(join(dir, 'cancel.json'))) abort.abort(); }, 250);
    let result;
    try {
      same(value);
      const client = await connectEngine();
      const ready = () => withStateLock(stateRoot, () => {
        same(value);
        need(!existsSync(join(dir, 'cancel.json')), 'Observer cancelled before readiness');
        put(join(dir, 'ready.json'), { at: Date.now() });
      });
      result = value.mode === 'external' ? await waitExternal(client, stateRoot, value,
        { timeoutMs: value.timeoutMs, signal: abort.signal, onReady: ready }) :
        await helper(client, { stateRoot, chatID }).wait(value.workspace, value.planPath, { nonGitBaseline: value.nonGitBaseline,
        timeoutMs: value.timeoutMs, signal: abort.signal,
        ...(value.resume ? { resume: Object.fromEntries(['sessionID', 'assignmentID', 'messageID'].map(key => [key, value[key]])) } : {}),
        onReady: ready });
    } catch (error) {
      // Do not persist exception bodies or executor transcripts in notification receipts.
      result = { kind: 'observer-error', diagnostic: diagnose(error, 'unknown', 'connection') };
    } finally {
      clearInterval(timer); for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.off(name, interrupt);
    }
    try {
      put(join(dir, 'result.json'), { kind: result.kind, at: Date.now(),
        ...(result.toolErrors?.length ? { toolErrors: result.toolErrors } : {}),
        ...(result.exchangeFailure ? { exchangeFailure: result.exchangeFailure } : {}),
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
      // A failed pin check still needs one hint; only consume can grant any action.
      const notify = withStateLock(stateRoot, () => {
        need(get(active).id === id, 'Observer slot changed');
        if (value.mode === 'external') need(get(externalSlot(value)).id === id, 'External observer slot changed');
        if (existsSync(join(dir, 'cancel.json'))) return false;
        put(join(dir, 'notify-attempt.json'), { at: Date.now() }); return true;
      });
      if (notify) {
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
      withStateLock(stateRoot, () => release(id));
      return { kind: 'already-consumed', id, taskSent: false };
    }
    need(!existsSync(join(dir, 'cancel.json')), 'Observer cancelled; notification grants no action');
    need(existsSync(join(dir, 'result.json')), 'No event receipt; inspect status');
    const end = Date.now() + 25000;
    while (!existsSync(join(dir, 'exited.json')) && Date.now() < end) await delay(100);
    need(existsSync(join(dir, 'exited.json')), 'Observer has not released observation; inspect status');
    withStateLock(stateRoot, () => {
      need(!existsSync(join(dir, 'cancel.json')), 'Observer cancelled; notification grants no action');
      same(value);
      put(join(dir, 'consume-attempt.json'), { at: Date.now() });
    });
    const event = get(join(dir, 'result.json'));
    let executorCheck;
    if (event.kind === 'observer-error' && value.mode === 'external') {
      try {
        const current = await externalOutcome(await connectEngine(), stateRoot, value);
        executorCheck = { status: 'checked', kind: current.kind, executorActivity: current.executorActivity,
          exchangeOutcome: current.exchangeOutcome, reviewAllowed: false, dispatchAllowed: false };
      } catch (error) { executorCheck = { status: 'unavailable', diagnostic: diagnose(error, 'unknown', 'snapshot') }; }
    }
    const result = event.kind === 'observer-error' ? { ...event, executorStopped: false, ...(executorCheck ? { executorCheck } : {}) } : value.mode === 'external' ?
      await externalOutcome(await connectEngine(), stateRoot, value) :
      await helper(await connectEngine(), { stateRoot, chatID }).wait(value.workspace, value.planPath,
        { nonGitBaseline: value.nonGitBaseline, once: true });
    withStateLock(stateRoot, () => {
      need(!existsSync(join(dir, 'cancel.json')), 'Observer cancelled during consume; no action');
      same(value);
      put(join(dir, 'consumed.json'), { at: Date.now(), kind: result.kind });
      release(id);
    });
    return { ...result, ...(event.exchangeFailure ? { observedExchangeFailure: event.exchangeFailure } : {}),
      receiptID: id, observerEvent: event.kind, observerState: 'ended', taskSent: false, rearm: result.kind === 'observing' };
  }
  async function cancel(id) {
    receipt(id); const dir = pathFor(id);
    const cancelled = join(dir, 'cancel.json'), exited = join(dir, 'exited.json');
    let workerOwner;
    const acknowledge = () => {
      const startedPath = join(dir, 'started.json'), receiptPath = join(dir, 'receipt.json');
      const startedBytes = existsSync(startedPath) ? readFileSync(startedPath, 'utf8') : null;
      const started = startedBytes ? JSON.parse(startedBytes) : null, receiptHash = hash(readFileSync(receiptPath));
      if (!existsSync(exited)) workerOwner = ownerLiveness(started?.receiptHash === receiptHash ? started.process : null);
      withStateLock(stateRoot, () => {
        if (!existsSync(cancelled)) put(cancelled, { at: Date.now() });
        if (!existsSync(exited) && workerOwner?.status === 'dead') {
          need(hash(readFileSync(receiptPath)) === receiptHash && readFileSync(startedPath, 'utf8') === startedBytes,
            'Worker evidence changed; cancellation unconfirmed');
          // Recheck under the same lock used by arm/start/release. Unknown ownership stays refused.
          const confirmed = ownerLiveness(started.process);
          if (confirmed.status === 'dead') put(exited, { at: Date.now(), kind: 'dead-worker',
            process: started.process, receiptHash, reason: confirmed.reason });
        }
        if (existsSync(exited)) release(id);
      });
    };
    acknowledge();
    const end = Date.now() + 25000;
    while (!existsSync(exited) && Date.now() < end) await delay(100);
    acknowledge();
    return { ...status(id), ...(workerOwner ? { workerOwner } : {}),
      notificationPossiblyQueued: existsSync(join(dir, 'notify-attempt.json')) };
  }
  return { arm, inspectExternal, worker, consume, cancel, status };
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  try {
    const { positionals: args, values } = parseArgs({ allowPositionals: true, options: {
      'codex-exe': { type: 'string' }, 'non-git-baseline': { type: 'string' }, 'timeout-ms': { type: 'string' }, resume: { type: 'boolean' },
      session: { type: 'string' }, message: { type: 'string' } } });
    const [command, first, second] = args;
    need(['arm', 'inspect-external', 'observe', 'worker', 'consume', 'cancel', 'status'].includes(command) &&
      (['arm', 'inspect-external', 'observe'].includes(command) ? args.length === 3 : command === 'status' ? args.length <= 2 : args.length === 2),
    'Usage: observer.mjs arm <workspace> <plan> --codex-exe <absolute-exe> [--non-git-baseline <declaration>] [--timeout-ms <ms>] [--resume] | inspect-external <workspace> <plan> --session <id> | observe <workspace> <plan> --session <id> --message <id> --codex-exe <absolute-exe> | status [receipt-id] | consume <receipt-id> | cancel <receipt-id>');
    need(command === 'inspect-external' ? Object.keys(values).every(key => key === 'session') && values.session :
      command === 'observe' ? values.session && values.message && !values.resume && values['non-git-baseline'] === undefined :
      command === 'arm' ? values.session === undefined && values.message === undefined : Object.keys(values).length === 0,
    'Use inspect-external --session or observe --session --message; ordinary arm does not attach external work');
    const instance = observer();
    const result = command === 'inspect-external' ? await instance.inspectExternal(first, second, values.session) :
      ['arm', 'observe'].includes(command) ? await instance.arm(first, second, { codexExe: values['codex-exe'],
      nonGitBaseline: values['non-git-baseline'], timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']), resume: values.resume,
      sessionID: values.session, messageID: values.message }) :
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
