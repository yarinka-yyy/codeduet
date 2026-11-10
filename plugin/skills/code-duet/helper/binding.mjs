import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { MODEL, EXECUTOR_MODEL, requireValue as need, diagnose, diagnosticError, temporaryRead, validateDiagnostic } from './connection.mjs';
import { assignmentMessages, recentSessionMessages, closureBoundary, deliveredBoundary, deliveredExchange, sessionAvailable, completion, inspectMessages, interactive, validateAnswer, observationWake, fingerprint } from './interaction.mjs';
import { validatePostgresRecovery } from './postgres-recovery.mjs';
import { localWindowsBootTime, processOwner, ownerLiveness, validProcessOwner } from './process-owner.mjs';

export const WAIT_TIMEOUT_MS = 14_400_000;

const phases = ['PREPARING', 'EXECUTING', 'WAITING_FOR_ANSWER', 'REVIEWING', 'STOPPED', 'FINISHED'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const identity = path => { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
const stateLockWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const observationFingerprint = (binding, counter) => createHash('sha256').update(JSON.stringify([
  ...['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath', 'engineID',
    'sessionID', 'assignmentID', 'messageID', 'submittedAt'].map(key => binding[key]), counter])).digest('hex');
const fingerprintPattern = /^[a-f0-9]{64}$/;
const leaseTokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const historyFingerprint = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
const unavailableForDispatch = 'Archived or unavailable session; unarchive it in OpenCode and rerun preflight before dispatch';
const archivedSession = session => session?.archived === true || Number.isFinite(session?.time?.archived);
const shellRoute = directory => '/api/shell?location[directory]=' + encodeURIComponent(directory);
function shellListKnown(result) {
  return Array.isArray(result?.data) && result.data.every(shell =>
    ['running', 'exited', 'timeout', 'killed'].includes(shell?.status) &&
    (shell.status === 'running' || Number.isFinite(shell.time?.completed)));
}

function duplicateShellIDs(result) {
  const ids = Array.isArray(result?.data) ? result.data.map(shell => shell?.id).filter(text) : [];
  return new Set(ids).size !== ids.length;
}

export async function projectShells(client, { workspace, checkout }) {
  const local = await client.request(shellRoute(workspace));
  if (duplicateShellIDs(local)) return { data: null };
  if (!checkout || checkout === workspace) return local;
  const root = await client.request(shellRoute(checkout));
  if (!shellListKnown(local) || !shellListKnown(root) || duplicateShellIDs(root)) return { data: null };
  const shells = [...local.data];
  const byID = new Map(shells.filter(shell => text(shell.id)).map(shell => [shell.id, shell]));
  for (const shell of root.data) {
    const existing = byID.get(shell.id);
    if (existing && !isDeepStrictEqual(existing, shell)) return { data: null };
    if (!existing) shells.push(shell);
  }
  return { data: shells };
}

export function sameProjectShells(first, second) {
  const keyed = snapshot => {
    if (!Array.isArray(snapshot?.data) || !snapshot.data.every(shell => text(shell?.id))) return snapshot;
    const data = new Map(snapshot.data.map(shell => [shell.id, shell]));
    return data.size === snapshot.data.length ? { ...snapshot, data } : snapshot;
  };
  return isDeepStrictEqual(keyed(first), keyed(second));
}

async function requireQuietShells(client, binding) {
  const shells = await projectShells(client, binding);
  need(shellListKnown(shells), 'Unknown project shell status; no dispatch');
  need(shells.data.every(shell => shell.status !== 'running'), 'Project shell still running; no dispatch');
}

async function confirmHistoryAndCheckShells(client, binding, messages, shells) {
  const [latest, latestShells] = await Promise.all([assignmentMessages(client, binding), projectShells(client, binding)]);
  need(isDeepStrictEqual(latest, messages), 'History changed during completion verification');
  return sameProjectShells(latestShells, shells);
}

async function confirmHistoryAndShells(client, binding, messages, shells) {
  need(await confirmHistoryAndCheckShells(client, binding, messages, shells), 'Project shells changed during completion verification');
}
function bindFingerprint(state, binding) {
  if (!binding) return createHash('sha256').update('unbound').digest('hex');
  const { stopReason, diagnostic, ...pins } = binding;
  const counter = state.plans.find(plan => plan.planPath === binding.planPath)?.correctionCount;
  return createHash('sha256').update(JSON.stringify([pins, counter])).digest('hex');
}

function leasedBinding(state, owner) {
  return state.bindings.find(binding => binding.codexChat === owner.codexChat) ??
    state.bindings.find(binding => binding.codexChat === owner.bindingChat);
}

function leaseFingerprint(state, owner, binding = leasedBinding(state, owner)) {
  return historyFingerprint([binding ?? null, ...[owner.planPath, binding?.planPath].map(path =>
    state.plans.find(plan => plan.planPath === path) ?? null)]);
}

function physicalContext(workspace, planPath) {
  need(isAbsolute(workspace) && isAbsolute(planPath), 'Use absolute workspace and plan paths');
  const directory = realpathSync(workspace);
  const plan = realpathSync(planPath);
  need(statSync(directory).isDirectory() && statSync(plan).isFile() && inside(directory, plan) && plan.endsWith('.md'), 'Plan must be a Markdown file inside the physical workspace');
  let marker;
  for (let path = directory; ; path = dirname(path)) {
    if (existsSync(join(path, '.git'))) { marker = path; break; }
    if (dirname(path) === path) break;
  }
  let checkout = directory;
  if (marker) {
    try { checkout = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
    catch { throw new Error('Git checkout identity unavailable'); }
    need(inside(checkout, directory), 'Workspace outside checkout');
  } else {
    checkout = directory;
  }
  return { ctx: { workspace: directory, workspaceID: identity(directory), checkout, checkoutID: identity(checkout), planPath: plan },
    git: !!marker };
}

export function context(workspace, planPath, nonGitBaseline) {
  const { ctx, git } = physicalContext(workspace, planPath);
  if (!git) need(text(nonGitBaseline) && readFileSync(ctx.planPath, 'utf8').includes(nonGitBaseline),
    'Non-Git workspace requires an explicit baseline declaration in its plan');
  return ctx;
}

// GET-only observation does not declare a new implementation baseline.
export const observationContext = (workspace, planPath) => physicalContext(workspace, planPath).ctx;

export function validateState(state) {
  need(state?.schema === 1 && Array.isArray(state.bindings) && Array.isArray(state.plans), 'Invalid helper state');
  need(Object.keys(state).every(key => ['schema', 'bindings', 'plans'].includes(key)), 'Unexpected helper state fields');
  const chats = new Set();
  for (const binding of state.bindings) {
    need(binding && text(binding.codexChat) && !chats.has(binding.codexChat), 'Invalid/duplicate chat binding');
    chats.add(binding.codexChat);
    need(['workspace', 'checkout', 'planPath'].every(key => text(binding[key]) && isAbsolute(binding[key])), 'Invalid binding paths');
    need(['workspaceID', 'checkoutID', 'engineID'].every(key => text(binding[key])) && phases.includes(binding.phase), 'Invalid binding identity/phase');
    need(binding.sessionID === null || /^ses_[a-zA-Z0-9]+$/.test(binding.sessionID), 'Invalid saved session ID');
    need(Object.keys(binding).every(key => ['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath', 'engineID', 'sessionID', 'phase', 'uncertain', 'intent', 'assignmentID', 'messageID', 'submittedAt', 'pending', 'stopReason', 'nextAssignment', 'diagnostic', 'adoption'].includes(key)), 'Unexpected binding fields');
    if (binding.adoption !== undefined) {
      const value = binding.adoption;
      need(value && Object.keys(value).length === 3 &&
        (value.variant === null || text(value.variant) && value.variant.length <= 80) &&
        (value.lastMessageID === null && value.idleAt === null || text(value.lastMessageID) && value.lastMessageID.length <= 128 && Number.isSafeInteger(value.idleAt) && value.idleAt >= 0), 'Invalid adoption boundary');
    }
    if (binding.diagnostic !== undefined) { need(binding.phase === 'STOPPED', 'Diagnostic requires STOPPED'); validateDiagnostic(binding.diagnostic); }
    if (binding.nextAssignment !== undefined) need(['block', 'correction'].includes(binding.nextAssignment) && ['PREPARING', 'STOPPED'].includes(binding.phase), 'Invalid next assignment');
    if (binding.uncertain !== undefined) need(['create', 'submit', 'reply', 'model'].includes(binding.uncertain) && binding.phase === 'STOPPED', 'Invalid pending mutation');
    if (binding.intent !== undefined) {
      const intent = binding.intent;
      need(intent && (binding.uncertain === 'create' && Object.keys(intent).length === 1 && leaseTokenPattern.test(intent.nonce) ||
        binding.uncertain === 'submit' && Object.keys(intent).length === 1 && fingerprintPattern.test(intent.promptHash) ||
        binding.uncertain === 'reply' && (Object.keys(intent).length === 2 || Object.keys(intent).length === 3 && fingerprintPattern.test(intent.answerHash)) &&
          typeof intent.reject === 'boolean' && typeof intent.acknowledged === 'boolean' && binding.pending ||
        binding.uncertain === 'model' && Object.keys(intent).length === 4 && (intent.head === null || text(intent.head)) &&
          (intent.variant === null || text(intent.variant) && intent.variant.length <= 80) &&
          (intent.idleAt === null || Number.isSafeInteger(intent.idleAt)) && Number.isSafeInteger(intent.at)), 'Invalid mutation evidence');
    }
    if (binding.stopReason !== undefined) need(text(binding.stopReason) && binding.phase === 'STOPPED', 'Invalid stop reason');
    if (binding.pending !== undefined) need(['WAITING_FOR_ANSWER', 'STOPPED'].includes(binding.phase) && ['question', 'permission'].includes(binding.pending.kind) && /^(frm_|per)[a-zA-Z0-9_]+$/.test(binding.pending.id) && /^[a-f0-9]{64}$/.test(binding.pending.fingerprint) && Object.keys(binding.pending).length === 3, 'Invalid pending request');
    if (binding.phase === 'WAITING_FOR_ANSWER') need(binding.pending, 'Missing pending request');
    if (binding.assignmentID !== undefined) need(text(binding.assignmentID) && /^msg_[a-zA-Z0-9]+$/.test(binding.messageID) && Number.isFinite(binding.submittedAt), 'Invalid assignment record');
    if (binding.phase === 'EXECUTING') need(text(binding.assignmentID) && text(binding.sessionID), 'Executing assignment missing identity');
  }
  const plans = new Set();
  for (const plan of state.plans) {
    need(plan && isAbsolute(plan.workspace) && isAbsolute(plan.planPath) && !plans.has(plan.planPath), 'Invalid/duplicate plan counter');
    plans.add(plan.planPath);
    need(Object.keys(plan).every(key => ['workspace', 'planPath', 'correctionCount'].includes(key)), 'Unexpected plan state fields');
    need(Number.isSafeInteger(plan.correctionCount) && plan.correctionCount >= 0, 'Invalid correction count');
  }
  for (const binding of state.bindings) need(state.plans.some(plan => plan.workspace === binding.workspace && plan.planPath === binding.planPath), 'Missing bound plan counter');
  return state;
}

export function readState(path) {
  if (!existsSync(path)) return { schema: 1, bindings: [], plans: [] };
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { throw stateFailure(error, 'state-lock'); }
  try { return validateState(JSON.parse(raw)); }
  catch { throw new Error('Invalid helper state; stop without replacing it'); }
}

function ownershipError() {
  return diagnosticError('Helper ownership locked; inspect the previous writer, no automatic unlock',
    'state-locked', 'state-lock', { errorCode: 'EEXIST' });
}

function readOwnerships(root) {
  if (!existsSync(root)) return { owners: [], invalid: false };
  let names;
  try { names = readdirSync(root); }
  catch (error) { throw stateFailure(error, 'state-lock'); }
  const owners = [];
  let invalid = false;
  for (const name of names) {
    if (!/^owner-[0-9a-f-]{36}\.lock$/.test(name)) { invalid = true; continue; }
    let raw;
    try { raw = readFileSync(join(root, name), 'utf8'); }
    catch (error) { throw stateFailure(error, 'state-lock'); }
    let owner;
    try { owner = JSON.parse(raw); }
    catch { invalid = true; continue; }
    const token = name.slice(6, -5);
    const fields = ['schema', 'token', 'codexChat', 'workspace', 'checkout', 'sessionID', 'assignmentID', 'operation'];
    const modern = owner?.schema === 2 && validProcessOwner(owner.process) && fingerprintPattern.test(owner.fingerprint);
    const observation = modern && ['wait', 'resume-watch'].includes(owner.operation) && /^msg_[a-zA-Z0-9]+$/.test(owner.messageID);
    const operations = ['bind', 'adopt', 'submit', 'reply', 'next', 'finish', 'close', 'transition', 'reconcile', 'rebind-engine'];
    const operation = (modern && owner.operation === 'bind' || owner?.schema === 3 &&
      validProcessOwner(owner.process) && owner.process.start && fingerprintPattern.test(owner.fingerprint) &&
      text(owner.bindingChat) && operations.includes(owner.operation)) && isAbsolute(owner.planPath) &&
      text(owner.workspaceID) && text(owner.checkoutID) &&
      (owner.messageID === null || /^msg_[a-zA-Z0-9]+$/.test(owner.messageID)) &&
      (owner.nextFingerprint === undefined || fingerprintPattern.test(owner.nextFingerprint));
    const extra = observation ? ['process', 'messageID', 'fingerprint'] : operation ?
      ['process', 'messageID', 'fingerprint', 'nextFingerprint', 'planPath', 'workspaceID', 'checkoutID',
        ...(owner.schema === 3 ? ['bindingChat'] : [])] : [];
    if (!owner || !(owner.schema === 1 || observation || operation) || owner.token !== token || !text(owner.codexChat) ||
      !isAbsolute(owner.workspace) || !isAbsolute(owner.checkout) ||
      !(owner.sessionID === null || /^ses_[a-zA-Z0-9]+$/.test(owner.sessionID)) ||
      !(owner.assignmentID === null || text(owner.assignmentID)) ||
      ![...operations, 'wait', 'resume-watch'].includes(owner.operation) ||
      Object.keys(owner).some(key => ![...fields, ...extra].includes(key))) invalid = true;
    else owners.push({ ...owner, path: join(root, name) });
  }
  return { owners, invalid };
}

function saveState(path, state) {
  validateState(state);
  saveJSON(path, state);
}

function saveJSON(path, value, stagingRoot = dirname(path)) {
  const temporary = join(stagingRoot, basename(path) + '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

const closurePath = (root, messageID) => join(root, 'assignment-closures', messageID + '.json');
const postgresPath = (root, messageID) => join(root, 'postgres-recoveries', messageID + '.json');
const deliveryFingerprint = binding => createHash('sha256').update(JSON.stringify(
  ['workspaceID', 'checkoutID', 'sessionID', 'assignmentID', 'messageID', 'submittedAt'].map(key => binding[key]),
)).digest('hex');
const reviewPath = (root, messageID) => join(root, 'review-boundaries', messageID + '.json');
const acceptedPath = (root, messageID) => join(root, 'accepted-deliveries', messageID + '.json');
const promptPath = (root, messageID) => join(root, 'prompt-deliveries', messageID + '.json');

function recordPrompt(root, binding) {
  const path = promptPath(root, binding.messageID);
  const receipt = { owner: deliveryFingerprint(binding), hash: binding.intent.promptHash };
  if (existsSync(path)) {
    need(isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), receipt), 'Conflicting prompt checksum receipt');
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  saveJSON(path, receipt);
}
export function planIdentity(path) {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let checkpoint = false;
  const content = [];
  for (const line of lines) {
    if (line.startsWith('## ')) checkpoint = /^## (?:Review checkpoint(?: \(advisor-owned\))?|Контрольная точка[^\n]*)\s*$/i.test(line);
    if (checkpoint || !line.trim() || /^<!-- code-duet-accepted msg_[a-zA-Z0-9]+ -->$/.test(line.trim()) ||
      /^(?:Status:|\*\*Status:\*\*)\s+(?:TODO|ACTIVE|DONE|BLOCKED|STALE)\.?\s*$/i.test(line)) continue;
    content.push(line.trimEnd().replace(/^(\s*[-*+] )\[[ xX]\](?= )/, '$1[ ]'));
  }
  return createHash('sha256').update(content.join('\n')).digest('hex');
}

function loadAcceptance(root, messageID) {
  try { return JSON.parse(readFileSync(acceptedPath(root, messageID), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function readAcceptance(root, binding, value = loadAcceptance(root, binding.messageID)) {
  if (value === null) return null;
  need(value?.schema === 1 && value.owner === deliveryFingerprint(binding) && value.planPath === binding.planPath &&
    fingerprintPattern.test(value.planHash) && Number.isSafeInteger(value.correctionCount) && value.correctionCount >= 0,
  'Invalid or foreign acceptance receipt');
  return value;
}

function recordAcceptance(root, state, binding, planPath = binding.planPath) {
  const delivery = Object.fromEntries(['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID',
    'sessionID', 'assignmentID', 'messageID', 'submittedAt', 'planPath'].map(key => [key, binding[key]]));
  const value = { schema: 1, owner: deliveryFingerprint(binding), planPath: binding.planPath, planHash: planIdentity(planPath),
    correctionCount: state.plans.find(plan => plan.planPath === binding.planPath).correctionCount, delivery };
  const prior = readAcceptance(root, binding);
  if (prior) return need(prior.planHash === value.planHash, 'Accepted plan identity changed');
  const path = acceptedPath(root, binding.messageID);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  saveJSON(path, value);
}

export function acceptanceStatus(workspace, planPath, messageID, { indexPath, stateRoot = defaultStateRoot(), chatID = process.env.CODEX_THREAD_ID } = {}) {
  const ctx = observationContext(workspace, planPath), state = readState(join(stateRoot, 'state.json'));
  need(/^msg_[a-zA-Z0-9]+$/.test(messageID) && text(chatID), 'Use the exact delivery and its owning Codex chat');
  const current = state.bindings.find(binding => binding.messageID === messageID && binding.codexChat === chatID);
  const transition = readTransition(stateRoot, messageID);
  const saved = loadAcceptance(stateRoot, messageID), delivered = saved?.delivery;
  const historical = delivered?.codexChat === chatID && delivered.messageID === messageID ? delivered : null;
  const binding = transition?.source.codexChat === chatID ? transition.source : current ?? historical;
  need(binding && ['workspace', 'workspaceID', 'checkout', 'checkoutID'].every(key => binding[key] === ctx[key]),
    'No exact acceptance in this chat and workspace');
  const receipt = readAcceptance(stateRoot, binding, saved);
  need(receipt && (ctx.planPath === binding.planPath || !existsSync(binding.planPath)) &&
    planIdentity(ctx.planPath) === receipt.planHash, 'Plan does not match this acceptance receipt');
  const checkpointRecorded = readFileSync(ctx.planPath, 'utf8').split(/\r?\n/)
    .some(line => line.trim() === '<!-- code-duet-accepted ' + messageID + ' -->');
  let indexStatus;
  if (indexPath !== undefined) {
    need(isAbsolute(indexPath), 'Use an absolute plan index path');
    const index = realpathSync(indexPath);
    need(inside(ctx.workspace, index), 'Plan index is outside the workspace');
    const statuses = [];
    for (const line of readFileSync(index, 'utf8').split(/\r?\n/)) {
      const match = /^\s*\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|.*\|\s*(TODO|ACTIVE|DONE|BLOCKED|STALE)\s*\|\s*$/.exec(line);
      if (match && resolve(dirname(index), decodeURI(match[1])) === ctx.planPath) statuses.push(match[2]);
    }
    indexStatus = statuses.length === 1 ? statuses[0] : statuses.length ? 'ambiguous' : 'missing';
  }
  const advanced = !current && historical && state.bindings.some(next => next.codexChat === chatID &&
    next.workspaceID === binding.workspaceID && next.planPath === binding.planPath && next.sessionID === binding.sessionID &&
    next.submittedAt >= binding.submittedAt && next.messageID && next.messageID !== messageID);
  return { kind: 'acceptance-status', sessionID: binding.sessionID, assignmentID: binding.assignmentID, messageID,
    correctionCount: receipt.correctionCount, checkpointRecorded, indexStatus, currentPhase: current?.phase ?? null,
    runtimeRecorded: !!(current?.phase === 'FINISHED' || current?.nextAssignment === 'block' || transition?.disposition === 'accepted' || advanced),
    taskSent: false, stateChange: 'unchanged' };
}
function reviewReceipt(root, binding, exchange) {
  const canonical = JSON.stringify(exchange, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const receipt = { owner: deliveryFingerprint(binding), history: createHash('sha256').update(canonical).digest('hex') };
  let saved;
  try { saved = readFileSync(reviewPath(root, binding.messageID), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return receipt; throw error; }
  need(isDeepStrictEqual(JSON.parse(saved), receipt),
    'Delivered history changed since review; inspect the original result before continuing');
  return receipt;
}
function saveReviewReceipt(root, binding, receipt) {
  const path = reviewPath(root, binding.messageID);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  saveJSON(path, receipt);
}
function withPostgresRecovery(root, binding) {
  if (!/^msg_[a-zA-Z0-9]+$/.test(binding.messageID ?? '')) return binding;
  const path = postgresPath(root, binding.messageID);
  if (!existsSync(path)) return binding;
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  need(receipt?.owner === deliveryFingerprint(binding) && Array.isArray(receipt.timeline) &&
    validatePostgresRecovery(receipt.evidence).messageID === binding.messageID, 'Invalid or foreign PostgreSQL recovery receipt');
  return { ...binding, postgresRecovery: receipt.evidence, postgresTimeline: receipt.timeline };
}
const invocationPath = (root, messageID) => join(root, 'powershell-invocations', messageID + '.json');
function withShellEvidence(root, binding) {
  binding = withPostgresRecovery(root, binding);
  if (!/^msg_[a-zA-Z0-9]+$/.test(binding.messageID ?? '')) return binding;
  const path = invocationPath(root, binding.messageID);
  if (!existsSync(path)) return binding;
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  need(saved?.owner === deliveryFingerprint(binding) && Array.isArray(saved.calls), 'Invalid or foreign PowerShell invocation proof');
  return { ...binding, invocationProofs: saved.calls };
}
function saveInvocationProofs(root, binding, calls) {
  if (!calls.length) return;
  const path = invocationPath(root, binding.messageID);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  saveJSON(path, { owner: deliveryFingerprint(binding), calls });
}
const closureOwner = binding => createHash('sha256').update(JSON.stringify([
  ...['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath', 'engineID', 'sessionID']
    .map(key => binding[key]),
])).digest('hex');
function readClosure(root, binding, messageID = binding.messageID) {
  if (!messageID) return null;
  const path = closurePath(root, messageID);
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  need(receipt?.schema === 1 && receipt.owner === closureOwner(binding) && receipt.sessionID === binding.sessionID &&
    receipt.messageID === messageID && text(receipt.assignmentID) &&
    (binding.messageID !== messageID || receipt.assignmentID === binding.assignmentID) &&
    Number.isSafeInteger(receipt.correctionCount) && receipt.correctionCount >= 0 &&
    typeof receipt.boundary?.lastMessageID === 'string' && Number.isSafeInteger(receipt.boundary?.idleAt) &&
    (receipt.boundary.variant === null || text(receipt.boundary.variant) && receipt.boundary.variant.length <= 80) &&
    (receipt.stopReason === undefined || text(receipt.stopReason)), 'Invalid or foreign assignment closure');
  if (receipt.diagnostic !== undefined) validateDiagnostic(receipt.diagnostic);
  return receipt;
}

function sameBoundary(a, b) {
  return ['lastMessageID', 'idleAt', 'variant'].every(key => a[key] === b[key]);
}

// Old detached workers still read state.json while newer helpers prepare deliveries.
const preparationOwner = binding => fingerprint(['codexChat', 'workspaceID', 'checkoutID', 'planPath', 'engineID',
  'sessionID', 'assignmentID', 'messageID', 'submittedAt'].map(key => binding[key]));
const preparationPath = (root, owner) => join(root, 'preparations', owner + '.json');

function preparation(root, binding) {
  const owner = preparationOwner(binding);
  let raw;
  try { raw = readFileSync(preparationPath(root, owner), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const value = JSON.parse(raw), { reusedDelivery, modelSelection, modelBaseline } = value;
  need(value.schema === 1 && value.owner === owner, 'Invalid or foreign session preparation');
  if (reusedDelivery) {
    const boundary = reusedDelivery.boundary;
    need(!binding.assignmentID && /^msg_[a-zA-Z0-9]+$/.test(reusedDelivery.messageID) &&
      text(reusedDelivery.assignmentID) && Number.isFinite(reusedDelivery.submittedAt) &&
      isAbsolute(reusedDelivery.planPath) && reusedDelivery.planPath !== binding.planPath &&
      text(boundary?.lastMessageID) && Number.isSafeInteger(boundary.idleAt) && (boundary.variant === null || text(boundary.variant)),
    'Invalid reused delivery boundary');
  }
  if (modelSelection) need((modelSelection.head === null || text(modelSelection.head)) &&
    (modelSelection.variant === null || text(modelSelection.variant) && modelSelection.variant.length <= 80) &&
    (modelSelection.idleAt === null || Number.isSafeInteger(modelSelection.idleAt)) &&
    Number.isSafeInteger(modelSelection.intentAt) &&
    (modelSelection.event === null || fingerprintPattern.test(modelSelection.event)) &&
    (modelSelection.history === undefined || fingerprintPattern.test(modelSelection.history)), 'Invalid model selection proof');
  need(modelBaseline === undefined || fingerprintPattern.test(modelBaseline), 'Invalid model selection baseline');
  return { reusedDelivery, modelSelection, modelBaseline };
}

function preparedBinding(root, binding) {
  return binding?.phase === 'PREPARING' ? { ...binding, ...preparation(root, binding) } : binding;
}

function savePreparation(root, binding, proof) {
  const owner = preparationOwner(binding), path = preparationPath(root, owner);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  saveJSON(path, { schema: 1, owner, ...proof });
}

async function preparedMessages(client, binding, sessionID = binding?.sessionID) {
  if (binding?.assignmentID) return assignmentMessages(client, binding);
  if (binding?.modelSelection?.head !== null) return recentSessionMessages(client, sessionID);
  const page = await client.request(`/api/session/${sessionID}/message?limit=2&order=desc`);
  need(Array.isArray(page?.data) && page.data.length <= 1, 'Unexpected history after High selection');
  return page.data;
}

function preparedHistory(binding, messages, session) {
  const proof = binding?.modelSelection;
  if (!proof) return { messages, session };
  const original = proof.event === null ? messages : messages.slice(0, -1);
  need(session.model?.variant === EXECUTOR_MODEL.variant && (session.time?.idle ?? null) === proof.idleAt &&
    (original.at(-1)?.id ?? null) === proof.head &&
    (proof.history === undefined || fingerprint(original) === proof.history) &&
    (proof.event === null || messages.at(-1)?.type === 'model-switched' && fingerprint(messages.at(-1)) === proof.event),
  'History or model changed after confirmed High selection');
  const { variant, ...model } = session.model;
  return { messages: original, session: { ...session, model: proof.variant === null ? model : { ...model, variant: proof.variant } } };
}

function existingBoundary(root, binding, messages, session, shells) {
  if (binding?.reusedDelivery) {
    const { boundary, ...delivery } = binding.reusedDelivery;
    const source = { ...binding, ...delivery };
    need(messages[0]?.id === source.messageID && readAcceptance(root, source) &&
      existsSync(reviewPath(root, source.messageID)), 'Missing exact acceptance and review for the reused session');
    const delivered = deliveredBoundary(source, messages, session, true);
    need(sameBoundary(boundary, delivered.boundary), 'Reused session history changed after preparation');
    reviewReceipt(root, source, delivered.exchange);
    completion(inspectMessages(withShellEvidence(root, source), delivered.exchange), session, shells);
    return boundary;
  }
  if (messages.length) {
    need(session.outcome === 'succeeded', 'Existing history outcome is not confirmed successful');
    const previous = messages[0].id === binding?.messageID ? withShellEvidence(root, binding) :
      { workspace: binding?.workspace, messageID: messages[0].id };
    completion(inspectMessages(previous, messages, { adopting: true }), session, shells);
  } else need(session.outcome === undefined && session.time?.idle === undefined, 'Existing history/status mismatch');
  return { variant: session.model.variant ?? null, lastMessageID: messages.at(-1)?.id ?? null, idleAt: session.time?.idle ?? null };
}

const transitionPath = (root, messageID) => join(root, 'assignment-transitions', messageID + '.json');
function readTransition(root, messageID) {
  if (!/^msg_[a-zA-Z0-9]+$/.test(messageID ?? '')) return null;
  const path = transitionPath(root, messageID);
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  need(receipt?.schema === 1 && receipt.source?.messageID === messageID && text(receipt.chatID) && text(receipt.engineID) &&
    typeof receipt.planPath === 'string' && isAbsolute(receipt.planPath) &&
    ['initial', 'block', 'correction'].includes(receipt.kind) &&
    ['accepted', 'blocked', 'without-acceptance'].includes(receipt.disposition) &&
    typeof receipt.boundary?.lastMessageID === 'string' && Number.isSafeInteger(receipt.boundary.idleAt) &&
    (receipt.boundary.variant === null || text(receipt.boundary.variant) && receipt.boundary.variant.length <= 80),
  'Invalid assignment transition receipt');
  validateState({ schema: 1, bindings: [receipt.source], plans: [{ workspace: receipt.source.workspace,
    planPath: receipt.source.planPath, correctionCount: receipt.correctionCount }] });
  return receipt;
}

function preparedTransition(root, binding) {
  if (binding.phase !== 'PREPARING') return null;
  const receipt = readTransition(root, binding.messageID);
  return receipt && receipt.chatID === binding.codexChat && receipt.planPath === binding.planPath && receipt.engineID === binding.engineID &&
    ['workspace', 'workspaceID', 'checkout', 'checkoutID', 'sessionID', 'assignmentID', 'submittedAt']
      .every(key => receipt.source[key] === binding[key]) ? receipt : null;
}

const blocksCheckout = (root, binding) => binding.uncertain ||
  !['PREPARING', 'FINISHED'].includes(binding.phase) || !!preparedTransition(root, binding);

async function matchingSession(client, binding) {
  const response = await client.request('/api/session/' + binding.sessionID);
  const session = response?.data;
  need(session?.id === binding.sessionID && session.model?.providerID === MODEL.providerID && session.model?.id === MODEL.id, 'Wrong session/model');
  if (binding.adoption || binding.modelSelection) need(Object.keys(session.model).every(key => ['providerID', 'id', 'variant'].includes(key)) &&
    (session.model.variant ?? null) === (binding.modelSelection ? EXECUTOR_MODEL.variant : binding.adoption.variant),
  'Adopted session model options changed');
  need(typeof session.location?.directory === 'string' && realpathSync(session.location.directory) === binding.workspace &&
    realpathSync(binding.workspace) === binding.workspace && realpathSync(binding.checkout) === binding.checkout &&
    identity(binding.workspace) === binding.workspaceID && identity(binding.checkout) === binding.checkoutID, 'Session physical directory mismatch');
  return session;
}

async function checkoutActivity(client, checkout, response, selectedID) {
  let active = response?.data;
  resample: for (const allowResample of [true, false]) {
    need(active && typeof active === 'object' && !Array.isArray(active), 'Unknown engine execution status');
    let overlapping = false;
    for (const [id, status] of Object.entries(active)) {
      need(/^ses_[a-zA-Z0-9]+$/.test(id) && status?.type === 'running' && Object.keys(status).length === 1,
        'Unknown active execution status');
      if (id === selectedID) continue;
      need(checkout, 'Active session directory cannot be compared without a checkout');
      let other;
      try { other = await client.request('/api/session/' + id); }
      catch (error) {
        if (!allowResample || error?.diagnostic?.httpStatus !== 404) throw error;
        active = (await client.request('/api/session/active'))?.data;
        continue resample;
      }
      need(other?.data?.id === id && text(other.data.location?.directory), 'Unknown active session identity');
      overlapping ||= overlaps(checkout, realpathSync(other.data.location.directory));
    }
    return { selected: selectedID ? active[selectedID] : undefined, overlapping };
  }
}

export async function observationSnapshot(client, binding) {
  const [session, active, forms, permissions] = await Promise.all([
    matchingSession(client, binding), client.request('/api/session/active'),
    client.request(`/api/session/${binding.sessionID}/form`), client.request(`/api/session/${binding.sessionID}/permission`),
  ]);
  need(Array.isArray(forms?.data) && Array.isArray(permissions?.data), 'Unknown execution/interactive status');
  const activity = await checkoutActivity(client, binding.checkout, active, binding.sessionID);
  need(!activity.overlapping, 'Another executor in this checkout; no ownership transfer');
  return { session, active: activity.selected, forms: forms.data, permissions: permissions.data };
}

async function checkedClosureBoundary(client, stateRoot, binding, requireSuccess = false, verifyPriorPlan = false, invocationCheck) {
  const verified = [];
  invocationCheck = { verified, ...invocationCheck };
  const quiet = current => !current.active && !current.forms.length && !current.permissions.length;
  const current = await observationSnapshot(client, binding);
  if (invocationCheck?.lostCalls) {
    need(!current.active, 'Prior session is still active; no replacement');
    need(!current.forms.length, 'Prior session has pending forms; no replacement');
    need(!current.permissions.length, 'Prior session has pending permissions; no replacement');
  }
  need(quiet(current), 'Session is active or awaiting a reply; no closure or dispatch');
  need(sessionAvailable(current.session), unavailableForDispatch);
  need(!requireSuccess || current.session.outcome === 'succeeded', 'Acceptance requires confirmed successful execution');
  const messages = await assignmentMessages(client, binding);
  if (invocationCheck?.historyFingerprint) need(historyFingerprint(messages) === invocationCheck.historyFingerprint,
    'Prior delivery history differs from the legacy bind recovery receipt');
  if (verifyPriorPlan) need(messages[0].text.startsWith('Assignment ID: ' + binding.assignmentID + '\nCanonical plan: ' +
    JSON.stringify(binding.planPath) + '\n'), 'Prior plan was not confirmed in the current OpenCode history');
  const shells = await projectShells(client, binding);
  const withEvidence = withShellEvidence(stateRoot, binding);
  const review = requireSuccess && !invocationCheck?.lostCalls;
  const prepared = preparedHistory(binding, messages, current.session);
  const delivered = deliveredBoundary(binding, prepared.messages, prepared.session, review);
  if (review) {
    completion(inspectMessages(withEvidence, delivered.exchange), prepared.session, shells, invocationCheck);
  } else closureBoundary(withEvidence, prepared.messages, prepared.session, shells, invocationCheck, delivered);
  const receipt = reviewReceipt(stateRoot, binding, delivered.exchange);
  const confirmed = await observationSnapshot(client, binding);
  need(quiet(confirmed) && sessionAvailable(confirmed.session) && confirmed.session.outcome === current.session.outcome &&
    JSON.stringify(confirmed.session.time) === JSON.stringify(current.session.time) &&
    JSON.stringify(confirmed.session.model) === JSON.stringify(current.session.model), 'Session changed during closure verification');
  await confirmHistoryAndShells(client, binding, messages, shells);
  return { boundary: delivered.boundary, receipt, verified, history: fingerprint(messages) };
}

function checkTransitionSource(binding, ctx, stateRoot, movedPlanPath) {
  need(!binding.uncertain, 'Prior assignment mutation is uncertain; keep its owner');
  need(!binding.pending && binding.phase !== 'WAITING_FOR_ANSWER', 'Prior assignment is awaiting a reply; keep its owner');
  need(['EXECUTING', 'REVIEWING', 'STOPPED', 'FINISHED'].includes(binding.phase) && binding.sessionID &&
    binding.assignmentID && !binding.nextAssignment, 'No confirmed delivered assignment to transition');
  const source = observationContext(ctx.workspace, movedPlanPath ?? binding.planPath);
  if (movedPlanPath !== undefined) {
    const acceptance = readAcceptance(stateRoot, binding);
    need(binding.phase === 'FINISHED' && !existsSync(binding.planPath) && acceptance &&
      planIdentity(source.planPath) === acceptance.planHash, 'Moved plan does not match the exact FINISHED acceptance receipt');
  }
  need(['workspace', 'workspaceID', 'checkout', 'checkoutID'].every(key => source[key] === ctx[key] && source[key] === binding[key]) &&
    (movedPlanPath !== undefined || source.planPath === binding.planPath), 'Prior assignment workspace/plan identity changed');
}

// Explicit paged discovery, independent of binding and without a store/lock.
export async function listSessions(client, workspace, cursor) {
  need(isAbsolute(workspace), 'Use an absolute discovery workspace');
  const directory = realpathSync(workspace);
  need(statSync(directory).isDirectory(), 'Discovery workspace is not a directory');
  need(cursor === undefined || text(cursor) && cursor.length <= 2048, 'Invalid session cursor');
  const page = await client.request('/api/session?directory=' + encodeURIComponent(directory) + '&limit=50&order=desc' +
    (cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)));
  need(Array.isArray(page?.data) && page.data.length <= 50 && page.cursor && typeof page.cursor === 'object' && !Array.isArray(page.cursor) &&
    (page.cursor.next === undefined || page.cursor.next === null || text(page.cursor.next) && page.cursor.next.length <= 2048), 'Unknown session page');
  const ids = new Set();
  const sessions = page.data.map(session => {
    need(/^ses_[a-zA-Z0-9]+$/.test(session?.id) && !ids.has(session.id) && text(session.location?.directory) &&
      realpathSync(session.location.directory) === directory, 'Ambiguous session discovery identity/directory');
    ids.add(session.id);
    return { id: session.id, title: typeof session.title === 'string' ? session.title.slice(0, 200) : null,
      titleTruncated: typeof session.title === 'string' && session.title.length > 200,
      directory, model: { providerID: typeof session.model?.providerID === 'string' ? session.model.providerID.slice(0, 80) : null,
        id: typeof session.model?.id === 'string' ? session.model.id.slice(0, 80) : null,
        variant: typeof session.model?.variant === 'string' ? session.model.variant.slice(0, 80) : null } };
  });
  const nextCursor = page.data.length ? page.cursor.next ?? null : null;
  return { kind: 'session-candidates', workspace: directory, sessions, nextCursor,
    exhausted: nextCursor === null, snapshotOnly: true, recipientSelected: false };
}

// A snapshot never bootstraps, locks, repairs or advances the execution store.
export async function inspect(client, { stateRoot = resolve(homedir(), '.local/state/code-duet'),
  chatID = process.env.CODEX_THREAD_ID, workspace, connectionError } = {}) {
  const result = { kind: client ? 'connected' : 'stopped', version: client?.version ?? null, model: MODEL,
    connection: { verified: !!client, engineID: client?.engineID ?? null,
      attempts: client?.bootstrap?.attempts ?? connectionError?.bootstrap?.attempts ?? null },
    binding: { status: text(chatID) ? 'unbound' : 'unknown' }, workspace: null, session: null,
    live: { verified: false }, blockers: [], snapshotOnly: true,
    stateLocked: existsSync(join(stateRoot, 'state.lock')),
    ownershipLocked: false,
    ...(connectionError?.bootstrap ? { bootstrap: connectionError.bootstrap } : {}) };
  try {
    const state = readState(join(stateRoot, 'state.json'));
    const ownershipRoot = join(stateRoot, 'ownership');
    if (existsSync(ownershipRoot)) result.ownershipLocked = readdirSync(ownershipRoot).length > 0;
    if (workspace !== undefined) {
      need(isAbsolute(workspace), 'Use an absolute inspection workspace');
      result.workspace = { directory: realpathSync(workspace), checkout: null };
      need(statSync(result.workspace.directory).isDirectory(), 'Inspection workspace is not a directory');
    }
    const binding = text(chatID) ? state.bindings.find(item => item.codexChat === chatID) : undefined;
    if (binding) {
      const plan = state.plans.find(item => item.planPath === binding.planPath);
      result.binding = { status: 'bound', sessionID: binding.sessionID, planPath: binding.planPath,
        phase: binding.phase, correctionCount: plan.correctionCount,
        ...(binding.assignmentID ? { assignmentID: binding.assignmentID, messageID: binding.messageID } : {}),
        ...(binding.uncertain ? { uncertain: binding.uncertain } : {}),
        ...(binding.stopReason ? { stopReason: binding.stopReason } : {}),
        ...(binding.diagnostic ? { diagnostic: binding.diagnostic } : {}) };
      if (binding.phase === 'PREPARING' && binding.nextAssignment === 'correction') {
        const closed = readClosure(stateRoot, binding);
        if (closed) result.binding.closure = { status: 'closed-without-acceptance',
          stopReason: closed.stopReason, diagnostic: closed.diagnostic };
      }
      need(!result.workspace || result.workspace.directory === binding.workspace, 'Inspection workspace differs from saved binding');
      result.workspace = { directory: binding.workspace, checkout: binding.checkout };
      if (binding.phase !== 'PREPARING') result.blockers.push('Binding phase is ' + binding.phase);
      if (binding.uncertain) result.blockers.push('Prior mutation uncertain; no retry');
      if (plan.correctionCount >= 20) result.blockers.push('Twenty corrections exhausted; select Code Duet again to start a new cycle');
      if (state.bindings.some(other => other !== binding && overlaps(binding.checkout, other.checkout) &&
        blocksCheckout(stateRoot, other))) result.blockers.push('Another helper owns this checkout');
      if (client && binding.sessionID) {
        need(binding.engineID === client.engineID, 'Engine changed; saved session is unverified');
        need(realpathSync(binding.planPath) === binding.planPath && statSync(binding.planPath).isFile() &&
          inside(binding.workspace, binding.planPath), 'Saved plan identity changed');
        const [session, active, forms, permissions, shells] = await Promise.all([
          matchingSession(client, preparedBinding(stateRoot, binding)), client.request('/api/session/active'),
          client.request('/api/session/' + binding.sessionID + '/form'),
          client.request('/api/session/' + binding.sessionID + '/permission'),
          client.request('/api/shell?location[directory]=' + encodeURIComponent(binding.workspace)),
        ]);
        need(active?.data && typeof active.data === 'object' && !Array.isArray(active.data) &&
          Array.isArray(forms?.data) && Array.isArray(permissions?.data) && Array.isArray(shells?.data), 'Unknown live inspection status');
        for (const [id, status] of Object.entries(active.data)) {
          need(/^ses_[a-zA-Z0-9]+$/.test(id) && status?.type === 'running', 'Unknown active execution status');
          if (id === binding.sessionID) result.blockers.push('Bound session is running');
          else {
            const other = await client.request('/api/session/' + id);
            need(other?.data?.id === id && text(other.data.location?.directory), 'Unknown active session identity');
            if (overlaps(binding.checkout, realpathSync(other.data.location.directory))) result.blockers.push('Another executor in this checkout');
          }
        }
        need(shells.data.every(shell => ['running', 'exited', 'timeout', 'killed'].includes(shell.status) &&
          (shell.status === 'running' || Number.isFinite(shell.time?.completed))), 'Unknown project shell status');
        const runningShells = shells.data.filter(shell => shell.status === 'running').length;
        if (forms.data.length) result.blockers.push('Pending forms');
        if (permissions.data.length) result.blockers.push('Pending permissions');
        if (runningShells) result.blockers.push('Project shells are running');
        result.session = { id: session.id, title: typeof session.title === 'string' ? session.title.slice(0, 200) : null,
          directory: session.location.directory, model: { providerID: session.model.providerID, id: session.model.id,
            ...(typeof session.model.variant === 'string' ? { variant: session.model.variant.slice(0, 80) } : {}) } };
        result.live = { verified: true, observedAt: Date.now(), active: !!active.data[binding.sessionID],
          outcome: ['succeeded', 'failed', 'interrupted'].includes(session.outcome) ? session.outcome : 'unknown',
          forms: forms.data.length, permissions: permissions.data.length, runningShells,
          knownShells: shells.data.length, hiddenProcesses: 'not-observed' };
      } else result.blockers.push(client ? 'No confirmed session ID' : 'Live state unverified; engine unavailable');
    } else result.blockers.push(text(chatID) ? 'No binding; no recipient assigned' : 'Actual CODEX_THREAD_ID unavailable; binding unknown');
    if (!client) {
      result.error = connectionError?.message ?? 'Engine unavailable';
      result.diagnostic = diagnose(connectionError, 'unknown', 'connection');
      result.retried = !!connectionError?.bootstrap?.retried;
    }
    return result;
  } catch (error) {
    return { ...result, kind: 'stopped', error: error.message, diagnostic: diagnose(error, 'unknown', 'snapshot'), retried: false };
  }
}

// Preflight is a snapshot only: it never acquires a lock, repairs state or sends a task.
export async function preflight(client, { stateRoot = resolve(homedir(), '.local/state/code-duet'),
  chatID = process.env.CODEX_THREAD_ID, workspace, planPath, sessionID, correctionCount,
  nonGitBaseline, connectionError } = {}) {
  const checks = [], blockers = [], unknowns = [];
  const diagnosticOf = error => {
    try { return error?.diagnostic ? validateDiagnostic(error.diagnostic) : undefined; }
    catch { return undefined; }
  };
  const diagnosticReason = diagnostic => [
    diagnostic.category, diagnostic.httpStatus ? 'HTTP ' + diagnostic.httpStatus : '',
    diagnostic.errorCode ?? '',
    diagnostic.method && diagnostic.operation ? diagnostic.method + ' ' + diagnostic.operation : diagnostic.operation ?? '',
    diagnostic.page ? diagnostic.page + ' page' : '',
    diagnostic.category === 'engine-version' ? 'expected ' + diagnostic.expectedVersions.join(' or ') +
      ', observed ' + diagnostic.observedVersion + ' (' + diagnostic.versionSource + ')' : '',
  ].filter(Boolean).join(' ');
  const add = (name, status, reason, deferred = false, diagnostic) => {
    let checkedDiagnostic;
    try { if (diagnostic) checkedDiagnostic = validateDiagnostic(diagnostic); } catch {}
    checks.push({ name, status, reason, ...(deferred ? { deferred: true } : {}),
      ...(checkedDiagnostic ? { diagnostic: checkedDiagnostic } : {}) });
    if (status === 'blocked') blockers.push(reason);
    else if (status === 'unknown' && !deferred) unknowns.push(reason);
  };
  const capture = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
  const errorStatus = error => {
    const diagnostic = diagnosticOf(error);
    return !diagnostic ? 'blocked' : diagnostic.category === 'request-http' &&
      diagnostic.httpStatus >= 400 && diagnostic.httpStatus < 500 ? 'blocked' : 'unknown';
  };
  const errorReason = error => {
    const diagnostic = diagnosticOf(error);
    return diagnostic ? diagnosticReason(diagnostic) : error?.message ?? 'Check failed';
  };
  const connected = !!client;
  const attempts = client?.bootstrap?.attempts ?? connectionError?.bootstrap?.attempts ?? null;
  const connectionDiagnostic = connectionError ? diagnose(connectionError, 'unknown', 'connection') : undefined;
  add('connection', connected ? 'pass' : 'blocked',
    connected ? 'Connected to engine ' + client.engineID + '; ' + (attempts ?? 'unknown') + ' bootstrap attempt(s)' :
      'OpenCode connection unavailable' + (connectionDiagnostic ? ': ' + diagnosticReason(connectionDiagnostic) : ''),
    false, connectionDiagnostic);
  add('required-model', connected ? 'pass' : connectionError?.message === 'Required Go model unavailable; no fallback' ?
    'blocked' : 'unknown', connected ? 'Required model verified: ' + MODEL.providerID + '/' + MODEL.id :
      'Required model cannot be verified without a successful connection');

  let workspacePath, planRealPath, ctx, isGit;
  try {
    need(isAbsolute(workspace), 'Use an absolute workspace path');
    workspacePath = realpathSync(workspace);
    need(statSync(workspacePath).isDirectory(), 'Workspace is not a directory');
    add('workspace', 'pass', 'Physical workspace: ' + workspacePath);
  } catch (error) { add('workspace', 'blocked', error.message); }
  try {
    need(isAbsolute(planPath), 'Use an absolute plan path');
    planRealPath = realpathSync(planPath);
    need(statSync(planRealPath).isFile() && planRealPath.endsWith('.md'), 'Plan must be a Markdown file');
    if (!workspacePath) add('plan', 'unknown', 'Plan containment depends on a valid workspace');
    else {
      need(inside(workspacePath, planRealPath), 'Plan must be inside the physical workspace');
      add('plan', 'pass', 'Physical plan: ' + planRealPath);
    }
  } catch (error) { add('plan', 'blocked', error.message); }
  if (workspacePath && planRealPath && inside(workspacePath, planRealPath)) {
    try {
      ({ ctx, git: isGit } = physicalContext(workspacePath, planRealPath));
      add('git-checkout', 'pass', isGit ?
        'Verified checkout ' + ctx.checkout + (ctx.checkout === ctx.workspace ? '' : ' containing the selected workspace') :
        'No Git checkout; the plan must contain the explicit non-Git baseline');
      if (isGit) add('baseline', 'pass', 'Git checkout identity verified');
      else if (text(nonGitBaseline) && readFileSync(ctx.planPath, 'utf8').includes(nonGitBaseline)) {
        add('baseline', 'pass', 'Explicit non-Git baseline occurs in the selected plan');
      } else add('baseline', 'blocked', 'Non-Git workspace requires a matching --non-git-baseline declaration');
    } catch (error) {
      add('git-checkout', 'blocked', error.message);
      add('baseline', 'unknown', 'Baseline cannot be verified until checkout identity is available');
    }
  } else {
    add('git-checkout', 'unknown', 'Checkout depends on valid physical workspace and plan paths');
    add('baseline', 'unknown', 'Baseline depends on valid physical workspace and plan paths');
  }

  let state;
  const statePath = join(stateRoot, 'state.json');
  try {
    if (existsSync(stateRoot)) need(statSync(stateRoot).isDirectory(), 'Helper state path is not a directory');
    state = readState(statePath);
    add('helper-state', 'pass', existsSync(statePath) ? 'Saved helper state parsed without changes' : 'No saved helper state; none was created');
  } catch (error) {
    const diagnostic = diagnosticOf(error) ?? (error?.code ? diagnosticOf(stateFailure(error, 'state-lock')) : undefined);
    add('helper-state', 'blocked', diagnostic ?
      'Saved helper state is unavailable: ' + diagnosticReason(diagnostic) :
      'Saved helper state is invalid or unavailable; do not replace it automatically', false, diagnostic);
  }
  if (existsSync(join(stateRoot, 'state.lock'))) {
    add('state-transaction', 'blocked', 'A helper state transaction is present; run state-lock to inspect its owner');
  } else if (state) add('state-transaction', 'pass', 'No short helper state transaction is present');
  let taskArchive;
  try {
    const { ledger } = readTaskLedger(stateRoot);
    const entry = ledger.entries.find(item => item.planPath === ctx?.planPath);
    if (entry?.archivedAt != null || entry?.pendingRestore) {
      add('task-maintenance', 'blocked', 'This task has an archive or pending restore; run task-maintenance before dispatch');
    }
    if (entry?.bindings.length) taskArchive = { archivedAt: entry.archivedAt, correctionCount: entry.plan.correctionCount,
      deliveries: entry.bindings.map(binding => ({ sessionID: binding.sessionID, assignmentID: binding.assignmentID ?? null,
        messageID: binding.messageID ?? null, phase: binding.phase })),
      recovery: 'Select the exact old session in OpenCode for read-only review. If it is unavailable, use the accepted checkpoint and the authorized new-session route.' };
  } catch (error) {
    add('task-maintenance', 'unknown', 'Lifecycle journal unavailable; current state and OpenCode checks are independent',
      true, diagnosticOf(error));
  }

  const validCount = correctionCount === undefined ||
    Number.isInteger(correctionCount) && correctionCount >= 0 && correctionCount <= 20;
  const savedPlan = state && planRealPath ? state.plans.find(item => item.planPath === planRealPath) : undefined;
  let effectiveCount = savedPlan?.correctionCount ?? correctionCount ?? null;
  if (!validCount) add('correction-count', 'blocked', 'Correction count must be an integer from 0 through 20');
  else if (!state || !planRealPath) add('correction-count', 'unknown', 'Saved count depends on readable state and a physical plan path');
  else if (savedPlan && ctx && savedPlan.workspace !== ctx.workspace) {
    add('correction-count', 'blocked', 'Saved plan counter belongs to another physical workspace');
  } else if (savedPlan && correctionCount !== undefined && savedPlan.correctionCount !== correctionCount) {
    add('correction-count', 'blocked', 'Requested count ' + correctionCount + ' conflicts with saved count ' + savedPlan.correctionCount);
  } else if (savedPlan && savedPlan.correctionCount >= 20) add('correction-count', 'blocked', 'Correction limit reached; select Code Duet again to start a new cycle');
  else if (savedPlan) add('correction-count', 'pass', 'Saved correction count: ' + savedPlan.correctionCount);
  else if (correctionCount !== undefined) add('correction-count', 'pass', 'Explicit correction count: ' + correctionCount);
  else {
    effectiveCount = null;
    add('correction-count', 'unknown', 'No count is saved for this plan; start a cycle for a new explicit selection');
  }

  const hasChatID = text(chatID);
  const explicitSession = sessionID !== undefined;
  const sessionIDValid = typeof sessionID === 'string' && /^ses_[a-zA-Z0-9]+$/.test(sessionID);
  const savedBinding = state && hasChatID ? state.bindings.find(item => item.codexChat === chatID) : undefined;
  const explicitSavedPair = explicitSession && savedBinding?.sessionID === sessionID;
  const proposedRoute = explicitSavedPair ? 'reuse-saved-pair' : explicitSession ? 'adopt-existing' : savedBinding ? 'reuse-saved-pair' :
    state && hasChatID ? 'new-bind' : 'unknown';
  const selectedSessionID = explicitSession ? sessionID : savedBinding?.sessionID;
  let candidateBinding = savedBinding && savedBinding.sessionID === selectedSessionID ? savedBinding : undefined;
  try { candidateBinding = preparedBinding(stateRoot, candidateBinding); }
  catch (error) { add('session-preparation', 'blocked', error.message); }
  const sameSavedWorkspace = binding => !!ctx && binding.workspace === ctx.workspace &&
    binding.workspaceID === ctx.workspaceID && binding.checkout === ctx.checkout &&
    binding.checkoutID === ctx.checkoutID;
  let savedPlanSwitch = false;

  if (hasChatID) add('codex-chat', 'pass', 'Using the current CODEX_THREAD_ID');
  else add('codex-chat', 'unknown', 'Actual CODEX_THREAD_ID is unavailable; no chat binding can be selected');
  if (!state) add('recipient', 'unknown', 'Recipient route depends on readable helper state');
  else if (!hasChatID && !explicitSession) add('recipient', 'unknown', 'No current chat identity; saved-pair versus new-bind route is unknown');
  else if (explicitSession) {
    if (!sessionIDValid) add('recipient', 'blocked', 'Use one exact session ID in the form ses_<id>');
    else if (savedBinding && savedBinding.sessionID !== sessionID) {
      add('recipient', 'blocked', 'Explicit recipient conflicts with this chat’s saved pair; no takeover');
    } else if (!savedBinding && state.bindings.some(item => item.sessionID === sessionID)) {
      add('recipient', 'blocked', 'Session is already bound to another Codex chat; no takeover');
    } else if (explicitSavedPair) {
      if (!ctx) add('recipient', 'unknown', 'Saved-pair identity depends on a valid physical checkout');
      else {
        const sameWorkspace = sameSavedWorkspace(savedBinding);
        const samePlan = savedBinding.planPath === ctx.planPath;
        savedPlanSwitch = !samePlan && sameWorkspace && savedBinding.phase === 'FINISHED' && !savedBinding.uncertain;
        if (!sameWorkspace || !samePlan && !savedPlanSwitch) {
          add('recipient', 'blocked', 'Selected session belongs to a different physical workspace/plan or is not released for a plan switch; no takeover');
        } else add('recipient', 'pass', savedPlanSwitch ?
          'Explicit session matches a released saved pair; bind can switch to the selected plan' :
          'Explicit session matches this saved pair; reuse it without adoption');
      }
    } else add('recipient', 'pass', 'Explicit recipient selected; no additional confirmation is needed');
  } else if (!savedBinding) {
    add('recipient', 'pass', 'No saved pair; the proposed route creates a new session');
  } else if (!savedBinding.sessionID || savedBinding.uncertain) {
    add('recipient', 'blocked', 'Saved session creation/mutation is uncertain; inspect state and do not retry');
  } else if (!ctx) add('recipient', 'unknown', 'Saved-pair identity depends on a valid physical checkout');
  else {
    const sameWorkspace = sameSavedWorkspace(savedBinding);
    const samePlan = savedBinding.planPath === ctx.planPath;
    const planSwitch = !samePlan && savedBinding.phase === 'FINISHED' && !savedBinding.uncertain;
    savedPlanSwitch = planSwitch;
    if (!sameWorkspace || !samePlan && !planSwitch) {
      add('recipient', 'blocked', 'Saved pair belongs to a different workspace/plan or is not released for a plan switch');
    } else if (savedBinding.phase === 'STOPPED') {
      add('recipient', 'blocked', 'Saved binding is STOPPED; inspect the original diagnostic, never reset or resend');
    } else if (client && savedBinding.engineID !== client.engineID) {
      add('recipient', 'blocked', 'Saved binding belongs to a different engine; explicit continuation is required');
    } else if (!client) add('recipient', 'unknown', 'Saved binding engine identity cannot be checked while disconnected');
    else add('recipient', 'pass', planSwitch ? 'Released saved pair can switch to this plan' :
      'Saved pair phase: ' + savedBinding.phase);
  }
  if (explicitSession && savedBinding && savedBinding.sessionID === sessionID) {
    if (savedBinding.uncertain || !['PREPARING', 'FINISHED'].includes(savedBinding.phase)) {
      add('saved-phase', 'blocked', 'Saved binding phase is ' + savedBinding.phase + '; inspect or finish the existing operation first');
    } else add('saved-phase', 'pass', 'Saved binding phase: ' + savedBinding.phase);
    if (client && savedBinding.engineID !== client.engineID) add('saved-engine', 'blocked', 'Saved binding belongs to a different engine');
  } else if (savedBinding && !explicitSession) {
    if (['PREPARING', 'FINISHED'].includes(savedBinding.phase) && !savedBinding.uncertain) {
      add('saved-phase', 'pass', 'Saved binding phase: ' + savedBinding.phase);
    } else add('saved-phase', 'blocked', 'Saved binding phase is ' + savedBinding.phase + '; finish or inspect the existing operation first');
  }

  if (state && ctx) {
    const conflicts = state.bindings.filter(item => item !== savedBinding &&
      (overlaps(ctx.checkout, item.checkout) || ctx.checkoutID === item.checkoutID) &&
      blocksCheckout(stateRoot, item));
    add('saved-writers', conflicts.length ? 'blocked' : 'pass', conflicts.length ?
      'Another helper binding owns this checkout' : 'No active saved helper binding overlaps this checkout');
    if (selectedSessionID && state.bindings.some(item => item !== savedBinding && item.sessionID === selectedSessionID)) {
      add('session-ownership', 'blocked', 'Selected session is already recorded in another Codex binding');
    } else add('session-ownership', 'pass', selectedSessionID ?
      'Selected session is not recorded in another binding' : 'No existing session is being selected');
  } else add('saved-writers', 'unknown', 'Saved checkout ownership depends on readable state and checkout identity');

  const ownershipRoot = join(stateRoot, 'ownership');
  let legacyCandidates = [];
  if (ctx) {
    try {
      const { owners, invalid } = readOwnerships(ownershipRoot);
      const conflict = owners.some(owner => overlaps(ctx.checkout, owner.checkout));
      if (!invalid && state) legacyCandidates = owners.filter(owner => owner.schema === 1 &&
        ['wait', 'resume-watch', 'bind'].includes(owner.operation) && overlaps(ctx.checkout, owner.checkout)).flatMap(owner => {
        const binding = state.bindings.find(item => item.codexChat === owner.codexChat &&
          item.sessionID === owner.sessionID && item.assignmentID === owner.assignmentID &&
          item.workspace === owner.workspace && item.checkout === owner.checkout && !item.uncertain);
        if (owner.operation === 'bind') return binding?.phase === 'FINISHED' && binding.messageID && !binding.pending ?
          [{ token: owner.token, workspace: binding.workspace, planPath: binding.planPath, sessionID: binding.sessionID,
            assignmentID: binding.assignmentID, action: 'recover-legacy-bind',
            requires: 'Confirmed Windows restart after the legacy lease and idle prior delivery' }] : [];
        return binding ? [{ token: owner.token, workspace: binding.workspace, planPath: binding.planPath,
          sessionID: binding.sessionID, assignmentID: binding.assignmentID }] : [];
      });
      add('ownership', invalid || conflict ? 'blocked' : 'pass', invalid ?
        'Ownership state is invalid or unreadable; do not clean it up automatically' :
        conflict ? 'A helper operation owns this checkout; wait for that owner' : 'No retained ownership lease overlaps this checkout');
    } catch (error) {
      const diagnostic = diagnosticOf(error) ?? (error?.code ? diagnosticOf(stateFailure(error, 'state-lock')) : undefined);
      add('ownership', 'unknown', diagnostic ?
        'Ownership state cannot be read: ' + diagnosticReason(diagnostic) :
        'Ownership state cannot be read; no ownership decision is available', false, diagnostic);
    }
  } else add('ownership', 'unknown', 'Checkout ownership depends on a valid physical checkout');

  let selectedUnavailable = false;
  if (!client) {
    for (const name of ['session', 'session-model', 'session-directory', 'session-options', 'execution', 'forms', 'permissions', 'history', 'background']) {
      add(name, 'unknown', 'OpenCode is unavailable; this dependent check cannot be made',
        proposedRoute === 'new-bind' && ['session', 'session-model', 'session-directory', 'session-options', 'forms', 'permissions', 'history'].includes(name));
    }
  } else {
    const validSelectedID = typeof selectedSessionID === 'string' && /^ses_[a-zA-Z0-9]+$/.test(selectedSessionID);
    const probes = await Promise.all([
      capture(client.request('/api/session/active')),
      workspacePath ? capture(projectShells(client, { workspace: workspacePath, checkout: ctx?.checkout })) :
        Promise.resolve({ error: new Error('Workspace unavailable') }),
      validSelectedID ? capture(client.request('/api/session/' + selectedSessionID)) : Promise.resolve(null),
      validSelectedID ? capture(client.request('/api/session/' + selectedSessionID + '/form')) : Promise.resolve(null),
      validSelectedID ? capture(client.request('/api/session/' + selectedSessionID + '/permission')) : Promise.resolve(null),
      validSelectedID ? capture(preparedMessages(client, candidateBinding, selectedSessionID)) : Promise.resolve(null),
    ]);
    const [activeResult, shellsResult, sessionResult, formsResult, permissionsResult, historyResult] = probes;
    let liveSession;
    if (validSelectedID) {
      selectedUnavailable = sessionResult.error?.diagnostic?.httpStatus === 404 || archivedSession(sessionResult.value?.data);
      if (sessionResult.error) add('session', errorStatus(sessionResult.error), 'Exact session lookup failed: ' + errorReason(sessionResult.error),
        false, diagnosticOf(sessionResult.error));
      else if (sessionResult.value?.data?.id !== selectedSessionID) add('session', 'blocked', 'Exact session ID did not match the returned session');
      else { liveSession = sessionResult.value.data; add('session', 'pass', 'Exact session ID verified'); }
      if (liveSession) {
        const model = liveSession.model;
        add('session-model', model?.providerID === MODEL.providerID && model?.id === MODEL.id ? 'pass' : 'blocked',
          model?.providerID === MODEL.providerID && model?.id === MODEL.id ?
            'Candidate model: ' + MODEL.providerID + '/' + MODEL.id : 'Candidate uses an unsupported provider/model; no fallback');
        if (model && Object.keys(model).every(key => ['providerID', 'id', 'variant'].includes(key)) &&
          (model.variant === undefined || text(model.variant) && model.variant.length <= 80) &&
          (candidateBinding?.modelSelection ? model.variant === EXECUTOR_MODEL.variant :
            !candidateBinding?.adoption || (model.variant ?? null) === candidateBinding.adoption.variant)) {
          add('session-options', 'pass', 'Candidate model options are supported and match any saved adoption boundary');
        } else add('session-options', 'blocked', 'Candidate model options are unsupported or changed from the saved boundary');
        if (sessionAvailable(liveSession)) {
          add('session-availability', 'pass', 'Candidate session is not archived');
        } else add('session-availability', 'blocked', 'Candidate session is archived or its availability is unknown');
        if (liveSession.location?.directory && workspacePath) {
          try {
            const sameDirectory = realpathSync(liveSession.location.directory) === workspacePath;
            const sameIdentity = !ctx || realpathSync(ctx.workspace) === ctx.workspace &&
              realpathSync(ctx.checkout) === ctx.checkout && identity(ctx.workspace) === ctx.workspaceID &&
              identity(ctx.checkout) === ctx.checkoutID;
            add('session-directory', sameDirectory && sameIdentity ? 'pass' : 'blocked',
              sameDirectory && sameIdentity ? 'Candidate directory matches ' + workspacePath :
                'Candidate belongs to a different physical workspace');
          } catch (error) { add('session-directory', 'blocked', 'Candidate directory cannot be verified: ' + error.message); }
        } else add('session-directory', 'unknown', 'Candidate directory cannot be compared without a valid workspace');
      } else {
        for (const name of ['session-model', 'session-directory', 'session-options']) add(name, 'unknown', 'Depends on the exact session lookup');
      }
      const checkedList = (name, response, label) => {
        if (response.error) add(name, errorStatus(response.error), label + ' lookup failed: ' + errorReason(response.error),
          false, diagnosticOf(response.error));
        else if (!Array.isArray(response.value?.data)) add(name, 'unknown', label + ' response shape is unknown');
        else if (response.value.data.length) add(name, 'blocked', response.value.data.length + ' pending ' + label.toLowerCase());
        else add(name, 'pass', 'No pending ' + label.toLowerCase());
      };
      checkedList('forms', formsResult, 'Forms');
      checkedList('permissions', permissionsResult, 'Permissions');
      if (historyResult.error) add('history', errorStatus(historyResult.error), 'Candidate history could not be verified: ' + errorReason(historyResult.error),
        false, diagnosticOf(historyResult.error));
      else if (!liveSession) add('history', 'unknown', 'Candidate history depends on the exact session');
      else if (shellsResult.error || !shellListKnown(shellsResult.value)) {
        add('history', 'unknown', 'Candidate history completion depends on known project shell status', false,
          diagnosticOf(shellsResult.error));
      } else {
        const shells = shellsResult.value;
        try {
          need(Array.isArray(historyResult.value), 'Unknown candidate history');
          const { messages, session } = preparedHistory(candidateBinding, historyResult.value, liveSession);
          if (candidateBinding?.assignmentID) {
            const closed = preparedTransition(stateRoot, candidateBinding) ??
              (candidateBinding.phase === 'PREPARING' && candidateBinding.nextAssignment === 'correction' &&
                readClosure(stateRoot, candidateBinding));
            const boundHistory = withShellEvidence(stateRoot, candidateBinding);
            const completed = ['FINISHED', 'REVIEWING'].includes(candidateBinding.phase) ||
              candidateBinding.phase === 'PREPARING' && candidateBinding.nextAssignment;
            if (closed || completed) {
              const review = !closed || closed.disposition === 'accepted';
              const delivered = deliveredBoundary(candidateBinding, messages, session, review);
              if (review) completion(inspectMessages(boundHistory, delivered.exchange), session, shells);
              else closureBoundary(boundHistory, messages, session, shells, undefined, delivered);
              reviewReceipt(stateRoot, candidateBinding, delivered.exchange);
              if (closed) need(sameBoundary(closed.boundary, delivered.boundary), 'History changed since closure; no dispatch');
            } else {
              const history = inspectMessages(boundHistory, messages);
              need(!history.kind, 'Saved assignment history failed or was interrupted');
            }
            if (!closed && candidateBinding.phase === 'PREPARING' && candidateBinding.nextAssignment && candidateBinding.adoption) {
              need(sameBoundary(candidateBinding.adoption, { lastMessageID: messages.at(-1)?.id ?? null,
                idleAt: session.time?.idle ?? null, variant: session.model?.variant ?? null }), 'Saved history boundary changed');
            }
          } else if (candidateBinding?.adoption || candidateBinding?.reusedDelivery) {
            const boundary = existingBoundary(stateRoot, candidateBinding, messages, session, shells);
            if (candidateBinding.adoption) need(sameBoundary(candidateBinding.adoption, boundary), 'Saved adoption boundary changed');
          } else if (candidateBinding) {
            need(!messages.length && session.outcome === undefined && session.time?.idle === undefined,
              'Untracked history/status exists in the saved session');
          } else existingBoundary(stateRoot, ctx, messages, session, shells);
          add('history', 'pass', 'Latest candidate history and completion boundary are valid');
        } catch (error) { add('history', 'blocked', error.message, false, diagnosticOf(error)); }
      }
    } else {
      const deferredNames = ['session', 'session-model', 'session-directory', 'session-options', 'forms', 'permissions', 'history'];
      for (const name of deferredNames) add(name, 'unknown', proposedRoute === 'new-bind' ?
        'No recipient exists yet; bind/submit will check the created session' : 'No valid exact recipient is available',
        proposedRoute === 'new-bind');
    }

    if (activeResult.error) add('execution', errorStatus(activeResult.error), 'Execution status lookup failed: ' + errorReason(activeResult.error),
      false, diagnosticOf(activeResult.error));
    else {
      try {
        const activity = await checkoutActivity(client, ctx?.checkout, activeResult.value, selectedSessionID);
        add('execution', activity.selected || activity.overlapping ? 'blocked' : 'pass',
          activity.selected ? 'Selected session is running' : activity.overlapping ?
            'Another active OpenCode session is in this checkout' : 'No active OpenCode session in this checkout');
      } catch (error) {
        add('execution', 'unknown', 'One or more active session identities/statuses are unknown',
          false, diagnosticOf(error));
      }
    }

    if (shellsResult.error) add('background', errorStatus(shellsResult.error), 'Project shell lookup failed: ' + errorReason(shellsResult.error),
      false, diagnosticOf(shellsResult.error));
    else if (!shellListKnown(shellsResult.value)) {
      add('background', 'unknown', 'Project shell status is invalid or unknown');
    } else {
      const running = shellsResult.value.data.filter(shell => shell.status === 'running').length;
      add('background', running ? 'blocked' : 'pass', running ?
        running + ' project shell operation(s) are still running' : 'No running or unknown project shell operations');
    }
  }

  const status = blockers.length ? 'blocked' : unknowns.length ? 'unknown' : 'pass';
  const nonGitArgs = !isGit && text(nonGitBaseline) ? ['--non-git-baseline', nonGitBaseline] : [];
  const permanentRequest = checks.find(item => item.diagnostic?.category === 'request-http' &&
    item.diagnostic.httpStatus >= 400 && item.diagnostic.httpStatus < 500);
  let transition;
  if (client && state && ctx && hasChatID && !explicitSession && blockers.length) {
    const priorOwners = state.bindings.filter(item =>
      (overlaps(ctx.checkout, item.checkout) || ctx.checkoutID === item.checkoutID) && blocksCheckout(stateRoot, item));
    if (priorOwners.length === 1 && (!savedBinding || savedBinding === priorOwners[0])) {
      const prior = priorOwners[0];
      const evidence = { planPath: prior.planPath, phase: prior.phase, sessionID: prior.sessionID,
        assignmentID: prior.assignmentID ?? null, messageID: prior.messageID ?? null,
        correctionCount: state.plans.find(item => item.planPath === prior.planPath).correctionCount };
      try {
        checkTransitionSource(prior, ctx, stateRoot);
        need(checks.some(item => item.name === 'ownership' && item.status === 'pass'), 'Checkout lease is active or unknown');
        need(!readClosure(stateRoot, prior), 'Prior closure is staged; resolve it before a transition');
        const engineChanged = prior.engineID !== client.engineID;
        const mayAccept = ['REVIEWING', 'FINISHED'].includes(prior.phase);
        await checkedClosureBoundary(client, stateRoot, { ...prior, adoption: undefined }, mayAccept, engineChanged);
        transition = { ...evidence, status: 'ready', command: 'transition', args: [workspacePath, planRealPath, prior.messageID],
          engineChanged, options: nonGitArgs, dispositions: [...(mayAccept ? ['accepted'] : []),
            'blocked', 'without-acceptance'] };
      } catch (error) {
        transition = { ...evidence, status: 'blocked', reason: errorReason(error) };
      }
    }
  }
  const legacyBind = legacyCandidates.find(candidate => candidate.action === 'recover-legacy-bind');
  const replacementSuggested = !explicitSession && selectedUnavailable && savedBinding?.phase === 'FINISHED' &&
    savedBinding.messageID && !savedBinding.uncertain && sameSavedWorkspace(savedBinding) &&
    ['ownership', 'execution', 'background'].every(name => checks.some(item => item.name === name && item.status === 'pass'));
  let nextStep, nextCommand = null;
  if (!connected && connectionDiagnostic?.category === 'engine-version') nextStep =
    'OpenCode version mismatch: expected ' + connectionDiagnostic.expectedVersions.join(' or ') + ', observed ' +
    connectionDiagnostic.observedVersion + ' (' + connectionDiagnostic.versionSource +
    '). Use a validated matching engine/helper or revalidate API compatibility before rerunning preflight; no task was sent.';
  else if (!connected) nextStep = 'Restore the OpenCode connection and rerun preflight; this call sent no task.';
  else if (savedBinding?.uncertain && savedBinding.engineID === client.engineID && savedBinding.planPath === planRealPath &&
    (savedBinding.intent || savedBinding.uncertain === 'create' && savedBinding.sessionID)) {
    nextStep = 'Run reconcile to verify the exact prior mutation from OpenCode history and saved evidence; it sends no task.';
    nextCommand = { command: 'reconcile', args: [workspacePath, planRealPath, ...nonGitArgs] };
  }
  else if (legacyBind) {
    nextStep = 'Check the exact legacy bind lease. A confirmed later Windows restart and an idle prior delivery allow recovery from this chat.';
    nextCommand = { command: 'ownership', args: [legacyBind.workspace, legacyBind.planPath, legacyBind.token, '--action', 'inspect', ...nonGitArgs] };
  }
  else if (replacementSuggested) {
    nextStep = 'If the prior delivery has a saved acceptance receipt, replace its unavailable session with an empty project session, then rerun preflight.';
    nextCommand = { command: 'replace-finished-session', args: [workspacePath, planRealPath, savedBinding.messageID,
      '--session', savedBinding.sessionID, '--unavailable', ...nonGitArgs] };
  }
  else if (blockers.length && permanentRequest) {
    const diagnostic = permanentRequest.diagnostic;
    const operation = [diagnostic.method, diagnostic.operation].filter(Boolean).join(' ');
    const page = diagnostic.page ? ' (' + diagnostic.page + ' page)' : '';
    nextStep = 'OpenCode permanently rejected ' + (operation || 'the listed API request') + page +
      ' with HTTP ' + diagnostic.httpStatus + (diagnostic.errorCode ? ' (' + diagnostic.errorCode + ')' : '') +
      '. Do not retry the unchanged request. Check and correct this API request/cursor before rerunning preflight; no task was sent.';
  }
  else if (checks.some(check => check.name === 'task-maintenance' && check.status === 'blocked')) {
    nextStep = 'Restore the archived correction counter with task-maintenance, then rerun preflight. Archive delivery IDs are for explicit review.';
    nextCommand = { command: 'task-maintenance', args: [workspacePath, planRealPath] };
  }
  else if (transition?.status === 'ready') nextStep =
    'Resolve the prior review or record the owner’s explicit decision to leave it without acceptance. For authorized next work run transition with that disposition, then rerun preflight.';
  else if (checks.some(item => item.name === 'session-availability' && item.status === 'blocked')) nextStep =
    'If the session is archived, unarchive it in OpenCode and rerun preflight to check dispatch readiness.';
  else if (transition?.status === 'blocked') nextStep = transition.reason;
  else if (blockers.length) nextStep = 'Resolve the listed blockers and rerun preflight; this call sent no task.';
  else if (status === 'unknown') nextStep = !connected ? 'Restore the OpenCode connection and rerun preflight.' :
    !hasChatID ? 'Run from the real Codex chat with its actual CODEX_THREAD_ID, then rerun preflight.' :
      effectiveCount === null ? 'Start a cycle for the new explicit selection, then rerun preflight.' :
        'Resolve the unknown checks and rerun preflight before bind/adopt/submit.';
  else if (proposedRoute === 'adopt-existing') {
    nextStep = 'Run adopt for the explicitly selected session with the reported workspace, plan and count; no extra confirmation is needed.';
    nextCommand = { command: 'adopt', args: [workspacePath, planRealPath, sessionID,
      '--correction-count', String(effectiveCount), ...nonGitArgs] };
  }
  else if (proposedRoute === 'reuse-saved-pair' && savedBinding?.phase === 'FINISHED' && savedPlanSwitch) {
    nextStep = 'Run bind with the reported workspace, plan and count to switch this released pair to the selected plan; the existing session and old plan history are preserved.';
    nextCommand = { command: 'bind', args: [workspacePath, planRealPath,
      '--correction-count', String(effectiveCount), ...nonGitArgs] };
  }
  else if (proposedRoute === 'reuse-saved-pair' && savedBinding?.phase === 'FINISHED') nextStep =
    'Review the accepted checkpoint and choose the authorized next block/correction; a FINISHED pair is not reopened by bind.';
  else if (proposedRoute === 'reuse-saved-pair') {
    nextStep = 'Run bind with the reported workspace, plan and count to reuse the saved pair, then follow the authorized assignment route.';
    nextCommand = { command: 'bind', args: [workspacePath, planRealPath,
      '--correction-count', String(effectiveCount), ...nonGitArgs] };
  } else if (proposedRoute === 'new-bind') {
    nextStep = 'Run bind with the reported workspace, plan and count to create a new session; submit only after the plan authorizes it.';
    nextCommand = { command: 'bind', args: [workspacePath, planRealPath,
      '--correction-count', String(effectiveCount), ...nonGitArgs] };
  }
  else nextStep = 'Resolve the unknown recipient route and rerun preflight.';

  return {
    kind: 'preflight', status, connection: { verified: connected, engineID: client?.engineID ?? null,
      ...(client ? { version: client.version } : {}),
      attempts, retried: !!(client?.bootstrap?.retried ?? connectionError?.bootstrap?.retried),
      ...(connectionDiagnostic ? { diagnostic: connectionDiagnostic } : {}) },
    proposedRoute, workspace: { requested: workspace ?? null, directory: workspacePath ?? null, checkout: ctx?.checkout ?? null },
    plan: { requested: planPath ?? null, path: planRealPath ?? null },
    correctionCount: { requested: correctionCount ?? null, saved: savedPlan?.correctionCount ?? null,
      effective: effectiveCount, status: checks.find(item => item.name === 'correction-count')?.status ?? 'unknown' },
    recipient: { selected: !!selectedSessionID, sessionID: selectedSessionID ?? null,
      source: explicitSession ? 'explicit' : savedBinding ? 'saved-pair' : 'none' },
    checks, blockers: [...new Set(blockers)], unknowns: [...new Set(unknowns)], legacyCandidates,
    ...(transition ? { transition } : {}), ...(taskArchive ? { taskArchive } : {}),
    nextStep, nextCommand, taskSent: false, snapshotOnly: true, stateChange: 'unchanged',
    storeWriteAccess: 'unknown until an authorized write command; request normal host approval if the store is outside writable roots',
  };
}

function stateFailure(error, stage) {
  const conflict = stage === 'state-lock' && error?.code === 'EEXIST';
  const denied = ['EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED'].includes(error?.code);
  return diagnosticError(conflict ? 'Helper state locked; inspect previous writer, no automatic unlock' :
    denied ? 'Helper state access denied; request host-approved access to the existing store, no automatic retry or relocation' :
      'Helper state filesystem error; inspect diagnostic, no automatic retry',
    conflict ? 'state-locked' : denied ? 'state-access' : 'state-io', stage, {}, error);
}

const defaultStateRoot = () => resolve(homedir(), '.local/state/code-duet');
const reservedSessionTitle = binding => 'Code Duet: ' + basename(binding.workspace).slice(0, 100) + ' [' + binding.intent.nonce + ']';

export function stateLockStatus({ stateRoot = defaultStateRoot(), probeOwner, recoverToken } = {}) {
  const lockPath = join(stateRoot, 'state.lock'), statePath = join(stateRoot, 'state.json');
  const unchanged = { taskSent: false, stateChange: 'unchanged' };
  let raw, owner;
  try { raw = readFileSync(lockPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { kind: 'state-lock-status', ownerStatus: 'absent', ...unchanged };
    throw stateFailure(error, 'state-lock');
  }
  try { owner = JSON.parse(raw); } catch { /* Legacy lock, without process evidence. */ }
  const modern = owner?.schema === 1 && leaseTokenPattern.test(owner.token) &&
    validProcessOwner(owner.process) && owner.process.start;
  const proof = ownerLiveness(modern ? owner.process : undefined, probeOwner);
  const result = { kind: 'state-lock-status', token: modern ? owner.token : null,
    processID: modern ? owner.process.pid : null, ownerStatus: proof.status, reason: proof.reason,
    recoveryAllowed: proof.status === 'dead', ...unchanged };
  if (recoverToken === undefined) return result;
  if (!modern || recoverToken !== owner.token || proof.status !== 'dead') return { ...result, kind: 'rejected' };
  const stateBytes = () => {
    try { return readFileSync(statePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    const state = stateBytes();
    if (state !== null) validateState(JSON.parse(state.toString('utf8')));
    const archive = join(stateRoot, 'state-lock-history');
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    need(readFileSync(lockPath, 'utf8') === raw && isDeepStrictEqual(stateBytes(), state),
      'State or lock changed during recovery');
    // The exclusive receipt elects a single recoverer for this immutable token.
    writeFileSync(join(archive, owner.token + '.json'), JSON.stringify({ owner, proof,
      stateFingerprint: state === null ? null : createHash('sha256').update(state).digest('hex') }), { flag: 'wx', mode: 0o600 });
    need(readFileSync(lockPath, 'utf8') === raw && isDeepStrictEqual(stateBytes(), state),
      'State or lock changed during recovery');
    renameSync(lockPath, join(archive, owner.token + '.lock'));
  } catch (error) { if (error.code) throw stateFailure(error, 'state-lock'); throw error; }
  return { ...result, kind: 'state-lock-released', leaseArchived: true };
}

export function withStateLock(stateRoot, operation) {
    const statePath = join(stateRoot, 'state.json');
    try { mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); }
    catch (error) { throw stateFailure(error, 'state-directory'); }
    const lockPath = join(stateRoot, 'state.lock');
    let acquired = false, result, primary, releaseError, lastLockError, record;
    const token = randomUUID();
    const candidate = join(stateRoot, 'state-lock-' + token + '.tmp');
    let handle;
    try {
      // Check write access before querying the OS, then publish a complete record atomically.
      handle = openSync(candidate, 'wx', 0o600);
      const owner = processOwner();
      if (!owner.start) throw diagnosticError('Cannot verify the helper process creation time; no state lock was acquired',
        'process-identity', 'process-probe');
      record = JSON.stringify({ schema: 1, token, process: owner });
      writeFileSync(handle, record);
      closeSync(handle);
      handle = undefined;
      const lockDeadline = performance.now() + 120;
      for (let attempt = 0; attempt < 7; attempt++) {
        if (attempt > 0 && performance.now() >= lockDeadline) break;
        try { linkSync(candidate, lockPath); acquired = true; break; }
        catch (error) {
          lastLockError = error;
          if (error.code !== 'EEXIST' || attempt >= 6) break;
          Atomics.wait(stateLockWait, 0, 0, Math.max(0, Math.min(2 ** attempt, lockDeadline - performance.now())));
        }
      }
      if (!acquired) throw stateFailure(lastLockError, 'state-lock');
    } catch (error) { primary = error.diagnostic ? error : stateFailure(error, 'state-lock'); }
    finally {
      try { if (handle !== undefined) closeSync(handle); }
      catch (error) { releaseError = error; }
      try { if (existsSync(candidate)) unlinkSync(candidate); }
      catch (error) { releaseError ??= error; }
    }
    if (!acquired) {
      const error = primary ?? stateFailure(releaseError, 'state-lock');
      if (lastLockError?.code === 'EEXIST' && !releaseError) error.lockBusy = true;
      throw error;
    }
    try {
      if (releaseError) throw stateFailure(releaseError, 'state-lock');
      result = operation(readState(statePath));
      need(!result || typeof result.then !== 'function', 'State lock cannot cover asynchronous work');
    } catch (error) { primary = error; }
    let owned = false;
    try { owned = readFileSync(lockPath, 'utf8') === record; }
    catch (error) { releaseError = error; }
    if (owned) {
      try { unlinkSync(lockPath); }
      catch (error) { releaseError = error; }
    } else if (!owned && !releaseError) releaseError = Object.assign(new Error('State lock ownership changed'), { code: 'EEXIST' });
    if (primary) {
      if (releaseError) primary.persistenceFailure = diagnose(releaseError, 'state-io', 'state-lock');
      throw primary;
    }
    if (releaseError) throw stateFailure(releaseError, 'state-lock');
    return result;
}

function readTaskLedger(stateRoot) {
  const path = join(stateRoot, 'task-lifecycle.json');
  let raw = null;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw stateFailure(error, 'state-lock'); }
  const ledger = raw === null ? { schema: 1, entries: [] } : JSON.parse(raw);
  need(ledger?.schema === 1 && Array.isArray(ledger.entries) && Object.keys(ledger).length === 2,
    'Invalid task lifecycle journal');
  const seen = new Set();
  for (const entry of ledger.entries) {
    need(entry && isAbsolute(entry.workspace) && isAbsolute(entry.planPath) && !seen.has(entry.planPath) &&
      Number.isSafeInteger(entry.lastUsed) && entry.lastUsed >= 0 &&
      (entry.archivedAt === null || Number.isSafeInteger(entry.archivedAt) && entry.archivedAt >= 0) &&
      entry.plan?.workspace === entry.workspace && entry.plan?.planPath === entry.planPath &&
      Number.isSafeInteger(entry.plan.correctionCount) && entry.plan.correctionCount >= 0 &&
      Array.isArray(entry.bindings) && (entry.pendingRestore === undefined || typeof entry.pendingRestore === 'boolean') &&
      (entry.fingerprint === undefined || /^[a-f0-9]{64}$/.test(entry.fingerprint)) &&
      (entry.busy === undefined || typeof entry.busy === 'boolean') &&
      (!entry.pendingRestore || entry.archivedAt === null), 'Invalid task lifecycle entry');
    validateState({ schema: 1, bindings: entry.bindings, plans: [entry.plan] });
    seen.add(entry.planPath);
  }
  return { path, raw, ledger, seen };
}

// Compare the validated journal again under the state lock before moving records.
export function maintainTasks(workspace, planPath, { stateRoot = defaultStateRoot(), now = Date.now() } = {}) {
  need(Number.isSafeInteger(now) && now >= 0, 'Invalid maintenance time');
  const ctx = observationContext(workspace, planPath), statePath = join(stateRoot, 'state.json');
  const period = 30 * 24 * 60 * 60 * 1000;
  const { path: ledgerPath, raw, ledger, seen } = readTaskLedger(stateRoot);
  return withStateLock(stateRoot, state => {
    const currentRaw = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : null;
    need(currentRaw === raw, 'Lifecycle journal changed; rerun maintenance');
    const owners = readOwnerships(join(stateRoot, 'ownership'));
    need(!owners.invalid, 'Cannot maintain tasks while ownership is invalid');
    const inUse = plan => {
      if (observerPresent(stateRoot, plan.workspace)) return true;
      const bindings = state.bindings.filter(item => item.planPath === plan.planPath);
      if (bindings.some(item => item.phase !== 'FINISHED' || item.uncertain || item.nextAssignment)) return true;
      if (owners.owners.some(owner => overlaps(plan.workspace, owner.checkout))) return true;
      return false;
    };
    for (const plan of state.plans) if (!seen.has(plan.planPath)) {
      ledger.entries.push({ workspace: plan.workspace, planPath: plan.planPath, plan: structuredClone(plan),
        bindings: [], lastUsed: now, archivedAt: null });
      seen.add(plan.planPath);
    }
    let stateChanged = false, archived = 0, restored = 0, deleted = 0;
    const clearPending = [];
    for (const entry of ledger.entries) {
      const current = state.plans.find(plan => plan.planPath === entry.planPath);
      if (entry.archivedAt !== null && current) {
        const currentBindings = state.bindings.filter(item => item.planPath === entry.planPath);
        if (JSON.stringify(current) === JSON.stringify(entry.plan) &&
            JSON.stringify(currentBindings) === JSON.stringify(entry.bindings) && !inUse(current)) {
          state.plans = state.plans.filter(plan => plan.planPath !== entry.planPath);
          state.bindings = state.bindings.filter(item => item.planPath !== entry.planPath);
          stateChanged = true;
        } else {
          entry.archivedAt = null; entry.lastUsed = now; entry.plan = structuredClone(current); entry.bindings = [];
        }
      } else if (entry.archivedAt === null && !current) {
        need(entry.pendingRestore, 'Task state is missing without a pending restore');
        state.plans.push(structuredClone(entry.plan)); stateChanged = true; clearPending.push(entry);
      } else if (current && entry.pendingRestore) {
        need(JSON.stringify(current) === JSON.stringify(entry.plan), 'Restored task counter changed');
        clearPending.push(entry);
      }
    }
    for (const entry of ledger.entries) {
      const current = state.plans.find(plan => plan.planPath === entry.planPath);
      if (entry.archivedAt === null && current) {
        const fingerprint = createHash('sha256').update(JSON.stringify({ plan: current,
          bindings: state.bindings.filter(item => item.planPath === entry.planPath) })).digest('hex');
        const busy = inUse(current);
        if (entry.fingerprint && entry.fingerprint !== fingerprint || entry.busy && !busy) entry.lastUsed = Math.max(entry.lastUsed, now);
        entry.fingerprint = fingerprint;
        entry.busy = busy;
        entry.plan = structuredClone(current);
        if (entry.planPath === ctx.planPath) entry.lastUsed = Math.max(entry.lastUsed, now);
        if (now >= entry.lastUsed + period && !busy) {
          entry.archivedAt = entry.lastUsed + period; entry.bindings = structuredClone(state.bindings.filter(item => item.planPath === entry.planPath));
          state.plans = state.plans.filter(plan => plan.planPath !== entry.planPath);
          state.bindings = state.bindings.filter(item => item.planPath !== entry.planPath);
          stateChanged = true; archived++;
        }
      }
    }
    function saveLedger() {
      const temporary = ledgerPath + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, ledgerPath); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    saveLedger();
    if (stateChanged) saveState(statePath, state);
    for (const entry of clearPending) entry.pendingRestore = false;
    ledger.entries = ledger.entries.filter(entry => {
      if (entry.archivedAt !== null && now >= entry.archivedAt + period) { deleted++; return false; }
      return true;
    });
    const requested = ledger.entries.find(entry => entry.planPath === ctx.planPath && entry.archivedAt !== null);
    if (requested) {
      requested.archivedAt = null; requested.lastUsed = Math.max(requested.lastUsed, now); requested.pendingRestore = true;
      saveLedger(); // A pending restore remains recoverable if state.json cannot be saved.
      if (!state.plans.some(plan => plan.planPath === requested.planPath)) {
        state.plans.push(structuredClone(requested.plan)); saveState(statePath, state);
      }
      requested.pendingRestore = false;
      restored++;
    }
    saveLedger();
    return { kind: 'task-maintenance', archived, restored, deleted, taskSent: false };
  });
}

function observerPresent(stateRoot, checkout) {
  const observers = join(stateRoot, 'observers');
  return existsSync(observers) && readdirSync(observers, { withFileTypes: true }).some(entry => {
    const external = entry.name.startsWith('external-');
    const slot = join(observers, entry.name, ...(external ? [] : ['active']));
    if (!external && (!entry.isDirectory() || !existsSync(slot))) return false;
    try {
      const pointer = JSON.parse(readFileSync(slot, 'utf8'));
      if (!leaseTokenPattern.test(pointer.id)) return true;
      const directory = external ? createHash('sha256').update(pointer.codexChat).digest('hex') : entry.name;
      const receipt = readFileSync(join(observers, directory, pointer.id, 'receipt.json'), 'utf8');
      const value = JSON.parse(receipt);
      if (value.id !== pointer.id || createHash('sha256').update(value.codexChat).digest('hex') !== directory ||
        (pointer.receiptHash && pointer.receiptHash !== createHash('sha256').update(receipt).digest('hex')) ||
        !isAbsolute(value.checkout) || identity(value.checkout) !== value.checkoutID) return true;
      return overlaps(checkout, realpathSync(value.checkout));
    } catch { return true; }
  });
}

// Called only for a new explicit selection, never for an observer wake-up.
export function startCycle(workspace, planPath, { stateRoot = resolve(homedir(), '.local/state/code-duet'), chatID = process.env.CODEX_THREAD_ID } = {}) {
  need(text(chatID), 'Actual CODEX_THREAD_ID is required');
  const ctx = observationContext(workspace, planPath), statePath = join(stateRoot, 'state.json');
  return withStateLock(stateRoot, state => {
    const ledgerPath = join(stateRoot, 'task-lifecycle.json');
    if (existsSync(ledgerPath)) {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      need(ledger?.schema === 1 && Array.isArray(ledger.entries), 'Invalid task lifecycle journal');
      const entry = ledger.entries.find(item => item.planPath === ctx.planPath);
      need(!entry || entry.archivedAt === null && !entry.pendingRestore, 'Restore task through maintenance before starting a cycle');
    }
    const owners = readOwnerships(join(stateRoot, 'ownership'));
    need(!owners.invalid && !owners.owners.some(owner => overlaps(ctx.checkout, owner.checkout)), 'A task owner is active or unknown; no counter reset');
    need(!observerPresent(stateRoot, ctx.checkout), 'An observer is active or uncertain; no counter reset');
    for (const binding of state.bindings.filter(item => item.planPath === ctx.planPath)) {
      need(binding.workspace === ctx.workspace && ['PREPARING', 'REVIEWING', 'FINISHED'].includes(binding.phase) && !binding.uncertain && !binding.pending,
        'Assignment is active or uncertain; no counter reset');
      need(binding.codexChat === chatID || binding.phase === 'FINISHED', 'Another chat owns this task; no counter reset');
    }
    let plan = state.plans.find(item => item.planPath === ctx.planPath);
    if (!plan) {
      plan = { workspace: ctx.workspace, planPath: ctx.planPath, correctionCount: 0 };
      state.plans.push(plan); saveState(statePath, state);
      return { kind: 'cycle-started', correctionCount: 0, previousCount: null, taskSent: false };
    }
    need(plan.workspace === ctx.workspace, 'Plan belongs to another workspace');
    const previousCount = plan.correctionCount;
    if (previousCount) {
      const history = join(stateRoot, 'cycle-history');
      mkdirSync(history, { recursive: true, mode: 0o700 });
      writeFileSync(join(history, randomUUID() + '.json'), JSON.stringify({ schema: 1, workspace: plan.workspace,
        planPath: plan.planPath, codexChat: chatID, previousCount, at: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
      plan.correctionCount = 0; saveState(statePath, state);
    }
    return { kind: 'cycle-started', correctionCount: 0, previousCount, taskSent: false };
  });
}

export function helper(client, { stateRoot = resolve(homedir(), '.local/state/code-duet'), chatID = process.env.CODEX_THREAD_ID,
  probeOwner, probeBootTime = localWindowsBootTime } = {}) {
  need(text(chatID), 'Actual CODEX_THREAD_ID is required');
  const statePath = join(stateRoot, 'state.json');
  const locked = operation => withStateLock(stateRoot, operation);

  const ownershipRoot = join(stateRoot, 'ownership');
  const ownershipHistory = join(stateRoot, 'ownership-history');
  const stopRoot = join(stateRoot, 'observation-stop');
  const activeLease = new AsyncLocalStorage();
  function ownerships() {
    const result = readOwnerships(ownershipRoot);
    if (result.invalid) throw ownershipError();
    return result.owners;
  }
  function claimOwnership(state, ctx, binding, operation) {
    for (const owner of ownerships()) if (overlaps(ctx.checkout, owner.checkout)) throw ownershipError();
    try { mkdirSync(ownershipRoot, { recursive: true, mode: 0o700 }); }
    catch (error) { throw stateFailure(error, 'state-directory'); }
    const token = randomUUID(), path = join(ownershipRoot, 'owner-' + token + '.lock');
    const value = { schema: 1, token, codexChat: chatID, workspace: ctx.workspace, checkout: ctx.checkout,
      sessionID: binding?.sessionID ?? null, assignmentID: binding?.assignmentID ?? null, operation };
    if (['wait', 'resume-watch'].includes(operation)) Object.assign(value,
      { schema: 2, process: processOwner(), messageID: binding.messageID,
        fingerprint: observationFingerprint(binding, planCounter(state, binding).correctionCount) });
    else {
      Object.assign(value, { schema: 3, process: processOwner(), planPath: ctx.planPath,
        workspaceID: ctx.workspaceID, checkoutID: ctx.checkoutID, messageID: binding?.messageID ?? null,
        bindingChat: binding?.codexChat ?? chatID });
      value.fingerprint = leaseFingerprint(readState(statePath), value);
    }
    try { saveJSON(path, value, stateRoot); }
    catch (error) { throw stateFailure(error, 'state-lock'); }
    return { path, token };
  }
  function saveOwnedState(state) {
    const lease = activeLease.getStore();
    if (lease) {
      const { path, ...owner } = ownerships().find(item => item.token === lease.token) ?? {};
      need(path === lease.path && owner.codexChat === chatID, 'Operation ownership changed');
      if (owner.schema === 3) {
        const fingerprint = leaseFingerprint(readState(statePath), owner);
        need([owner.fingerprint, owner.nextFingerprint].includes(fingerprint), 'Saved binding changed during operation');
        // Record both sides before the state save, so either side of a crash has a valid pin.
        try { saveJSON(path, { ...owner, fingerprint, nextFingerprint: leaseFingerprint(state, owner) }, stateRoot); }
        catch (error) { throw stateFailure(error, 'state-write'); }
      }
    }
    saveState(statePath, state);
  }
  function archiveOwner(owner, audit) {
    try {
      mkdirSync(ownershipHistory, { recursive: true, mode: 0o700 });
      const path = join(ownershipHistory, owner.token + '.json'), archived = join(ownershipHistory, owner.token + '.lock');
      if (existsSync(path)) need(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(audit),
        'Recovery evidence changed');
      else writeFileSync(path, JSON.stringify(audit), { flag: 'wx', mode: 0o600 });
      need(!existsSync(archived), 'Lease archive already exists');
      renameSync(owner.path, archived);
    } catch (error) { if (error?.code) throw stateFailure(error, 'state-write'); throw error; }
  }
  function legacyBindProof(token, state, binding) {
    const receipt = JSON.parse(readFileSync(join(ownershipHistory, token + '.json'), 'utf8'));
    const archived = JSON.parse(readFileSync(join(ownershipHistory, token + '.lock'), 'utf8'));
    const { path, ...owner } = receipt.owner ?? {};
    need(receipt.schema === 1 && receipt.kind === 'legacy-bind-recovery' && owner.schema === 1 && owner.token === token &&
      owner.operation === 'bind' && ['codexChat', 'workspace', 'checkout', 'sessionID', 'assignmentID'].every(key => owner[key] === binding[key]) &&
      JSON.stringify(owner) === JSON.stringify(archived) && receipt.messageID === binding.messageID &&
      receipt.fingerprint === bindFingerprint(state, binding) && fingerprintPattern.test(receipt.historyFingerprint) &&
      receipt.proof?.status === 'dead' && receipt.proof?.reason === 'windows-restarted-after-lease',
    'Legacy bind recovery receipt does not match this FINISHED delivery');
    return receipt.historyFingerprint;
  }
  function releaseOwnership(lease) {
    locked(() => {
      let value;
      try { value = JSON.parse(readFileSync(lease.path, 'utf8')); }
      catch { throw ownershipError(); }
      need(value.token === lease.token && value.codexChat === chatID, 'Ownership lock changed; no automatic unlock');
      try { unlinkSync(lease.path); }
      catch (error) { throw stateFailure(error, 'state-lock'); }
    });
  }
  async function withOwnership(lease, operation) {
    let result, primary;
    try { result = await activeLease.run(lease, operation); }
    catch (error) { primary = error; }
    try { releaseOwnership(lease); }
    catch (error) {
      const diagnostic = error?.diagnostic ? validateDiagnostic(error.diagnostic) : diagnose(error, 'state-io', 'state-lock');
      if (primary) primary.ownershipReleaseFailure = diagnostic;
      else if (result && typeof result === 'object') {
        const primaryOutcome = ['rejected', 'stopped', 'connection-uncertain', 'failed', 'interrupted'].includes(result.kind) ||
          result.phase === 'STOPPED' || !!result.diagnostic;
        return primaryOutcome ? { ...result, ownershipReleaseFailure: diagnostic } :
          { ...result, kind: 'stopped', error: 'Ownership lock release unconfirmed; inspect previous writer',
            ownershipReleaseFailure: diagnostic, stateChange: result.stateChange ?? 'saved' };
      } else throw diagnosticError('Ownership lock release unconfirmed; inspect previous writer',
        'state-io', 'state-lock', {}, error);
    }
    if (primary) throw primary;
    return result;
  }

  function savedContext(binding, ctx, resumeObservation = false) {
    need(binding.codexChat === chatID, 'Wrong Codex chat');
    for (const key of ['workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath']) need(binding[key] === ctx[key], 'Saved workspace/plan identity changed');
    need(binding.engineID === client.engineID, 'Engine changed; explicit continuation required');
    need(binding.sessionID && !binding.uncertain && (binding.phase !== 'STOPPED' || resumeObservation), 'Binding stopped or mutation uncertain; do not retry');
  }
  const sessionMatches = binding => matchingSession(client, binding);
  async function idleWorkspace(state, ctx) {
    for (const binding of state.bindings) {
      if (overlaps(ctx.checkout, binding.checkout) || ctx.checkoutID === binding.checkoutID) need(['PREPARING', 'FINISHED'].includes(binding.phase) && !binding.uncertain, 'Prior helper assignment not reviewed/stopped; no new writer');
    }
    const activity = await checkoutActivity(client, ctx.checkout, await client.request('/api/session/active'));
    need(!activity.overlapping, 'Active executor in this physical checkout');
  }
  async function noForms(binding) {
    const forms = await client.request(`/api/session/${binding.sessionID}/form`);
    need(Array.isArray(forms?.data) && forms.data.length === 0, 'Pending/unknown session forms');
    const permissions = await client.request(`/api/session/${binding.sessionID}/permission`);
    need(Array.isArray(permissions?.data) && permissions.data.length === 0, 'Pending/unknown session permissions');
  }
  function summary(state, binding, kind) {
    const plan = state.plans.find(plan => plan.planPath === binding.planPath);
    return { kind, workspace: binding.workspace, planPath: binding.planPath, sessionID: binding.sessionID, phase: binding.phase, model: MODEL, correctionCount: plan.correctionCount, ...(binding.nextAssignment ? { nextAssignment: binding.nextAssignment } : {}), ...(binding.assignmentID ? { assignmentID: binding.assignmentID, messageID: binding.messageID } : {}), ...(binding.diagnostic ? { diagnostic: binding.diagnostic } : {}) };
  }
  function stop(state, binding, kind, reason, diagnostic) {
    binding.phase = 'STOPPED';
    binding.stopReason = reason;
    if (diagnostic) binding.diagnostic = validateDiagnostic(diagnostic);
    saveOwnedState(state);
    return { ...summary(state, binding, kind), error: reason, executorStopped: false, retried: false, stateChange: 'saved' };
  }
  const bindingFields = ['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath',
    'engineID', 'sessionID', 'assignmentID', 'messageID', 'submittedAt', 'phase', 'uncertain'];
  function unchanged(current, expected, state) {
    return !!current && bindingFields.every(key => current[key] === expected[key]) &&
      planCounter(state, current).correctionCount === expected.correctionCount &&
      JSON.stringify(current.pending ?? null) === JSON.stringify(expected.pending ?? null) &&
      isDeepStrictEqual(current.intent, expected.intent) &&
      JSON.stringify(current.adoption ?? null) === JSON.stringify(expected.adoption ?? null);
  }
  function checkoutAvailable(state, ctx, own) {
    for (const other of state.bindings) {
      if (other !== own && (overlaps(ctx.checkout, other.checkout) || ctx.checkoutID === other.checkoutID)) {
        need(!blocksCheckout(stateRoot, other),
          'Prior helper assignment not reviewed/stopped; no new writer');
      }
    }
  }
  function beginObserved(workspace, planPath, nonGitBaseline, allowedPhases, operation, precondition) {
    const ctx = context(workspace, planPath, nonGitBaseline);
    return locked(state => {
      const binding = state.bindings.find(binding => binding.codexChat === chatID);
      need(binding, 'No binding for this Codex chat');
      if (binding.phase === 'STOPPED' && operation !== 'resume-watch') return { outcome: { ...summary(state, binding, 'stopped'),
        error: binding.stopReason || 'Prior mutation uncertain; explicit continuation required',
        executorStopped: false, retried: false, stateChange: 'unchanged' } };
      savedContext(binding, ctx, operation === 'resume-watch');
      need(!readTransition(stateRoot, binding.messageID), 'Transition was staged; repeat the exact transition command');
      if (operation === 'resume-watch') need(!readClosure(stateRoot, binding), 'Closure was staged; repeat the exact close-assignment command');
      if (!binding.assignmentID || !allowedPhases.includes(binding.phase)) {
        const kind = operation === 'reply' && binding.assignmentID && binding.phase === 'EXECUTING' ? 'stale-request' : 'rejected';
        return { outcome: { ...summary(state, binding, kind),
          error: kind === 'stale-request' ? 'Request is no longer pending' : 'No observable assignment in the required phase',
          stateChange: 'unchanged', retried: false } };
      }
      const outcome = precondition?.(state, binding, ctx);
      if (outcome) return { outcome };
      checkoutAvailable(state, ctx, binding);
      const lease = claimOwnership(state, ctx, binding, operation);
      const plan = state.plans.find(plan => plan.planPath === binding.planPath);
      return { ctx, expected: { ...structuredClone(binding), correctionCount: plan.correctionCount }, lease };
    });
  }
  function commit(expected, operation, beforeSave) {
    return locked(state => {
      const binding = state.bindings.find(binding => binding.codexChat === chatID);
      need(unchanged(binding, expected, state), 'Saved assignment/count changed during observation; no stale state write');
      const result = operation(state, binding);
      beforeSave?.();
      saveOwnedState(state);
      return { expected: { ...structuredClone(binding), correctionCount: state.plans.find(plan => plan.planPath === binding.planPath).correctionCount },
        result: { ...result, stateChange: 'saved' } };
    });
  }
  function stoppedOutcome(expected, error, kind = 'stopped') {
    const diagnostic = error?.diagnostic ? validateDiagnostic(error.diagnostic) : diagnose(error, 'unknown', 'snapshot');
    if (diagnostic.category === 'history-correlation' && ['stopped', 'connection-uncertain'].includes(kind)) kind = 'history-uncertain';
    const reason = error?.diagnostic || !error?.code ? error?.message ?? 'Operation stopped; inspect before continuing' :
      'Workspace or state I/O failed; inspect before continuing';
    try {
      return locked(state => {
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        if (!unchanged(binding, expected, state)) return binding ?
          { ...summary(state, binding, 'stopped'), error: binding.stopReason || reason,
            diagnostic, executorStopped: false, retried: false, stateChange: 'unchanged' } :
          { kind: 'stopped', workspace: expected.workspace, planPath: expected.planPath, sessionID: expected.sessionID,
            phase: expected.phase, model: MODEL, correctionCount: expected.correctionCount, error: reason,
            diagnostic, executorStopped: false, retried: false, stateChange: 'unchanged' };
        const result = stop(state, binding, kind, reason, diagnostic);
        return { ...result, diagnostic, stateChange: 'saved' };
      });
    } catch (persistenceError) {
      const persistenceFailure = error?.persistenceFailure ?? (persistenceError?.diagnostic ?
        validateDiagnostic(persistenceError.diagnostic) : diagnose(persistenceError, 'state-io', 'state-write'));
      return { kind: 'stopped', workspace: expected.workspace, planPath: expected.planPath,
        sessionID: expected.sessionID, phase: expected.phase, model: MODEL, correctionCount: expected.correctionCount,
        error: reason, diagnostic, stateChange: 'unconfirmed', persistenceFailure, executorStopped: false, retried: false };
    }
  }
  function rejectedOutcome(expected, error) {
    return { kind: 'rejected', workspace: expected.workspace, planPath: expected.planPath,
      sessionID: expected.sessionID, phase: expected.phase, model: MODEL,
      correctionCount: expected.correctionCount, error: error.message,
      ...(expected.messageID ? { messageID: expected.messageID, assignmentID: expected.assignmentID } : {}),
      ...(error.diagnostic ? { diagnostic: validateDiagnostic(error.diagnostic) } : {}),
      stateChange: 'unchanged', retried: false };
  }
  function unconfirmedOutcome(expected, error, reason) {
    return { kind: 'stopped', workspace: expected.workspace, planPath: expected.planPath,
      sessionID: expected.sessionID ?? null, phase: 'STOPPED', model: MODEL,
      correctionCount: expected.correctionCount,
      ...(expected.nextAssignment ? { nextAssignment: expected.nextAssignment } : {}),
      ...(expected.assignmentID ? { assignmentID: expected.assignmentID, messageID: expected.messageID } : {}),
      error: reason, diagnostic: error?.diagnostic ? validateDiagnostic(error.diagnostic) : diagnose(error, 'state-io', 'state-write'),
      stateChange: 'unconfirmed', executorStopped: false, retried: false };
  }
  const snapshot = binding => observationSnapshot(client, binding);


  function planCounter(state, ctx, importedCount) {
    need(importedCount === undefined || Number.isInteger(importedCount) && importedCount >= 0 && importedCount <= 20, 'Invalid imported correction count');
    let plan = state.plans.find(plan => plan.planPath === ctx.planPath);
    if (!plan) {
      plan = { workspace: ctx.workspace, planPath: ctx.planPath, correctionCount: importedCount ?? 0 };
      state.plans.push(plan);
    }
    need(plan.workspace === ctx.workspace && (importedCount === undefined || plan.correctionCount === importedCount), 'Plan workspace/count conflicts with saved history');
    return plan;
  }
  async function reviewedResult(binding, invocationCheck) {
    const current = await snapshot(binding);
    need(!current.active && !current.forms.length && !current.permissions.length && current.session.outcome === 'succeeded' &&
      current.session.time?.idle >= binding.submittedAt, 'Executor has not ended this assignment');
    const messages = await assignmentMessages(client, binding);
    const prepared = preparedHistory(binding, messages, current.session);
    const { exchange, boundary } = deliveredBoundary(binding, prepared.messages, prepared.session, true);
    const history = inspectMessages(withShellEvidence(stateRoot, binding), exchange);
    need(!history.kind, 'Failed/interrupted assignment cannot be released');
    const shells = await projectShells(client, binding);
    completion(history, prepared.session, shells, invocationCheck);
    const receipt = reviewReceipt(stateRoot, binding, exchange);
    const confirmed = await snapshot(binding);
    need(!confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
      confirmed.session.outcome === current.session.outcome &&
      sessionAvailable(confirmed.session) === sessionAvailable(current.session) &&
      JSON.stringify(confirmed.session.model) === JSON.stringify(current.session.model) &&
      JSON.stringify(confirmed.session.time) === JSON.stringify(current.session.time), 'Execution changed during review transition');
    await confirmHistoryAndShells(client, binding, messages, shells);
    return { boundary, receipt, available: sessionAvailable(current.session), history: fingerprint(messages) };
  }
  async function idleExisting(state, binding) {
    await idleWorkspace(state, binding);
    const current = await snapshot(binding), session = current.session;
    need(!current.active && !current.forms.length && !current.permissions.length, 'Existing session busy or interactive');
    need(sessionAvailable(session), 'Archived/unknown existing session');
    need(Object.keys(session.model).every(key => ['providerID', 'id', 'variant'].includes(key)) &&
      (session.model.variant === undefined || text(session.model.variant) && session.model.variant.length <= 80), 'Unsupported existing model options');
    const messages = await preparedMessages(client, binding);
    const shells = await projectShells(client, binding);
    need(shellListKnown(shells) && shells.data.every(shell => shell.status !== 'running'), 'Project shell still running or unknown');
    const prepared = preparedHistory(binding, messages, session);
    const boundary = existingBoundary(stateRoot, binding, prepared.messages, prepared.session, shells);
    const lastMessageID = messages.at(-1)?.id ?? null;
    const head = await client.request(`/api/session/${binding.sessionID}/message?limit=1&order=desc`);
    need(Array.isArray(head?.data) && head.data.length === (lastMessageID === null ? 0 : 1) &&
      (head.data[0]?.id ?? null) === lastMessageID, 'Existing history changed during inspection');
    const confirmed = await snapshot(binding);
    need(!confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
      JSON.stringify(confirmed.session.time) === JSON.stringify(session.time) &&
      JSON.stringify(confirmed.session.model) === JSON.stringify(session.model), 'Existing session changed during inspection');
    await idleWorkspace(state, binding);
    return { boundary, history: fingerprint(messages) };
  }
  function settleMutation(state, binding, reconciled, sessionID) {
    const mutation = binding.uncertain, rejected = binding.intent?.reject;
    if (mutation === 'submit' && binding.intent?.promptHash) recordPrompt(stateRoot, binding);
    delete binding.uncertain; delete binding.intent; delete binding.stopReason; delete binding.diagnostic;
    if (mutation === 'create') {
      binding.sessionID = sessionID;
      binding.phase = 'PREPARING';
    } else {
      delete binding.nextAssignment; delete binding.pending;
      binding.phase = rejected ? 'STOPPED' : 'EXECUTING';
      if (rejected) binding.stopReason = 'Permission rejected; coordination stopped, executor termination unconfirmed';
    }
    const kind = reconciled ? 'mutation-reconciled' : rejected ? 'permission-rejected' : 'replied';
    return { ...summary(state, binding, kind), ...(reconciled ? { mutation, taskSent: false } : {}) };
  }
  async function verifyModelChange(binding, requireRecord) {
    const route = '/api/session/' + binding.sessionID;
    const current = await snapshot({ ...binding, adoption: binding.adoption ? { ...binding.adoption, variant: EXECUTOR_MODEL.variant } : undefined });
    need(sessionAvailable(current.session), unavailableForDispatch);
    const { head: priorID, variant, idleAt, at } = binding.intent;
    need(current.session.model.variant === EXECUTOR_MODEL.variant && !current.active && !current.forms.length &&
      !current.permissions.length && (current.session.time?.idle ?? null) === idleAt,
    'Session activity or model changed during High selection');
    const page = await client.request(route + '/message?limit=2&order=desc');
    need(Array.isArray(page?.data) && page.data.length <= 2, 'Unknown model selection history');
    const [head, prior] = page.data;
    const exact = (prior?.id ?? null) === priorID && head?.type === 'model-switched' && /^msg_[a-zA-Z0-9]+$/.test(head.id) &&
      head.model?.providerID === MODEL.providerID && head.model?.id === MODEL.id && head.model.variant === EXECUTOR_MODEL.variant &&
      head.previous?.providerID === MODEL.providerID && head.previous?.id === MODEL.id &&
      (head.previous.variant ?? null) === variant && Number.isSafeInteger(head.time?.created) && head.time.created >= at;
    const saved = preparation(stateRoot, binding), staged = saved.modelSelection;
    need(exact || (!requireRecord || staged?.event === null && staged.history !== undefined) && (head?.id ?? null) === priorID,
      'No unique matching High selection at the reserved history boundary');
    const history = saved.modelBaseline ?? staged?.history;
    const proof = { head: priorID, variant, idleAt, intentAt: at, event: exact ? fingerprint(head) : null,
      ...(history === undefined ? {} : { history }) };
    need(!staged || isDeepStrictEqual(staged, proof), 'Confirmed High selection evidence changed');
    if (history !== undefined) {
      const prepared = { ...binding, modelSelection: proof };
      const messages = await preparedMessages(client, prepared);
      preparedHistory(prepared, messages, current.session);
    }
    return { session: current.session, proof };
  }
  return {
    statePath,
    async reconcile(workspace, planPath, nonGitBaseline) {
      const ctx = context(workspace, planPath, nonGitBaseline);
      const start = locked(state => {
        const binding = state.bindings.find(item => item.codexChat === chatID);
        need(binding?.phase === 'STOPPED' && binding.uncertain, 'No uncertain mutation in this chat');
        need(['workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath'].every(key => binding[key] === ctx[key]) &&
          binding.engineID === client.engineID, 'Mutation belongs to a different workspace, plan or engine');
        checkoutAvailable(state, ctx, binding);
        return { expected: { ...structuredClone(binding), correctionCount: planCounter(state, binding).correctionCount },
          lease: claimOwnership(state, ctx, binding, 'reconcile') };
      });
      const { expected } = start;
      return withOwnership(start.lease, async () => {
        try {
          let sessionID = expected.sessionID;
          if (expected.uncertain === 'create') {
            need(sessionID || expected.intent, 'No exact create reservation evidence in this legacy binding');
            if (!sessionID) {
              const ids = new Set(), cursors = new Set(), matches = [];
              let cursor;
              do {
                need(cursors.size < 20 && !cursors.has(cursor), 'Incomplete creation lookup; reservation remains uncertain');
                cursors.add(cursor);
                const page = await listSessions(client, ctx.workspace, cursor);
                for (const item of page.sessions) {
                  need(!ids.has(item.id), 'Session list changed during creation lookup');
                  ids.add(item.id);
                  if (item.title === reservedSessionTitle(expected)) matches.push(item.id);
                }
                cursor = page.nextCursor ?? undefined;
              } while (cursor);
              need(matches.length === 1, 'No unique session matches the create reservation');
              [sessionID] = matches;
            }
            const candidate = { ...expected, sessionID };
            const current = await snapshot(candidate);
            need(!expected.intent || current.session.title === reservedSessionTitle(expected), 'Session title differs from the create reservation');
            const head = await client.request(`/api/session/${sessionID}/message?limit=1&order=desc`);
            need(sessionAvailable(current.session) && !current.active && !current.forms.length && !current.permissions.length &&
              current.session.model.variant === EXECUTOR_MODEL.variant && current.session.outcome === undefined &&
              Array.isArray(head?.data) && head.data.length === 0, 'Reserved session is not empty, available and idle at High');
            await requireQuietShells(client, ctx);
          } else if (expected.uncertain === 'submit') {
            need(expected.intent?.promptHash, 'No exact prompt hash in this legacy reservation');
            await sessionMatches(expected);
            const messages = await assignmentMessages(client, expected);
            need(createHash('sha256').update(messages[0].text).digest('hex') === expected.intent.promptHash &&
              messages.slice(1).every(message => message.type !== 'user'), 'Reserved prompt or delivery boundary changed');
          } else if (expected.uncertain === 'model') {
            const { proof } = await verifyModelChange(expected, true);
            await requireQuietShells(client, ctx);
            return commit(expected, (state, binding) => {
              savePreparation(stateRoot, binding, { reusedDelivery: preparation(stateRoot, binding).reusedDelivery, modelSelection: proof });
              delete binding.uncertain; delete binding.intent; delete binding.stopReason; delete binding.diagnostic;
              binding.phase = 'PREPARING';
              return { ...summary(state, binding, 'mutation-reconciled'), mutation: 'model', taskSent: false };
            }).result;
          } else {
            const current = await snapshot(expected), pending = expected.pending;
            need(pending, 'No exact pending request is saved');
            need(![...current.forms, ...current.permissions].some(item => item.id === pending.id), 'Acknowledged request still appears pending');
            if (!expected.intent?.acknowledged) {
              need(pending.kind === 'question' && expected.intent?.answerHash, 'Request disappeared without an exact reply acknowledgement');
              const response = await client.request(`/api/session/${expected.sessionID}/form/${pending.id}`);
              const { state, ...question } = response?.data ?? {};
              need(question.id === pending.id && question.sessionID === expected.sessionID && fingerprint(question) === pending.fingerprint &&
                state?.status === 'answered' && state.answer && fingerprint({ answer: state.answer }) === expected.intent.answerHash,
              'Saved answer is not confirmed for the exact request');
            }
          }
          return commit(expected, (state, binding) => {
            need(!state.bindings.some(item => item !== binding && item.sessionID === sessionID), 'Reserved session already belongs to another chat');
            return settleMutation(state, binding, true, sessionID);
          }).result;
        } catch (error) { return { ...rejectedOutcome(expected, error), mutation: expected.uncertain, taskSent: false }; }
      });
    },
    async rebindEngine(workspace, planPath, messageID, sessionID, nonGitBaseline) {
      const ctx = context(workspace, planPath, nonGitBaseline);
      const start = locked(state => {
        const binding = state.bindings.find(item => item.codexChat === chatID);
        need(binding?.messageID === messageID && binding.sessionID === sessionID && !binding.uncertain &&
          ['EXECUTING', 'REVIEWING', 'FINISHED'].includes(binding.phase) && !binding.pending && !binding.nextAssignment &&
          !readTransition(stateRoot, messageID) && !readClosure(stateRoot, binding), 'No exact delivered assignment to rebind');
        savedContext({ ...binding, engineID: client.engineID }, ctx);
        checkoutAvailable(state, ctx, binding);
        need(!observerPresent(stateRoot, ctx.checkout), 'An observer is active or uncertain; no engine rebind');
        return { expected: { ...structuredClone(binding), correctionCount: planCounter(state, binding).correctionCount },
          lease: claimOwnership(state, ctx, binding, 'rebind-engine') };
      });
      const { expected } = start;
      return withOwnership(start.lease, async () => {
        const current = await snapshot(expected), messages = await assignmentMessages(client, expected);
        need(messages[0].text.startsWith('Assignment ID: ' + expected.assignmentID + '\nCanonical plan: ' +
          JSON.stringify(expected.planPath) + '\n'), 'Delivery does not confirm the exact original plan');
        const path = promptPath(stateRoot, expected.messageID);
        if (existsSync(path)) {
          const prompt = JSON.parse(readFileSync(path, 'utf8'));
          need(prompt?.owner === deliveryFingerprint(expected) && createHash('sha256').update(messages[0].text).digest('hex') === prompt.hash,
            'Assignment prompt checksum changed');
        } else need(expected.phase !== 'EXECUTING', 'Exact prompt checksum unavailable for this running legacy delivery');
        if (expected.phase === 'EXECUTING') {
          need(sessionAvailable(current.session) && !current.forms.length && !current.permissions.length,
            'Session is unavailable or has pending interaction');
          need(!inspectMessages(withShellEvidence(stateRoot, expected), messages).kind, 'Delivery has failed or is interrupted');
          const head = await client.request(`/api/session/${sessionID}/message?limit=1&order=desc`);
          need(isDeepStrictEqual(head?.data?.[0], messages.at(-1)), 'Delivery head changed while rebinding');
        } else {
          await reviewedResult(expected);
        }
        return commit(expected, (state, binding) => {
          need(!state.bindings.some(item => item !== binding && item.engineID === client.engineID && item.sessionID === sessionID),
            'Session already belongs to another chat');
          need(!observerPresent(stateRoot, ctx.checkout), 'An observer is active or uncertain; no engine rebind');
          binding.engineID = client.engineID;
          return { ...summary(state, binding, 'engine-rebound'), previousEngineID: expected.engineID, taskSent: false };
        }).result;
      });
    },
    async retireLegacy(workspace, planPath, token) {
      need(client, 'OpenCode connection is required to check project activity');
      need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token), 'Invalid legacy lease token');
      const ctx = observationContext(workspace, planPath);
      const history = join(stateRoot, 'ownership-history');
      const archive = join(history, token + '.retired.json');
      const archivedLease = join(history, token + '.retired.lock');
      const select = state => {
        const owner = ownerships().find(item => item.token === token);
        need(owner && owner.schema === 1 && ['wait', 'resume-watch'].includes(owner.operation),
          'Only an exact legacy observation lease can be retired');
        const liveBinding = state.bindings.find(item => item.codexChat === owner.codexChat);
        const previous = !liveBinding && existsSync(archive) ? JSON.parse(readFileSync(archive, 'utf8')) : null;
        const binding = liveBinding ?? previous?.binding;
        need(binding && binding.workspace === ctx.workspace && binding.workspaceID === ctx.workspaceID &&
          binding.checkout === ctx.checkout && binding.checkoutID === ctx.checkoutID && binding.planPath === ctx.planPath &&
          owner.workspace === binding.workspace && owner.checkout === binding.checkout &&
          owner.sessionID === binding.sessionID && owner.assignmentID === binding.assignmentID &&
          binding.assignmentID && binding.messageID && !binding.uncertain,
        'Legacy lease and delivered assignment do not match');
        need(ownerships().filter(item => overlaps(ctx.checkout, item.checkout)).length === 1,
          'Another operation owns this checkout');
        const counter = state.plans.find(item => item.planPath === binding.planPath)?.correctionCount;
        need(Number.isInteger(counter) && (!previous || previous.schema === 1 &&
          previous.kind === 'abandoned-legacy-observation' && previous.correctionCount === counter &&
          JSON.stringify(previous.owner) === JSON.stringify(owner)), 'Retirement journal does not match');
        return { owner, binding, counter };
      };
      const selected = locked(state => structuredClone(select(state)));
      async function verifyIdle() {
        const active = await client.request('/api/session/active');
        need(active?.data && typeof active.data === 'object' && !Array.isArray(active.data), 'Unknown execution status');
        for (const id of Object.keys(active.data)) {
          need(/^ses_[a-zA-Z0-9]+$/.test(id), 'Unknown active session identity');
          const current = await client.request('/api/session/' + id);
          need(text(current?.data?.location?.directory) &&
            !overlaps(ctx.checkout, realpathSync(current.data.location.directory)), 'Active executor in this checkout');
        }
        const shells = await client.request('/api/shell?location[directory]=' + encodeURIComponent(ctx.workspace));
        need(Array.isArray(shells?.data) && shells.data.every(shell =>
          ['exited', 'timeout', 'killed'].includes(shell.status) && Number.isFinite(shell.time?.completed)),
        'Project shell is running or unknown');
      }
      await verifyIdle();
      await verifyIdle();
      return locked(state => {
        const current = select(state);
        need(JSON.stringify(current) === JSON.stringify(selected), 'Legacy ownership changed; no retirement');
        mkdirSync(history, { recursive: true, mode: 0o700 });
        const saved = { schema: 1, kind: 'abandoned-legacy-observation', owner: selected.owner,
          binding: selected.binding, correctionCount: selected.counter };
        if (existsSync(archive)) need(JSON.stringify(JSON.parse(readFileSync(archive, 'utf8'))) === JSON.stringify(saved),
          'Retirement archive differs');
        else writeFileSync(archive, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
        state.bindings = state.bindings.filter(item => item.codexChat !== selected.binding.codexChat);
        saveState(statePath, state);
        need(!existsSync(archivedLease), 'Retired lease already exists');
        renameSync(selected.owner.path, archivedLease);
        return { kind: 'legacy-retired', sessionID: selected.binding.sessionID,
          assignmentID: selected.binding.assignmentID, correctionCount: selected.counter,
          taskAccepted: false, taskSent: false, archived: true };
      });
    },
    async observationOwner(workspace, planPath, token, { action = 'inspect', nonGitBaseline } = {}) {
      need(leaseTokenPattern.test(token) &&
        ['inspect', 'stop', 'recover', 'recover-legacy-bind'].includes(action), 'Invalid ownership action or token');
      const ctx = context(workspace, planPath, nonGitBaseline);
      const selectedOwner = ownerships().find(value => value.token === token);
      if (selectedOwner?.operation === 'bind' || selectedOwner?.schema === 3) {
        const legacy = selectedOwner.schema === 1;
        const legacyRecovery = legacy && ['inspect', 'recover-legacy-bind'].includes(action);
        function selectBind(state) {
          const owners = ownerships();
          const owner = owners.find(item => item.token === token);
          need(owner?.operation === selectedOwner.operation && owner.schema === selectedOwner.schema && owner.codexChat === selectedOwner.codexChat &&
            (owner.codexChat === chatID || legacyRecovery) &&
            owner.workspace === ctx.workspace && owner.checkout === ctx.checkout, 'Operation lease is missing or belongs to another chat or checkout');
          need(owners.filter(item => overlaps(ctx.checkout, item.checkout)).length === 1,
            'Another operation owns this checkout');
          const binding = leasedBinding(state, owner);
          const fingerprint = owner.schema === 3 ? leaseFingerprint(state, owner, binding) : bindFingerprint(state, binding);
          const counter = binding ? planCounter(state, binding).correctionCount : null;
          if (legacy) {
            need(binding?.uncertain !== 'create', 'Session creation is already uncertain; preserve its binding and do not retry');
            need(binding && ['workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath'].every(key => binding[key] === ctx[key]) &&
              owner.sessionID === binding.sessionID && owner.assignmentID === binding.assignmentID,
            'Legacy bind lease and saved delivery do not match; creation state cannot be verified');
            const file = statSync(owner.path);
            return { owner, binding, fingerprint, counter, fileID: `${file.dev}:${file.ino}`,
              birth: file.birthtimeMs, written: file.mtimeMs };
          }
          need(['workspaceID', 'checkoutID', 'planPath'].every(key => owner[key] === ctx[key]) &&
            [owner.fingerprint, owner.nextFingerprint].includes(fingerprint), 'Operation lease pins or saved binding changed');
          return { owner, binding, fingerprint, counter };
        }
        const selected = selectBind(readState(statePath)), { owner, binding, counter } = selected;
        const proof = legacy ? { status: 'unknown', reason: 'legacy-bind-needs-local-reboot-proof' } :
          owner.process.start ? ownerLiveness(owner.process, probeOwner) : { status: 'unknown', reason: 'process-start-unavailable' };
        const legacyBind = legacy && binding.phase === 'FINISHED' && binding.messageID && !binding.pending ? {
          explanation: 'This lease has no PID or process start time. Windows must confirm a restart after the lease was written.',
          steps: [
            ['ownership', workspace, planPath, token, '--action', 'recover-legacy-bind'],
            ...(owner.codexChat === chatID ? [['replace-finished-session', workspace, planPath, binding.messageID, '--session', binding.sessionID,
              '--lost-powershell-calls', '<comma-separated-call-ids>', '--recovered-bind', token],
            ['preflight', workspace, planPath, '--session', '<new-session-id>']] :
              [['preflight', workspace, planPath]]),
          ].map(args => nonGitBaseline ? [...args, '--non-git-baseline', nonGitBaseline] : args),
        } : undefined;
        const result = { kind: 'ownership-status', token, operation: owner.operation, ownerStatus: proof.status, reason: proof.reason,
          processID: owner.process?.pid ?? null, recoveryAllowed: !legacy && proof.status === 'dead',
          sessionID: binding?.sessionID ?? null, messageID: binding?.messageID ?? null, phase: binding?.phase ?? null,
          correctionCount: counter, uncertain: binding?.uncertain ?? null, taskSent: false, stateChange: 'unchanged',
          ...(legacyBind ? { legacyBind } : {}) };
        if (action === 'inspect') return result;
        if (legacy && action === 'recover-legacy-bind') {
          need(client, 'OpenCode connection is required to check legacy bind recovery');
          need(!binding.uncertain, 'Legacy bind creation may be uncertain; no recovery');
          need(binding.phase === 'FINISHED' && binding.assignmentID && binding.messageID && !binding.pending,
            'Legacy bind recovery requires the original FINISHED delivery; create may have been reserved');
          const receipt = join(stateRoot, 'finished-session-replacements', binding.messageID + '.json');
          need(!existsSync(receipt), 'A replacement receipt exists; create may have been reserved');
          const boot = probeBootTime(owner.path);
          if (!(Number.isFinite(boot) && selected.birth > 0 && selected.written > 0 &&
            boot > Math.max(selected.birth, selected.written))) return { ...result, kind: 'rejected',
            error: 'Legacy bind owner is unverifiable; a confirmed Windows restart after the lease was written is required' };
          const checkLocal = state => {
            const current = selectBind(state);
            need(JSON.stringify(current) === JSON.stringify(selected), 'Legacy bind lease or saved delivery changed');
            need(!existsSync(receipt), 'A replacement receipt exists; create may have been reserved');
            need(!readClosure(stateRoot, binding) && !readTransition(stateRoot, binding.messageID),
              'Another closure or transition already exists');
            need(!observerPresent(stateRoot, ctx.checkout), 'An observer is active or uncertain; no legacy bind recovery');
            checkoutAvailable(state, ctx, current.binding);
          };
          checkLocal(readState(statePath));
          const quiet = async () => {
            const snapshot = await observationSnapshot(client, binding);
            need(!snapshot.active && !snapshot.forms.length && !snapshot.permissions.length && snapshot.session.outcome === 'succeeded' &&
              Number.isFinite(snapshot.session.time?.idle),
              'Prior session is active, awaiting a reply or missing a successful outcome');
            await requireQuietShells(client, binding);
          };
          await quiet();
          const messages = await assignmentMessages(client, binding);
          need(messages[0].text.startsWith('Assignment ID: ' + binding.assignmentID + '\nCanonical plan: ' +
            JSON.stringify(binding.planPath) + '\n'), 'Saved delivery does not confirm the exact plan in OpenCode');
          const head = await client.request(`/api/session/${binding.sessionID}/message?limit=1&order=desc`);
          need(Array.isArray(head?.data) && head.data.length === 1 && head.data[0].id === messages.at(-1).id,
            'Prior delivery history changed during legacy bind recovery');
          await quiet();
          const restart = { status: 'dead', reason: 'windows-restarted-after-lease', boot, birth: selected.birth, written: selected.written };
          locked(state => {
            checkLocal(state);
            archiveOwner(owner, { schema: 1, kind: 'legacy-bind-recovery', owner, proof: restart, counter,
              messageID: binding.messageID, fingerprint: selected.fingerprint, historyFingerprint: historyFingerprint(messages) });
          });
          return { ...result, legacyBind: undefined, kind: 'bind-ownership-released', ownerStatus: restart.status, reason: restart.reason,
            recoveryAllowed: true, leaseArchived: true };
        }
        if (legacy || action !== 'recover' || proof.status !== 'dead') return { ...result, kind: 'rejected' };
        locked(state => {
          need(JSON.stringify(selectBind(state)) === JSON.stringify(selected), 'Bind ownership or saved binding changed; no recovery');
          archiveOwner(owner, { schema: 1, owner, proof, counter, messageID: binding?.messageID ?? null });
        });
        return { ...result, kind: owner.operation === 'bind' ? 'bind-ownership-released' : 'operation-ownership-released', leaseArchived: true };
      }
      need(action !== 'recover-legacy-bind', 'Only an exact legacy bind lease can use recover-legacy-bind');
      function selection(state) {
        const binding = state.bindings.find(value => value.codexChat === chatID);
        need(binding && ['workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath'].every(key =>
          binding[key] === ctx[key]), 'Observation belongs to another chat/workspace/plan');
        const owner = ownerships().find(value => value.token === token);
        need(owner && ['wait', 'resume-watch'].includes(owner.operation) &&
          ['codexChat', 'workspace', 'checkout', 'sessionID', 'assignmentID'].every(key => owner[key] === binding[key]) &&
          (owner.schema === 1 || owner.messageID === binding.messageID &&
            owner.fingerprint === observationFingerprint(binding, planCounter(state, binding).correctionCount)),
        'Lease is not this delivered observation; pins/count changed');
        need(binding.assignmentID && binding.messageID, 'No delivered assignment');
        return { owner, binding, counter: planCounter(state, binding).correctionCount };
      }
      const selected = selection(readState(statePath)), { owner, binding, counter } = selected;
      const proof = ownerLiveness(owner.process, probeOwner);
      const result = { kind: 'ownership-status', token, operation: owner.operation, ownerStatus: proof.status,
        reason: proof.reason, recoveryAllowed: proof.status === 'dead', processID: owner.process?.pid ?? null,
        sessionID: binding.sessionID, assignmentID: binding.assignmentID, messageID: binding.messageID,
        correctionCount: counter, phase: binding.phase, taskSent: false, executorStopped: false, stateChange: 'unchanged',
        ...(owner.schema === 1 ? { legacyEvidence: { verified: false, supportedRecovery: false,
          missing: ['OS process creation identity', 'exact lease-token acquisition by that process', 'direct observer exit receipt'],
          acceptableSource: 'Independently verified native host acquisition/exit records bound to the exact lease and delivery',
          insufficient: ['user assertion', 'wrapper exit without child provenance', 'missing PID', 'age', 'empty active list'] } } : {}) };
      if (action === 'inspect') return result;
      if (action === 'recover' && proof.status !== 'dead' || action === 'stop' && owner.schema !== 2)
        return { ...result, kind: 'rejected' };
      locked(state => {
        const current = selection(state);
        need(JSON.stringify(current) === JSON.stringify(selected), 'Lease/binding/count changed; no recovery');
        try { if (action === 'stop') {
          mkdirSync(stopRoot, { recursive: true, mode: 0o700 });
          const path = join(stopRoot, token);
          if (existsSync(path)) need(readFileSync(path, 'utf8') === token, 'Observation stop marker changed');
          else writeFileSync(path, token, { flag: 'wx', mode: 0o600 });
        } else archiveOwner(owner, { schema: 1, owner, proof, counter, messageID: binding.messageID });
        } catch (error) { if (error?.code) throw stateFailure(error, 'state-write'); throw error; }
      });
      if (action === 'recover') return { ...result, kind: 'observation-released', leaseArchived: true };
      const deadline = Date.now() + 15000;
      while (existsSync(owner.path) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
      return { ...result, kind: existsSync(owner.path) ? 'observation-stop-pending' : 'observation-released',
        stopRequested: true, snapshotOnly: true };
    },

    async next(workspace, planPath, kind, nonGitBaseline) {
      need(['block', 'correction'].includes(kind), 'Next assignment kind must be block or correction');
      const begun = beginObserved(workspace, planPath, nonGitBaseline, ['REVIEWING', 'FINISHED'], 'next',
        (state, binding) => planCounter(state, binding).correctionCount >= 20 ?
          { ...summary(state, binding, 'correction-limit'), error: 'Twenty corrections reached; stop and select Code Duet again for a new cycle', stateChange: 'unchanged' } : null);
      if (begun.outcome) return begun.outcome;
      return withOwnership(begun.lease, async () => {
        try {
          const verified = [];
          const { boundary, receipt, available } = await reviewedResult(begun.expected, { verified });
          if (!available) return rejectedOutcome(begun.expected, new Error(unavailableForDispatch));
          return commit(begun.expected, (state, binding) => {
            saveReviewReceipt(stateRoot, binding, receipt);
            saveInvocationProofs(stateRoot, binding, verified);
            if (kind === 'block') recordAcceptance(stateRoot, state, binding);
            if (binding.adoption) Object.assign(binding.adoption, boundary);
            binding.nextAssignment = kind; binding.phase = 'PREPARING';
            return summary(state, binding, 'prepared');
          }).result;
        } catch (error) { return temporaryRead(error) ? rejectedOutcome(begun.expected, error) : stoppedOutcome(begun.expected, error); }
      });
    },
    async finish(workspace, planPath, nonGitBaseline, archive) {
      if (archive !== undefined) need(isAbsolute(archive) && /\.evtx$/i.test(archive) &&
        statSync(archive).isFile(), 'Use an absolute path to a Windows PowerShell .evtx archive');
      const begun = beginObserved(workspace, planPath, nonGitBaseline, archive ? ['FINISHED'] : ['REVIEWING', 'FINISHED'], 'finish');
      if (begun.outcome) return begun.outcome;
      return withOwnership(begun.lease, async () => {
        try {
          const verified = [];
          const { receipt } = await reviewedResult(begun.expected, { verified, archive });
          return commit(begun.expected, (state, binding) => {
            saveReviewReceipt(stateRoot, binding, receipt);
            saveInvocationProofs(stateRoot, binding, verified);
            recordAcceptance(stateRoot, state, binding);
            binding.phase = 'FINISHED';
            return summary(state, binding, 'released');
          }).result;
        } catch (error) { return archive || temporaryRead(error) ? rejectedOutcome(begun.expected, error) : stoppedOutcome(begun.expected, error); }
      });
    },
    async transition(workspace, planPath, messageID, disposition, { kind, nonGitBaseline, connectionError, movedPlanPath } = {}) {
      need(/^msg_[a-zA-Z0-9]+$/.test(messageID) && ['accepted', 'blocked', 'without-acceptance'].includes(disposition),
        'Transition requires the exact prior message ID and an explicit review disposition');
      const ctx = context(workspace, planPath, nonGitBaseline);
      const result = receipt => ({ kind: 'transition-prepared', workspace: ctx.workspace, planPath: ctx.planPath,
        sessionID: receipt.source.sessionID, assignmentKind: receipt.kind, taskSent: false,
        engineChanged: receipt.source.engineID !== receipt.engineID,
        previous: { planPath: receipt.source.planPath, assignmentID: receipt.source.assignmentID, messageID,
          disposition: receipt.disposition, correctionCount: receipt.correctionCount } });
      const start = locked(state => {
        const receipt = readTransition(stateRoot, messageID);
        const matches = state.bindings.filter(item => item.messageID === messageID);
        need(matches.length <= 1, 'Prior delivery identity is ambiguous');
        const binding = matches[0];
        if (receipt) {
          need(receipt.chatID === chatID && receipt.planPath === ctx.planPath && receipt.disposition === disposition &&
            (!kind || kind === receipt.kind) && ['workspace', 'workspaceID', 'checkout', 'checkoutID'].every(key =>
              receipt.source[key] === ctx[key]), 'Prior assignment already selected for a different transition');
          if (!binding || preparedTransition(stateRoot, binding)) return { outcome: result(receipt) };
          need(binding.codexChat === receipt.source.codexChat && binding.planPath === receipt.source.planPath &&
            binding.sessionID === receipt.source.sessionID, 'Staged transition source changed');
        }
        if (connectionError) throw connectionError;
        need(client && binding, 'No exact saved prior delivery or OpenCode connection');
        checkTransitionSource(binding, ctx, stateRoot, movedPlanPath);
        need(!readClosure(stateRoot, binding), 'Prior closure is staged; resolve it before a transition');
        need(disposition !== 'accepted' || ['REVIEWING', 'FINISHED'].includes(binding.phase),
          'Acceptance requires an assignment ready for review');
        need(!state.bindings.some(item => item !== binding && (item.codexChat === chatID || item.sessionID === binding.sessionID)),
          'Destination chat or OpenCode session already has another binding');
        checkoutAvailable(state, ctx, binding);
        const planSwitch = binding.planPath !== ctx.planPath;
        const assignmentKind = kind ?? (planSwitch ? 'initial' : 'block');
        need(planSwitch ? assignmentKind === 'initial' : ['block', 'correction'].includes(assignmentKind),
          'Use initial for a new plan, or block/correction for the same plan');
        planCounter(state, ctx);
        return { source: structuredClone(binding), correctionCount: planCounter(state, binding).correctionCount,
          assignmentKind, lease: claimOwnership(state, ctx, binding, 'transition') };
      });
      if (start.outcome) return start.outcome;
      return withOwnership(start.lease, async () => {
        const { boundary, receipt: reviewed, verified } = await checkedClosureBoundary(client, stateRoot, { ...start.source, adoption: undefined },
          disposition === 'accepted', start.source.engineID !== client.engineID);
        let saving = false;
        try {
          return locked(state => {
            const binding = state.bindings.find(item => item.codexChat === start.source.codexChat);
            need(binding && JSON.stringify(binding) === JSON.stringify(start.source) &&
              planCounter(state, binding).correctionCount === start.correctionCount &&
              !state.bindings.some(item => item !== binding && (item.codexChat === chatID || item.sessionID === binding.sessionID)),
            'Prior assignment or destination changed during transition');
            checkoutAvailable(state, ctx, binding);
            planCounter(state, ctx);
            const receipt = { schema: 1, source: start.source, correctionCount: start.correctionCount, boundary,
              chatID, planPath: ctx.planPath, engineID: client.engineID, kind: start.assignmentKind, disposition };
            const path = transitionPath(stateRoot, messageID);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            if (disposition === 'accepted') {
              saveReviewReceipt(stateRoot, binding, reviewed);
              recordAcceptance(stateRoot, state, binding, movedPlanPath);
            }
            saveInvocationProofs(stateRoot, binding, verified);
            // Keep the source before moving ownership. A staged retry must verify the live boundary again.
            saveJSON(path, receipt);
            Object.assign(binding, { codexChat: chatID, planPath: ctx.planPath, engineID: client.engineID, phase: 'PREPARING' });
            delete binding.stopReason; delete binding.diagnostic;
            if (binding.adoption) Object.assign(binding.adoption, boundary);
            if (receipt.kind !== 'initial') binding.nextAssignment = receipt.kind;
            saving = true;
            saveOwnedState(state);
            return result(receipt);
          });
        } catch (error) {
          if (saving) error.stateOutcome = unconfirmedOutcome({ ...start.source, correctionCount: start.correctionCount },
            error, 'Transition persistence unconfirmed; repeat only the same transition');
          throw error;
        }
      });
    },
    async closeAssignment(workspace, planPath, selection, connectionError) {
      need(selection && typeof selection.sessionID === 'string' && /^ses_[a-zA-Z0-9]+$/.test(selection.sessionID) &&
        typeof selection.assignmentID === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(selection.assignmentID) &&
        typeof selection.messageID === 'string' && /^msg_[a-zA-Z0-9]+$/.test(selection.messageID),
      'Closure requires exact session, assignment and message IDs');
      const ctx = observationContext(workspace, planPath);
      const result = receipt => ({ kind: 'closed-without-acceptance', phase: 'PREPARING',
        ...selection, correctionCount: receipt.correctionCount, nextAssignment: 'correction',
        ...(receipt.stopReason ? { stopReason: receipt.stopReason } : {}),
        ...(receipt.diagnostic ? { diagnostic: receipt.diagnostic } : {}), taskSent: false, reviewAllowed: false });
      const start = locked(state => {
        const binding = state.bindings.find(item => item.codexChat === chatID);
        need(binding && binding.sessionID === selection.sessionID && Object.keys(ctx).every(key => binding[key] === ctx[key]),
          'No exact saved chat/session/workspace/plan binding');
        const receipt = readClosure(stateRoot, binding, selection.messageID);
        if (receipt && receipt.assignmentID === selection.assignmentID && (binding.messageID !== selection.messageID ||
          binding.phase === 'PREPARING' && binding.nextAssignment === 'correction')) return { outcome: result(receipt) };
        if (connectionError) throw connectionError;
        need(client, 'OpenCode connection required for closure');
        savedContext(binding, ctx, true);
        need(binding.phase === 'STOPPED' && binding.assignmentID === selection.assignmentID &&
          binding.messageID === selection.messageID && !binding.pending && !binding.nextAssignment,
        'Only the exact stopped, delivered assignment with no pending request can be closed');
        need(!readTransition(stateRoot, binding.messageID), 'Transition was staged; repeat the exact transition command');
        checkoutAvailable(state, ctx, binding);
        return { expected: { ...structuredClone(binding), correctionCount: planCounter(state, binding).correctionCount },
          lease: claimOwnership(state, ctx, binding, 'close') };
      });
      if (start.outcome) return start.outcome;
      return withOwnership(start.lease, async () => {
        const expected = start.expected;
        const { boundary, verified } = await checkedClosureBoundary(client, stateRoot, { ...expected, adoption: undefined });
        let saving = false;
        try {
          const saved = commit(expected, (state, binding) => {
            checkoutAvailable(state, ctx, binding);
            need(binding.stopReason === expected.stopReason && JSON.stringify(binding.diagnostic) === JSON.stringify(expected.diagnostic),
              'Stop evidence changed during closure');
            const receipt = { schema: 1, owner: closureOwner(binding), sessionID: binding.sessionID, assignmentID: binding.assignmentID,
              messageID: binding.messageID, correctionCount: expected.correctionCount, boundary,
              stopReason: binding.stopReason, diagnostic: binding.diagnostic };
            const path = closurePath(stateRoot, binding.messageID);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            // Write the receipt first. A still-STOPPED binding must reverify before completing a staged closure.
            saveInvocationProofs(stateRoot, binding, verified);
            saveJSON(path, receipt);
            delete binding.stopReason; delete binding.diagnostic;
            if (binding.adoption) Object.assign(binding.adoption, boundary);
            binding.phase = 'PREPARING'; binding.nextAssignment = 'correction';
            return result(receipt);
          }, () => { saving = true; });
          const { stateChange, ...outcome } = saved.result;
          return outcome;
        } catch (error) {
          if (saving) error.stateOutcome = unconfirmedOutcome(expected, error, 'Closure persistence unconfirmed; repeat only the same close-assignment');
          throw error;
        }
      });
    },
    async connectionLost(error, { preserveReview = false } = {}) {
      return locked(state => {
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        if (!binding) return null;
        if (binding.phase === 'STOPPED') return { ...summary(state, binding, 'stopped'),
          error: binding.stopReason || 'Prior mutation uncertain; explicit continuation required',
          executorStopped: false, retried: false, stateChange: 'unchanged', ...(binding.diagnostic ? { diagnostic: binding.diagnostic } : {}) };
        const diagnostic = error?.diagnostic ? validateDiagnostic(error.diagnostic) : diagnose(error, 'unknown', 'connection');
        const retried = !!error?.bootstrap?.retried;
        if (['PREPARING', 'FINISHED'].includes(binding.phase) || preserveReview && binding.phase === 'REVIEWING')
          return { ...summary(state, binding, 'connection-unavailable'),
          error: error?.message ?? 'Engine connection unavailable', diagnostic, retried, bootstrap: error?.bootstrap,
          stateChange: 'unchanged' };
        const result = stop(state, binding, 'connection-uncertain',
          error?.message ?? 'Connection/discovery failed; explicit continuation required', diagnostic);
        return { ...result, diagnostic, retried, bootstrap: error?.bootstrap };
      });
    },
    async wait(workspace, planPath, { nonGitBaseline, timeoutMs = WAIT_TIMEOUT_MS, signal = new AbortController().signal, resume, postgresRecovery, onReady, once = false } = {}) {
      need(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= WAIT_TIMEOUT_MS, 'Wait timeout must be 1..' + WAIT_TIMEOUT_MS + ' ms');
      const resuming = resume !== undefined;
      if (resuming) need(resume && Object.keys(resume).length === 3 &&
        ['sessionID', 'assignmentID', 'messageID'].every(key => typeof resume[key] === 'string') &&
        /^ses_[a-zA-Z0-9]+$/.test(resume.sessionID) && /^[a-zA-Z0-9._-]{1,120}$/.test(resume.assignmentID) &&
        /^msg_[a-zA-Z0-9]+$/.test(resume.messageID), 'Explicit resume requires exact session, assignment and message IDs');
      if (postgresRecovery !== undefined) {
        postgresRecovery = structuredClone(validatePostgresRecovery(postgresRecovery));
        need(resume?.messageID === postgresRecovery.messageID, 'PostgreSQL evidence requires the exact resume delivery');
      }
      const begun = beginObserved(workspace, planPath, nonGitBaseline,
        resuming ? ['STOPPED'] : ['EXECUTING', 'WAITING_FOR_ANSWER', 'REVIEWING'], resuming ? 'resume-watch' : 'wait',
        resuming ? (state, binding) => need(!binding.nextAssignment &&
          ['sessionID', 'assignmentID', 'messageID'].every(key => binding[key] === resume[key]),
        'Resume selection differs from the delivered assignment; no state change') : undefined);
      if (begun.outcome) return begun.outcome;
      const outcome = await withOwnership(begun.lease, async () => {
        const startedAt = Date.now(), deadline = AbortSignal.timeout(timeoutMs);
        const stopRequest = new AbortController(), outerSignal = signal;
        signal = AbortSignal.any([outerSignal, stopRequest.signal]);
        const stopping = setInterval(() => {
          try {
            if (existsSync(join(stopRoot, begun.lease.token)) &&
              readFileSync(join(stopRoot, begun.lease.token), 'utf8') === begun.lease.token) stopRequest.abort();
          } catch { stopRequest.abort(); }
        }, 250);
        const combined = AbortSignal.any([signal, deadline]);
        let expected = begun.expected, stream;
        const record = (change, kind) => {
          const saved = commit(expected, (state, binding) => {
            if (resuming) {
              need(planCounter(state, binding).correctionCount === expected.correctionCount,
                'Saved correction count changed during resumed observation');
              if (expected.phase === 'STOPPED') {
                need(binding.stopReason === expected.stopReason && JSON.stringify(binding.diagnostic) === JSON.stringify(expected.diagnostic),
                  'Stopped diagnostic changed during resumed observation');
                delete binding.stopReason; delete binding.diagnostic;
              }
            }
            change(state, binding);
            return summary(state, binding, kind);
          });
          expected = saved.expected;
          return saved.result;
        };
        const stopWait = (kind, reason, diagnostic) => resuming && expected.phase === 'STOPPED' ?
          { ...rejectedOutcome(expected, new Error(reason)), phase: 'STOPPED', assignmentID: expected.assignmentID,
            messageID: expected.messageID, diagnostic, executorStopped: false } :
          stoppedOutcome(expected, Object.assign(new Error(reason), { diagnostic }), kind);
        try {
          stream = await observationWake(client, expected.sessionID, combined, expected.workspace, once);
          let history, messages, exchange;
          while (true) {
            locked(state => need(unchanged(state.bindings.find(binding => binding.codexChat === chatID), expected, state),
              'Saved assignment/count changed during wait; no stale state write'));
            if (signal.aborted) return stopWait('interrupted', 'Advisor wait interrupted; executor termination unconfirmed',
              diagnose(null, 'interrupted', 'wait', stream.observation));
            if (deadline.aborted) return stopWait('connection-uncertain', 'Wait deadline reached; executor termination unconfirmed',
              stream.diagnostic ?? diagnose(null, 'deadline', 'wait', stream.observation));
            if (stream.fault) return stopWait(stream.fault, 'Event stream failed/interrupted; no reconnect or ownership transfer', stream.diagnostic);
            const current = await snapshot(expected);
            if (postgresRecovery) need(!current.active && !current.forms.length && !current.permissions.length &&
              current.session.time?.idle >= expected.submittedAt, 'PostgreSQL recovery requires a terminal idle assignment');
            if (resuming && expected.phase === 'STOPPED') {
              need(current.session.time?.archived === undefined &&
                (current.session.archived === undefined || current.session.archived === false), 'Cannot observe an archived session');
              need(current.active === undefined || current.active?.type === 'running' && Object.keys(current.active).length === 1,
                'Unknown active execution status');
            }
            const refresh = stream.takeFailureHint();
            if (!history || refresh || current.forms.length || current.permissions.length || !current.active) {
              messages = await assignmentMessages(client, expected);
              const boundHistory = withShellEvidence(stateRoot, expected);
              exchange = !current.active && !current.forms.length && !current.permissions.length &&
                current.session.outcome === 'succeeded' && current.session.time?.idle >= expected.submittedAt ?
                deliveredExchange(messages) : messages;
              history = inspectMessages(postgresRecovery ? { ...boundHistory, postgresRecovery, postgresTimeline: undefined } : boundHistory, exchange);
            }
            if (stream.fault || combined.aborted) continue;
            locked(state => need(unchanged(state.bindings.find(binding => binding.codexChat === chatID), expected, state),
              'Saved assignment/count changed during wait; no stale state write'));
            const progress = { executorActivity: current.active ? 'running' : 'idle',
              exchangeOutcome: history.kind ?? 'in-progress', reviewAllowed: false, dispatchAllowed: false,
              ...(history.toolErrors.length ? { toolErrors: history.toolErrors } : {}),
              ...(history.exchangeFailure ? { exchangeFailure: history.exchangeFailure } : {}) };
            const failure = history.kind ?? (current.session.time?.idle >= expected.submittedAt &&
              ['failed', 'interrupted'].includes(current.session.outcome) ? current.session.outcome : null);
            if (failure && !current.active && !current.forms.length && !current.permissions.length) {
              const confirmed = await snapshot(expected), latest = await assignmentMessages(client, expected);
              if (confirmed.active || confirmed.forms.length || confirmed.permissions.length ||
                JSON.stringify(confirmed.session.time) !== JSON.stringify(current.session.time) ||
                JSON.stringify(latest) !== JSON.stringify(messages)) {
                history = undefined; continue;
              }
              return { ...stopWait(failure, history.toolFailure && history.standIssue ||
                'Bound assignment failed/interrupted; inspect its session'), ...progress };
            }
            const pending = current.permissions.length ? ['permission', current.permissions[0]] :
              current.forms.length ? ['question', current.forms[0]] : null;
            if (pending) {
              const result = interactive(...pending, expected, history);
              const saved = record((state, binding) => {
                binding.phase = 'WAITING_FOR_ANSWER';
                binding.pending = { kind: result.kind, id: result.request.id, fingerprint: result.fingerprint };
              }, result.kind);
              return { ...saved, ...progress, request: result.request, fingerprint: result.fingerprint,
                ...(result.manualReason ? { manualReason: result.manualReason, replyAllowed: false } : {}) };
            }
            if (expected.pending && expected.phase !== 'STOPPED') record((state, binding) => {
              delete binding.pending; binding.phase = 'EXECUTING';
            }, 'observing');
            if (!current.active && current.session.time?.idle >= expected.submittedAt) {
              need(current.session.outcome === 'succeeded', 'Unknown terminal outcome');
              deliveredBoundary(expected, messages, current.session, true);
              const review = reviewReceipt(stateRoot, expected, exchange);
              const shells = await projectShells(client, expected);
              const verified = [], verification = { verified };
              let result, completionError;
              try { result = completion(history, current.session, shells, verification); }
              catch (error) { completionError = error; }
              const confirmed = await snapshot(expected);
              const sameExecution = !confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
                confirmed.session.outcome === current.session.outcome &&
                sessionAvailable(confirmed.session) === sessionAvailable(current.session) &&
                JSON.stringify(confirmed.session.model) === JSON.stringify(current.session.model) &&
                JSON.stringify(confirmed.session.time) === JSON.stringify(current.session.time);
              const stable = sameExecution && await confirmHistoryAndCheckShells(client, expected, messages, shells);
              if (stream.fault || combined.aborted) continue;
              if (!stable) {
                const change = sameExecution ? 'Project shells changed during completion verification' :
                  'Execution changed during completion confirmation';
                if (once) return { ...rejectedOutcome(expected, new Error(change)), kind: 'retryable-read' };
                await stream.next(Math.min(250, timeoutMs));
                continue;
              }
              if (completionError) throw completionError;
              return { ...record((state, binding) => {
                saveReviewReceipt(stateRoot, binding, review);
                saveInvocationProofs(stateRoot, binding, verified);
                delete binding.pending; binding.phase = 'REVIEWING';
                if (verification.postgresEvidence && (postgresRecovery || !history.recoveryBinding.postgresTimeline)) {
                  const path = postgresPath(stateRoot, binding.messageID);
                  const receipt = { owner: deliveryFingerprint(binding), evidence: verification.postgresEvidence, timeline: result.result.postgresRecovery };
                  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
                  if (existsSync(path)) need(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(receipt),
                    'A different PostgreSQL recovery receipt already exists');
                  else saveJSON(path, receipt);
                }
              }, result.kind),
                ...progress, exchangeOutcome: result.kind, reviewAllowed: true, result: result.result };
            }
            if (resuming && expected.phase === 'STOPPED') {
              need(current.active?.type === 'running', 'No correlated active execution, request or completed result');
              const confirmed = await snapshot(expected);
              messages = await assignmentMessages(client, expected);
              history = inspectMessages(expected, messages);
              need(!history.kind || confirmed.active?.type === 'running',
                'Failed/interrupted assignment cannot resume observation');
              if (!confirmed.active || confirmed.forms.length || confirmed.permissions.length) continue;
              need(confirmed.active.type === 'running' && Object.keys(confirmed.active).length === 1, 'Unknown active execution status');
              record((state, binding) => { delete binding.pending; binding.phase = 'EXECUTING'; }, 'observing');
            }
            onReady?.(); onReady = undefined;
            if (once) return { kind: 'observing', ...progress, phase: expected.phase, sessionID: expected.sessionID,
              assignmentID: expected.assignmentID, messageID: expected.messageID, correctionCount: expected.correctionCount };
            await stream.next(Math.min(5_000, timeoutMs));
          }
        } catch (error) {
          if (!combined.aborted && temporaryRead(error))
            return { ...rejectedOutcome(expected, error), kind: 'retryable-read' };
          const category = signal.aborted ? 'interrupted' : deadline.aborted ? 'deadline' : null;
          const diagnostic = diagnose(category ? null : error, category ?? 'unknown', category ? 'wait' : 'snapshot',
            stream?.observation ?? { elapsedMs: Math.max(0, Date.now() - startedAt), lastEvent: null });
          return stopWait(signal.aborted ? 'interrupted' : 'connection-uncertain',
            resuming && error?.code && !error?.diagnostic ? 'Workspace or state I/O failed; inspect diagnostic' :
              error?.message ?? 'Wait observation failed; inspect before continuing', diagnostic);
        } finally { clearInterval(stopping); await stream?.close(); }
      });
      return resuming ? { ...outcome, observationOnly: true, taskSent: false } : outcome;
    },
    async reply(workspace, planPath, kind, requestID, payload, nonGitBaseline) {
      need(['question', 'permission'].includes(kind) && /^(frm_|per)[a-zA-Z0-9_]+$/.test(requestID), 'Invalid interactive kind/request ID');
      const begun = beginObserved(workspace, planPath, nonGitBaseline, ['WAITING_FOR_ANSWER'], 'reply',
        (state, binding) => {
          need(binding.pending?.kind === kind && binding.pending.id === requestID,
            'Request was not observed by this advisor');
          if (kind === 'permission' && !(payload && ['once', 'reject'].includes(payload.decision) &&
            Object.keys(payload).every(key => ['decision', 'message'].includes(key)) &&
            (payload.message === undefined || typeof payload.message === 'string'))) {
            return { ...summary(state, binding, 'rejected'),
              error: 'Permission requires explicit once/reject decision; never always',
              stateChange: 'unchanged', retried: false };
          }
        });
      if (begun.outcome) return begun.outcome;
      const { expected, lease } = begun;
      return withOwnership(lease, async () => {
        let current, request, history, verified;
        try {
          current = await snapshot(expected);
          request = (kind === 'question' ? current.forms : current.permissions).find(item => item.id === requestID);
          if (!request) return commit(expected, (state, binding) => {
            delete binding.pending; binding.phase = 'EXECUTING';
            return summary(state, binding, 'stale-request');
          }).result;
          history = inspectMessages(expected, await assignmentMessages(client, expected));
          verified = interactive(kind, request, expected, history);
          need([verified.fingerprint, historyFingerprint(request)].includes(expected.pending.fingerprint), 'Pending request changed; no reply');
          const latest = await client.request('/api/session/' + expected.sessionID + (kind === 'question' ? '/form' : '/permission'));
          need(Array.isArray(latest?.data), 'Unknown pending status before reply');
          const stillPending = latest.data.find(item => item.id === requestID);
          if (!stillPending) return commit(expected, (state, binding) => {
            delete binding.pending; binding.phase = 'EXECUTING';
            return summary(state, binding, 'stale-request');
          }).result;
          const fresh = interactive(kind, stillPending, expected, history);
          need(fresh.fingerprint === verified.fingerprint,
            'Request changed before reply; no mutation');
          if (fresh.manualReason) return rejectedOutcome(expected, new Error(fresh.manualReason));
          request = stillPending;
        } catch (error) { return stoppedOutcome(expected, error); }
        if (kind === 'question') {
          try { validateAnswer(request, payload); }
          catch (error) { return rejectedOutcome(expected, error); }
        }
        let reservationAttempted = false, reserved;
        try {
          reserved = commit(expected, (state, binding) => {
            binding.phase = 'STOPPED'; binding.uncertain = 'reply';
            binding.pending.fingerprint = verified.fingerprint;
            binding.intent = { reject: kind === 'permission' && payload.decision === 'reject', acknowledged: false,
              ...(kind === 'question' ? { answerHash: fingerprint(payload) } : {}) };
            return summary(state, binding, 'reply-pending');
          }, () => { reservationAttempted = true; });
        } catch (error) {
          if (reservationAttempted) error.stateOutcome = unconfirmedOutcome({ ...expected, phase: 'STOPPED' }, error,
            'Reply reservation unconfirmed; no reply was sent');
          throw error;
        }
        try {
          await client.request('/api/session/' + expected.sessionID + '/' +
            (kind === 'question' ? 'form' : 'permission') + '/' + requestID + '/reply', payload);
        } catch (error) { return stoppedOutcome(reserved.expected, error); }
        try {
          reserved = commit(reserved.expected, (_state, binding) => { binding.intent.acknowledged = true; });
          return commit(reserved.expected, (state, binding) => {
            return settleMutation(state, binding, false);
          }).result;
        } catch (error) {
          error.stateOutcome = unconfirmedOutcome(reserved.expected, error,
            kind === 'permission' && payload.decision === 'reject' ?
              'Permission rejection accepted; state transition unconfirmed, inspect the store' :
              'Reply accepted; state transition unconfirmed, inspect the store');
          throw error;
        }
      });
    },

    async adopt(workspace, planPath, sessionID, nonGitBaseline, importedCount) {
      let saving = false;
      try {
        need(/^ses_[a-zA-Z0-9]+$/.test(sessionID), 'Use an exact existing session ID');
        need(importedCount === undefined || Number.isInteger(importedCount) && importedCount >= 0 && importedCount <= 20,
          'Invalid imported correction count');
        const start = locked(state => {
          const ctx = context(workspace, planPath, nonGitBaseline);
          const existing = state.bindings.find(binding => binding.codexChat === chatID);
          need(importedCount !== undefined || state.plans.some(plan => plan.planPath === ctx.planPath),
            'Established correction count required for adoption; do not guess zero');
          planCounter(state, ctx, importedCount);
          if (existing) {
            savedContext(existing, ctx);
            need(existing.sessionID === sessionID, 'Another session is already bound to this Codex chat');
            need(['PREPARING', 'FINISHED'].includes(existing.phase), 'Existing binding still owns an assignment');
            checkoutAvailable(state, ctx, existing);
            return { ctx, state: structuredClone(state), expected: { ...structuredClone(existing),
              correctionCount: state.plans.find(plan => plan.planPath === ctx.planPath).correctionCount },
              lease: claimOwnership(state, ctx, existing, 'adopt'), existing: true };
          }
          need(!state.bindings.some(binding => binding.engineID === client.engineID && binding.sessionID === sessionID),
            'Session is already bound to another Codex chat; no takeover');
          checkoutAvailable(state, ctx);
          const provisional = { sessionID };
          return { ctx, state: structuredClone(state), lease: claimOwnership(state, ctx, provisional, 'adopt'), existing: false };
        });
        const outcome = await withOwnership(start.lease, async () => {
          try {
            if (start.existing) {
              if (start.expected.phase === 'FINISHED') await reviewedResult(start.expected);
              else {
                const { boundary: current } = await idleExisting(start.state, preparedBinding(stateRoot, start.expected));
                if (start.expected.adoption) need(['variant', 'lastMessageID', 'idleAt'].every(key => current[key] === start.expected.adoption[key]),
                  'Existing session changed since preparation; no dispatch');
              }
              return locked(state => {
                const binding = state.bindings.find(item => item.codexChat === chatID);
                need(unchanged(binding, start.expected, state), 'Saved binding changed during adoption check');
                return { ...summary(state, binding, 'reused'), stateChange: 'unchanged' };
              });
            }
            const binding = { codexChat: chatID, ...start.ctx, engineID: client.engineID, sessionID, phase: 'PREPARING' };
            ({ boundary: binding.adoption } = await idleExisting(start.state, binding));
            return locked(state => {
              need(!state.bindings.some(item => item.codexChat === chatID), 'Binding appeared during adoption; no takeover');
              need(!state.bindings.some(item => item.engineID === client.engineID && item.sessionID === sessionID),
                'Session became bound to another Codex chat; no takeover');
              checkoutAvailable(state, start.ctx);
              planCounter(state, start.ctx, importedCount);
              state.bindings.push(binding);
              saving = true;
              saveOwnedState(state);
              return summary(state, binding, 'adopted');
            });
          } catch (error) {
            if (saving) error.adoptionState = 'unconfirmed';
            else error.adoptionState ??= 'unchanged';
            throw error;
          }
        });
        return outcome?.ownershipReleaseFailure ? { ...outcome,
          adoption: { bindingState: start.existing ? 'unchanged' : 'unconfirmed', engineMutation: 'none' } } : outcome;
      } catch (error) {
        if (saving && !error.diagnostic) error = diagnosticError(
          'Adoption state persistence/lock release unconfirmed; inspect store, no automatic retry',
          'state-io', 'state-write', {}, error);
        error.adoptionState ??= saving ? 'unconfirmed' : 'unchanged';
        throw error;
      }
    },
    async bind(workspace, planPath, nonGitBaseline, importedCount, replacement) {
      const ctx = context(workspace, planPath, nonGitBaseline);
      if (replacement) need(/^ses_[a-zA-Z0-9]+$/.test(replacement.sessionID) && /^msg_[a-zA-Z0-9]+$/.test(replacement.messageID) &&
        (replacement.unavailable === true && replacement.lostCalls === undefined && replacement.recoveredBind === undefined ||
        Array.isArray(replacement.lostCalls) && replacement.lostCalls.length > 0 && replacement.lostCalls.length <= 32 &&
        replacement.lostCalls.every(id => /^call_[a-zA-Z0-9_]{1,120}$/.test(id)) &&
        new Set(replacement.lostCalls).size === replacement.lostCalls.length &&
        (replacement.recoveredBind === undefined || leaseTokenPattern.test(replacement.recoveredBind))),
      'Use exact prior session, delivery, PowerShell call IDs and legacy bind token');
      need(importedCount === undefined || Number.isInteger(importedCount) && importedCount >= 0 && importedCount <= 20,
        'Invalid imported correction count');
      const start = locked(state => {
        const existing = state.bindings.find(binding => binding.codexChat === chatID);
        planCounter(state, ctx, importedCount);
        if (replacement) {
          need(existing?.phase === 'FINISHED' && existing.assignmentID && existing.sessionID === replacement.sessionID &&
            existing.messageID === replacement.messageID, 'Only the exact FINISHED delivery in this chat can be replaced');
          const verifiedHistory = replacement.recoveredBind && legacyBindProof(replacement.recoveredBind, state, existing);
          savedContext(replacement.unavailable ? { ...existing, engineID: client.engineID, planPath: ctx.planPath } :
            verifiedHistory ? { ...existing, engineID: client.engineID } : existing, ctx);
          if (replacement.unavailable) need(readAcceptance(stateRoot, existing), 'Missing acceptance receipt for the finished delivery');
          need(!readClosure(stateRoot, existing) && !readTransition(stateRoot, existing.messageID), 'Another closure or transition already exists');
          need(!observerPresent(stateRoot, ctx.checkout), 'An observer is active or uncertain; no replacement');
          checkoutAvailable(state, ctx, existing);
          return { ctx, state: structuredClone(state), source: structuredClone(existing), verifiedHistory,
            correctionCount: planCounter(state, existing).correctionCount,
            lease: claimOwnership(state, ctx, existing, 'bind') };
        }
        if (existing) {
          if (existing.planPath !== ctx.planPath) {
            savedContext({ ...existing, planPath: ctx.planPath }, ctx);
            need(existing.phase === 'FINISHED', 'Previous plan assignment not released; no plan switch');
            checkoutAvailable(state, ctx, existing);
            return { ctx, state: structuredClone(state), expected: { ...structuredClone(existing),
              correctionCount: state.plans.find(plan => plan.planPath === existing.planPath).correctionCount },
              lease: claimOwnership(state, ctx, existing, 'bind'), planSwitch: true };
          }
          savedContext(existing, ctx);
          checkoutAvailable(state, ctx, existing);
          return { ctx, state: structuredClone(state), expected: { ...structuredClone(existing),
            correctionCount: planCounter(state, ctx).correctionCount },
            lease: claimOwnership(state, ctx, existing, 'bind'), planSwitch: false };
        }
        checkoutAvailable(state, ctx);
        return { ctx, state: structuredClone(state), lease: claimOwnership(state, ctx, null, 'bind'), planSwitch: false };
      });
      return withOwnership(start.lease, async () => {
        if (start.expected && !start.planSwitch) {
          try {
            await sessionMatches(preparedBinding(stateRoot, start.expected));
            await noForms(start.expected);
          } catch (error) { throw error; }
          return locked(state => {
            const binding = state.bindings.find(item => item.codexChat === chatID);
            need(unchanged(binding, start.expected, state), 'Saved binding changed during reuse check');
            planCounter(state, ctx, importedCount);
            return { ...summary(state, binding, 'reused'), stateChange: 'unchanged' };
          });
        }
        if (start.planSwitch) {
          try {
            const { boundary, receipt, available } = await reviewedResult(start.expected);
            if (!available) return rejectedOutcome(start.expected, new Error(unavailableForDispatch));
            return commit(start.expected, (state, binding) => {
              saveReviewReceipt(stateRoot, binding, receipt);
              if (!readAcceptance(stateRoot, binding)) recordAcceptance(stateRoot, state, binding);
              const { assignmentID, messageID, submittedAt, planPath } = binding;
              const reusedDelivery = { assignmentID, messageID, submittedAt, planPath, boundary };
              if (binding.adoption) Object.assign(binding.adoption, boundary);
              planCounter(state, ctx, importedCount);
              binding.planPath = ctx.planPath; binding.phase = 'PREPARING';
              for (const key of ['assignmentID', 'messageID', 'submittedAt', 'nextAssignment']) delete binding[key];
              savePreparation(stateRoot, binding, { reusedDelivery });
              return summary(state, binding, 'reused-plan');
            }).result;
          } catch (error) { return stoppedOutcome(start.expected, error, 'connection-uncertain'); }
        }
        let archive;
        if (start.source && replacement.unavailable) {
          await requireQuietShells(client, start.source);
          let session;
          try { session = await sessionMatches(start.source); }
          catch (error) { if (error.diagnostic?.httpStatus !== 404) throw error; }
          if (session) {
            need(archivedSession(session), 'Prior OpenCode session is still available');
            await noForms(start.source);
          }
          archive = { schema: 1, source: start.source, correctionCount: start.correctionCount,
            reason: 'accepted-session-unavailable' };
        } else if (start.source) {
          const gaps = [], lostCalls = new Set(replacement.lostCalls);
          const { boundary } = await checkedClosureBoundary(client, stateRoot, start.source, true, !!start.verifiedHistory,
            { gaps, lostCalls, historyFingerprint: start.verifiedHistory });
          need(gaps.length === lostCalls.size && new Set(gaps.map(call => call.id)).size === lostCalls.size,
            'The listed PowerShell calls do not match the lost evidence; no replacement');
          archive = { schema: 1, source: start.source, correctionCount: start.correctionCount, boundary,
            reason: 'lost-powershell-lifecycle-evidence', gaps };
        }
        await idleWorkspace(start.state, ctx);
        let reservationAttempted = false, reservationExpected, reserved;
        try {
          reserved = locked(state => {
            const current = state.bindings.find(binding => binding.codexChat === chatID);
            if (archive) {
              need(unchanged(current, { ...start.source, correctionCount: start.correctionCount }, state),
                'Finished delivery changed during replacement');
              need(!observerPresent(stateRoot, ctx.checkout), 'An observer is active or uncertain; no replacement');
            } else need(!current, 'Binding appeared during create preparation');
            checkoutAvailable(state, ctx, current);
            const plan = planCounter(state, ctx, importedCount);
            const binding = { codexChat: chatID, ...ctx, engineID: client.engineID,
              sessionID: null, phase: 'STOPPED', uncertain: 'create', intent: { nonce: randomUUID() } };
            if (archive) {
              const path = join(stateRoot, 'finished-session-replacements', start.source.messageID + '.json');
              mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
              if (existsSync(path)) need(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(archive),
                'A different replacement record already exists');
              else saveJSON(path, archive);
              state.bindings[state.bindings.indexOf(current)] = binding;
            } else state.bindings.push(binding);
            reservationExpected = { ...structuredClone(binding), correctionCount: plan.correctionCount };
            reservationAttempted = true;
            saveOwnedState(state);
            return { expected: reservationExpected, result: summary(state, binding, 'create-pending') };
          });
        } catch (error) {
          if (reservationAttempted) error.stateOutcome = unconfirmedOutcome(reservationExpected, error,
            'Session creation reservation unconfirmed; no create request was sent');
          throw error;
        }
        let expected = reserved.expected;
        let response;
        try {
          response = await client.request('/api/session', {
            title: reservedSessionTitle(expected), location: { directory: ctx.workspace }, model: EXECUTOR_MODEL,
          });
          need(/^ses_[a-zA-Z0-9]+$/.test(response?.data?.id), 'Creation uncertain; no retry');
          if (archive) need(!start.state.bindings.some(binding => binding.sessionID === response.data.id),
            'OpenCode did not return a fresh session; no retry');
        } catch (error) {
          error.stateOutcome = stoppedOutcome(expected, error, 'stopped');
          throw error;
        }
        const createdExpected = { ...expected, sessionID: response.data.id };
        try {
          expected = commit(expected, (state, binding) => {
            binding.sessionID = response.data.id;
            return summary(state, binding, 'create-pending');
          }).expected;
        } catch (error) {
          error.stateOutcome = unconfirmedOutcome(createdExpected, error,
            'Session created; saved session identity is unconfirmed, inspect the store');
          throw error;
        }
        try {
          if (archive) {
            const current = await observationSnapshot(client, expected);
            const head = await client.request(`/api/session/${expected.sessionID}/message?limit=1&order=desc`);
            need(!current.active && !current.forms.length && !current.permissions.length &&
              current.session.outcome === undefined && current.session.time?.idle === undefined &&
              Array.isArray(head?.data) && head.data.length === 0, 'Replacement session is not empty and idle; no retry');
            need(current.session.model.variant === EXECUTOR_MODEL.variant, 'OpenCode did not select High');
          } else need((await sessionMatches(expected)).model.variant === EXECUTOR_MODEL.variant, 'OpenCode did not select High');
        }
        catch (error) {
          error.stateOutcome = stoppedOutcome(expected, error, 'stopped');
          throw error;
        }
        try {
          return commit(expected, (state, binding) => {
            delete binding.uncertain; delete binding.intent; binding.phase = 'PREPARING';
            return archive ? { ...summary(state, binding, 'finished-session-replaced'), taskSent: false,
              previous: { phase: 'FINISHED', sessionID: start.source.sessionID, messageID: start.source.messageID,
                correctionCount: start.correctionCount, reason: archive.reason } } : summary(state, binding, 'created');
          }).result;
        } catch (error) {
          error.stateOutcome = unconfirmedOutcome(expected, error,
            'Session created; final binding state is unconfirmed, inspect the store');
          throw error;
        }
      });
    },
    async submit(workspace, planPath, assignmentID, packetPath, nonGitBaseline, kind = 'initial', { requirePacketIdentity = false } = {}) {
      need(['initial', 'block', 'correction'].includes(kind), 'Invalid assignment kind');
      need(text(assignmentID) && /^[a-zA-Z0-9._-]{1,120}$/.test(assignmentID), 'Invalid assignment ID');
      need(isAbsolute(packetPath), 'Use absolute packet path');
      const ctx = context(workspace, planPath, nonGitBaseline), packet = realpathSync(packetPath);
      need(statSync(packet).isFile() && inside(ctx.workspace, packet), 'Packet outside physical workspace');
      const task = readFileSync(packet, 'utf8');
      need(text(task), 'Empty assignment packet');
      const header = task.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
      const prefix = 'Code Duet packet: ';
      if (header.startsWith(prefix)) {
        let identity;
        try { identity = JSON.parse(header.slice(prefix.length)); } catch { throw new Error('Invalid packet identity header'); }
        need(identity && Object.keys(identity).length === 3 && identity.planPath === ctx.planPath &&
          identity.assignmentID === assignmentID && identity.kind === kind, 'Assignment packet belongs to a different plan, assignment or kind');
      } else need(!requirePacketIdentity, 'Desktop submission requires the exact Code Duet packet identity header');
      const start = locked(state => {
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        need(binding, 'No binding for this Codex chat');
        savedContext(binding, ctx);
        const transition = preparedTransition(stateRoot, binding);
        if (binding.phase !== 'PREPARING' || binding.assignmentID !== undefined && (transition?.kind ?? binding.nextAssignment) !== kind) {
          return { outcome: { ...summary(state, binding, 'rejected'),
            error: 'Previous assignment not accepted; no repeat submit', stateChange: 'unchanged', retried: false } };
        }
        if (binding.assignmentID === assignmentID) return { outcome: { ...summary(state, binding, 'rejected'),
          error: 'Use a fresh assignment ID after review', stateChange: 'unchanged', retried: false } };
        const plan = planCounter(state, ctx);
        if (plan.correctionCount >= 20) return { outcome: {
          ...summary(state, binding, 'correction-limit'), error: 'Twenty corrections reached; stop and select Code Duet again for a new cycle',
          stateChange: 'unchanged', retried: false } };
        checkoutAvailable(state, ctx, binding);
        return { ctx, state: structuredClone(state), closed: transition ?? readClosure(stateRoot, binding),
          expected: { ...structuredClone(binding), correctionCount: plan.correctionCount },
          lease: claimOwnership(state, ctx, binding, 'submit') };
      });
      if (start.outcome) return start.outcome;
      return withOwnership(start.lease, async () => {
        let prepared = preparedBinding(stateRoot, start.expected);
        const adoption = prepared.adoption;
        let priorBoundary = start.closed?.boundary ?? adoption;
        let priorReceipt, modelBaseline = fingerprint([]);
        if (start.closed) {
          const { boundary, receipt, history } = await checkedClosureBoundary(client, stateRoot, prepared, start.closed.disposition === 'accepted');
          need(sameBoundary(start.closed.boundary, boundary),
            'History changed since closure; no dispatch');
          priorReceipt = receipt;
          modelBaseline = history;
        } else if (start.expected.assignmentID) {
          const { boundary, receipt, history } = await reviewedResult(prepared);
          if (adoption) need(sameBoundary(adoption, boundary), 'Existing session changed since preparation; no dispatch');
          priorBoundary = boundary;
          priorReceipt = receipt;
          modelBaseline = history;
        } else if (adoption || prepared.reusedDelivery) {
          const { boundary: current, history } = await idleExisting(start.state, prepared);
          if (adoption) need(sameBoundary(adoption, current), 'Existing session changed since preparation; no dispatch');
          priorBoundary = current;
          modelBaseline = history;
        }
        let session = await sessionMatches(prepared);
        need(sessionAvailable(session), unavailableForDispatch);
        await noForms(start.expected);
        await idleWorkspace(start.state, ctx);
        await requireQuietShells(client, ctx);
        if (!priorBoundary || priorBoundary.lastMessageID === null) need(session.outcome === undefined && session.time?.idle === undefined,
          'Untracked history/status exists in the saved session');
        if (session.model.variant !== EXECUTOR_MODEL.variant) {
          const sessionRoute = '/api/session/' + session.id;
          const before = await client.request(sessionRoute + '/message?limit=1&order=desc');
          const priorID = priorBoundary?.lastMessageID ?? null;
          need(Array.isArray(before?.data) && before.data.length === (priorID === null ? 0 : 1) &&
            (before.data[0]?.id ?? null) === priorID, 'History changed before High selection');
          const reserved = commit(start.expected, (_state, binding) => {
            savePreparation(stateRoot, binding, { reusedDelivery: prepared.reusedDelivery, modelBaseline });
            binding.phase = 'STOPPED'; binding.uncertain = 'model';
            binding.intent = { head: priorID, variant: session.model.variant ?? null, idleAt: session.time?.idle ?? null, at: Date.now() };
          }).expected;
          let failed;
          try { await client.request(sessionRoute + '/model', { model: EXECUTOR_MODEL }); }
          catch (error) { failed = error; }
          if (failed?.diagnostic?.httpStatus === 400 && failed.diagnostic.errorCode === 'InvalidRequestError') {
            const unchangedSession = await sessionMatches(start.expected);
            const latest = await client.request(sessionRoute + '/message?limit=1&order=desc');
            if (isDeepStrictEqual(latest, before) && isDeepStrictEqual(unchangedSession.model, session.model)) {
              commit(reserved, (_state, binding) => {
                delete binding.uncertain; delete binding.intent;
                binding.phase = 'PREPARING';
              });
              throw failed;
            }
          }
          let confirmed;
          try { confirmed = await verifyModelChange(reserved, !!failed); }
          catch (error) { return stoppedOutcome(reserved, failed ?? error); }
          if (priorReceipt) {
            const messages = await assignmentMessages(client, start.expected);
            const { exchange } = deliveredBoundary(start.expected, messages, confirmed.session,
              !start.closed || start.closed.disposition === 'accepted');
            need(isDeepStrictEqual(reviewReceipt(stateRoot, start.expected, exchange), priorReceipt),
              'Delivered history changed during model selection; no dispatch');
          }
          await idleWorkspace(start.state, ctx);
          await requireQuietShells(client, ctx);
          start.expected = commit(reserved, (_state, binding) => {
            savePreparation(stateRoot, binding, { reusedDelivery: prepared.reusedDelivery, modelSelection: confirmed.proof });
            delete binding.uncertain; delete binding.intent;
            binding.phase = 'PREPARING';
          }).expected;
          prepared = { ...prepared, modelSelection: confirmed.proof };
          session = confirmed.session;
        }
        if (!priorBoundary || priorBoundary.lastMessageID === null) {
          const head = await client.request(`/api/session/${session.id}/message?limit=2&order=desc`);
          need(Array.isArray(head?.data) && head.data.length <= 1 &&
            !preparedHistory(prepared, head.data, session).messages.length, 'Untracked history/status exists in the saved session');
        }
        let reservationAttempted = false, reservationExpected, reserved;
        const prompt = 'Assignment ID: ' + assignmentID + '\nCanonical plan: ' + JSON.stringify(ctx.planPath) +
          '\nRead that plan; only the assignment below is authorized. Do not edit canonical plans/index/checkpoints, ' +
          'commit, push, merge, switch branches, delegate, broaden scope or execute unassigned blocks. Finish all edits ' +
          'and ordinary foreground checks before the final response. Do not detach project-changing work. Report any ' +
          'remaining background operations; a final response does not itself transfer ownership.\n\n' + task;
        try {
          reserved = commit(start.expected, (state, binding) => {
            checkoutAvailable(state, ctx, binding);
            const plan = planCounter(state, ctx);
            need(kind !== 'correction' || plan.correctionCount < 20, 'Twenty correction cycles exhausted; no cycle 21');
            if (kind === 'correction') plan.correctionCount++;
            if (binding.adoption) binding.adoption.variant = EXECUTOR_MODEL.variant;
            binding.assignmentID = assignmentID;
            binding.messageID = 'msg_' + randomUUID().replaceAll('-', '');
            binding.submittedAt = Date.now();
            binding.phase = 'STOPPED'; binding.uncertain = 'submit';
            binding.intent = { promptHash: createHash('sha256').update(prompt).digest('hex') };
            recordPrompt(stateRoot, binding);
            reservationExpected = { ...structuredClone(binding), correctionCount: plan.correctionCount };
            return summary(state, binding, 'submit-pending');
          }, () => { reservationAttempted = true; });
        } catch (error) {
          if (reservationAttempted) error.stateOutcome = unconfirmedOutcome(reservationExpected, error,
            'Submission intent unconfirmed; no prompt was sent');
          throw error;
        }
        let response;
        try {
          response = await client.request('/api/session/' + reserved.expected.sessionID + '/prompt', {
            id: reserved.expected.messageID, text: prompt,
          });
          need(response?.data?.id === reserved.expected.messageID && response.data.sessionID === reserved.expected.sessionID,
            'Submission identity uncertain; no retry');
        } catch (error) {
          error.stateOutcome = stoppedOutcome(reserved.expected, error, 'stopped');
          throw error;
        }
        try {
          return commit(reserved.expected, (state, binding) => {
            delete binding.uncertain; delete binding.intent; delete binding.nextAssignment; binding.phase = 'EXECUTING';
            return summary(state, binding, 'admitted');
          }).result;
        } catch (error) {
          error.stateOutcome = unconfirmedOutcome(reserved.expected, error,
            'Submission accepted; state transition unconfirmed, inspect the store');
          throw error;
        }
      });
    },
  };
}
