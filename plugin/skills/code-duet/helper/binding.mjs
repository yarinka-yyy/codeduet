import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MODEL, EXECUTOR_MODEL, requireValue as need, diagnose, diagnosticError, validateDiagnostic } from './connection.mjs';
import { assignmentMessages, recentSessionMessages, closureBoundary, completion, inspectMessages, interactive, validateAnswer, watch } from './interaction.mjs';
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
function bindFingerprint(state, binding) {
  if (!binding) return createHash('sha256').update('unbound').digest('hex');
  const { stopReason, diagnostic, ...pins } = binding;
  const counter = state.plans.find(plan => plan.planPath === binding.planPath)?.correctionCount;
  return createHash('sha256').update(JSON.stringify([pins, counter])).digest('hex');
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
    need(Object.keys(binding).every(key => ['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath', 'engineID', 'sessionID', 'phase', 'uncertain', 'assignmentID', 'messageID', 'submittedAt', 'pending', 'stopReason', 'nextAssignment', 'diagnostic', 'adoption'].includes(key)), 'Unexpected binding fields');
    if (binding.adoption !== undefined) {
      const value = binding.adoption;
      need(value && Object.keys(value).length === 3 &&
        (value.variant === null || text(value.variant) && value.variant.length <= 80) &&
        (value.lastMessageID === null && value.idleAt === null || text(value.lastMessageID) && value.lastMessageID.length <= 128 && Number.isSafeInteger(value.idleAt) && value.idleAt >= 0), 'Invalid adoption boundary');
    }
    if (binding.diagnostic !== undefined) { need(binding.phase === 'STOPPED', 'Diagnostic requires STOPPED'); validateDiagnostic(binding.diagnostic); }
    if (binding.nextAssignment !== undefined) need(['block', 'correction'].includes(binding.nextAssignment) && ['PREPARING', 'STOPPED'].includes(binding.phase), 'Invalid next assignment');
    if (binding.uncertain !== undefined) need(['create', 'submit', 'reply'].includes(binding.uncertain) && binding.phase === 'STOPPED', 'Invalid pending mutation');
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
    const bind = modern && owner.operation === 'bind' && isAbsolute(owner.planPath) &&
      text(owner.workspaceID) && text(owner.checkoutID) &&
      (owner.messageID === null || /^msg_[a-zA-Z0-9]+$/.test(owner.messageID)) &&
      (owner.nextFingerprint === undefined || fingerprintPattern.test(owner.nextFingerprint));
    const extra = observation ? ['process', 'messageID', 'fingerprint'] : bind ?
      ['process', 'messageID', 'fingerprint', 'nextFingerprint', 'planPath', 'workspaceID', 'checkoutID'] : [];
    if (!owner || !(owner.schema === 1 || observation || bind) || owner.token !== token || !text(owner.codexChat) ||
      !isAbsolute(owner.workspace) || !isAbsolute(owner.checkout) ||
      !(owner.sessionID === null || /^ses_[a-zA-Z0-9]+$/.test(owner.sessionID)) ||
      !(owner.assignmentID === null || text(owner.assignmentID)) ||
      !['bind', 'adopt', 'submit', 'wait', 'resume-watch', 'reply', 'next', 'finish'].includes(owner.operation) ||
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
function withPostgresRecovery(root, binding) {
  if (!/^msg_[a-zA-Z0-9]+$/.test(binding.messageID ?? '') || binding.phase === 'STOPPED') return binding;
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
  if (binding.adoption) need(Object.keys(session.model).every(key => ['providerID', 'id', 'variant'].includes(key)) &&
    (session.model.variant ?? null) === binding.adoption.variant, 'Adopted session model options changed');
  need(typeof session.location?.directory === 'string' && realpathSync(session.location.directory) === binding.workspace &&
    realpathSync(binding.workspace) === binding.workspace && realpathSync(binding.checkout) === binding.checkout &&
    identity(binding.workspace) === binding.workspaceID && identity(binding.checkout) === binding.checkoutID, 'Session physical directory mismatch');
  return session;
}

export async function observationSnapshot(client, binding) {
  const [session, active, forms, permissions] = await Promise.all([
    matchingSession(client, binding), client.request('/api/session/active'),
    client.request(`/api/session/${binding.sessionID}/form`), client.request(`/api/session/${binding.sessionID}/permission`),
  ]);
  need(active?.data && typeof active.data === 'object' && !Array.isArray(active.data) && Array.isArray(forms?.data) && Array.isArray(permissions?.data), 'Unknown execution/interactive status');
  const activity = active.data[binding.sessionID];
  need(activity === undefined || activity?.type === 'running' && Object.keys(activity).length === 1,
    'Unknown active execution status');
  for (const id of Object.keys(active.data)) {
    if (id === binding.sessionID) continue;
    need(/^ses_[a-zA-Z0-9]+$/.test(id), 'Unknown active session identity');
    const other = await client.request('/api/session/' + id);
    need(text(other?.data?.location?.directory) && !overlaps(binding.checkout, realpathSync(other.data.location.directory)), 'Another executor in this checkout; no ownership transfer');
  }
  return { session, active: active.data[binding.sessionID], forms: forms.data, permissions: permissions.data };
}

async function checkedClosureBoundary(client, stateRoot, binding, requireSuccess = false, verifyPriorPlan = false, invocationCheck) {
  const quiet = current => !current.active && !current.forms.length && !current.permissions.length;
  const current = await observationSnapshot(client, binding);
  if (invocationCheck?.lostCalls) {
    need(!current.active, 'Prior session is still active; no replacement');
    need(!current.forms.length, 'Prior session has pending forms; no replacement');
    need(!current.permissions.length, 'Prior session has pending permissions; no replacement');
  }
  need(quiet(current), 'Session is active or awaiting a reply; no closure or dispatch');
  need(!requireSuccess || current.session.outcome === 'succeeded', 'Acceptance requires confirmed successful execution');
  const shellRoute = '/api/shell?location[directory]=' + encodeURIComponent(binding.workspace);
  const messages = await assignmentMessages(client, binding);
  if (invocationCheck?.historyFingerprint) need(historyFingerprint(messages) === invocationCheck.historyFingerprint,
    'Prior delivery history differs from the legacy bind recovery receipt');
  if (verifyPriorPlan) need(messages[0].text.startsWith('Assignment ID: ' + binding.assignmentID + '\nCanonical plan: ' +
    JSON.stringify(binding.planPath) + '\n'), 'Prior plan was not confirmed in the current OpenCode history');
  const shells = await client.request(shellRoute);
  const boundary = closureBoundary(withShellEvidence(stateRoot, binding), messages, current.session, shells, invocationCheck);
  if (invocationCheck?.lostCalls) {
    const [latest, latestShells] = await Promise.all([assignmentMessages(client, binding), client.request(shellRoute)]);
    need(JSON.stringify(latest) === JSON.stringify(messages) && JSON.stringify(latestShells) === JSON.stringify(shells),
      'History or project shells changed during replacement verification');
  }
  const head = await client.request(`/api/session/${binding.sessionID}/message?limit=1&order=desc`);
  need(Array.isArray(head?.data) && head.data.length === 1 && head.data[0].id === boundary.lastMessageID,
    'History changed during closure verification');
  const confirmed = await observationSnapshot(client, binding);
  need(quiet(confirmed) && confirmed.session.outcome === current.session.outcome &&
    JSON.stringify(confirmed.session.time) === JSON.stringify(current.session.time) &&
    JSON.stringify(confirmed.session.model) === JSON.stringify(current.session.model), 'Session changed during closure verification');
  return boundary;
}

function checkTransitionSource(binding, ctx) {
  need(!binding.uncertain, 'Prior assignment mutation is uncertain; keep its owner');
  need(!binding.pending && binding.phase !== 'WAITING_FOR_ANSWER', 'Prior assignment is awaiting a reply; keep its owner');
  need(['EXECUTING', 'REVIEWING', 'STOPPED', 'FINISHED'].includes(binding.phase) && binding.sessionID &&
    binding.assignmentID && !binding.nextAssignment, 'No confirmed delivered assignment to transition');
  const source = observationContext(ctx.workspace, binding.planPath);
  need(['workspace', 'workspaceID', 'checkout', 'checkoutID'].every(key => source[key] === ctx[key] && source[key] === binding[key]) &&
    source.planPath === binding.planPath, 'Prior assignment workspace/plan identity changed');
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
          matchingSession(client, binding), client.request('/api/session/active'),
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
    add('state-transaction', 'blocked', 'A helper state transaction is present; wait and rerun, without removing the lock');
  } else if (state) add('state-transaction', 'pass', 'No short helper state transaction is present');

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
  const candidateBinding = savedBinding && savedBinding.sessionID === selectedSessionID ? savedBinding : undefined;
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
        ['wait', 'resume-watch'].includes(owner.operation) && overlaps(ctx.checkout, owner.checkout)).flatMap(owner => {
        const binding = state.bindings.find(item => item.codexChat === owner.codexChat &&
          item.sessionID === owner.sessionID && item.assignmentID === owner.assignmentID &&
          item.workspace === owner.workspace && item.checkout === owner.checkout && !item.uncertain);
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

  if (!client) {
    for (const name of ['session', 'session-model', 'session-directory', 'session-options', 'execution', 'forms', 'permissions', 'history', 'background']) {
      add(name, 'unknown', 'OpenCode is unavailable; this dependent check cannot be made',
        proposedRoute === 'new-bind' && ['session', 'session-model', 'session-directory', 'session-options', 'forms', 'permissions', 'history'].includes(name));
    }
  } else {
    const validSelectedID = typeof selectedSessionID === 'string' && /^ses_[a-zA-Z0-9]+$/.test(selectedSessionID);
    const probes = await Promise.all([
      capture(client.request('/api/session/active')),
      workspacePath ? capture(client.request('/api/shell?location[directory]=' + encodeURIComponent(workspacePath))) :
        Promise.resolve({ error: new Error('Workspace unavailable') }),
      validSelectedID ? capture(client.request('/api/session/' + selectedSessionID)) : Promise.resolve(null),
      validSelectedID ? capture(client.request('/api/session/' + selectedSessionID + '/form')) : Promise.resolve(null),
      validSelectedID ? capture(client.request('/api/session/' + selectedSessionID + '/permission')) : Promise.resolve(null),
      validSelectedID ? capture(candidateBinding?.assignmentID ?
        assignmentMessages(client, candidateBinding) : recentSessionMessages(client, selectedSessionID)) : Promise.resolve(null),
    ]);
    const [activeResult, shellsResult, sessionResult, formsResult, permissionsResult, historyResult] = probes;
    let liveSession;
    if (validSelectedID) {
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
          (!candidateBinding?.adoption || (model.variant ?? null) === candidateBinding.adoption.variant)) {
          add('session-options', 'pass', 'Candidate model options are supported and match any saved adoption boundary');
        } else add('session-options', 'blocked', 'Candidate model options are unsupported or changed from the saved boundary');
        if (liveSession.time && typeof liveSession.time === 'object' && liveSession.time.archived === undefined &&
          (liveSession.archived === undefined || liveSession.archived === false)) {
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
      else if (shellsResult.error || !Array.isArray(shellsResult.value?.data)) {
        add('history', 'unknown', 'Candidate history completion depends on known project shell status', false,
          diagnosticOf(shellsResult.error));
      } else {
        const shells = shellsResult.value;
        try {
          const messages = historyResult.value;
          need(Array.isArray(messages), 'Unknown candidate history');
          if (candidateBinding?.assignmentID) {
            const closed = preparedTransition(stateRoot, candidateBinding) ??
              (candidateBinding.phase === 'PREPARING' && candidateBinding.nextAssignment === 'correction' &&
                readClosure(stateRoot, candidateBinding));
            const boundHistory = withShellEvidence(stateRoot, candidateBinding);
            if (closed) need(sameBoundary(closed.boundary, closureBoundary(boundHistory, messages, liveSession, shells)),
              'History changed since closure; no dispatch');
            else {
              const history = inspectMessages(boundHistory, messages);
              need(!history.kind, 'Saved assignment history failed or was interrupted');
              if (['FINISHED', 'REVIEWING'].includes(candidateBinding.phase) ||
                candidateBinding.phase === 'PREPARING' && candidateBinding.nextAssignment) completion(history, liveSession, shells);
              if (candidateBinding.phase === 'PREPARING' && candidateBinding.nextAssignment && candidateBinding.adoption) {
                need(candidateBinding.adoption.lastMessageID === (messages.at(-1)?.id ?? null) &&
                  candidateBinding.adoption.idleAt === (liveSession.time?.idle ?? null) &&
                  candidateBinding.adoption.variant === (liveSession.model?.variant ?? null), 'Saved history boundary changed');
              }
            }
          } else if (candidateBinding?.adoption) {
            if (messages.length) {
              need(liveSession.outcome === 'succeeded', 'Existing history outcome is not confirmed successful');
              const history = inspectMessages({ workspace: ctx.workspace, messageID: messages[0].id }, messages, { adopting: true });
              need(!history.kind, 'Existing history failed or was interrupted');
              completion(history, liveSession, shells);
            } else need(liveSession.outcome === undefined && liveSession.time?.idle === undefined, 'Existing history/status mismatch');
            need(candidateBinding.adoption.variant === (liveSession.model?.variant ?? null) &&
              candidateBinding.adoption.lastMessageID === (messages.at(-1)?.id ?? null) &&
              candidateBinding.adoption.idleAt === (liveSession.time?.idle ?? null), 'Saved adoption boundary changed');
          } else if (candidateBinding) {
            need(!messages.length && liveSession.outcome === undefined && liveSession.time?.idle === undefined,
              'Untracked history/status exists in the saved session');
          } else if (messages.length) {
            need(liveSession.outcome === 'succeeded', 'Existing history outcome is not confirmed successful');
            const history = inspectMessages({ workspace: ctx.workspace, messageID: messages[0].id }, messages, { adopting: true });
            need(!history.kind, 'Existing history failed or was interrupted');
            completion(history, liveSession, shells);
          } else need(liveSession.outcome === undefined && liveSession.time?.idle === undefined, 'Existing history/status mismatch');
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
    else if (!activeResult.value?.data || typeof activeResult.value.data !== 'object' || Array.isArray(activeResult.value.data)) {
      add('execution', 'unknown', 'Engine execution status shape is unknown');
    } else {
      const active = activeResult.value.data;
      let activeUnknown = false, activeBlocker = false, otherCheckoutBlocker = false, activeDiagnostic;
      for (const [id, status] of Object.entries(active)) {
        if (!/^ses_[a-zA-Z0-9]+$/.test(id) || status?.type !== 'running') { activeUnknown = true; continue; }
        if (id === selectedSessionID) activeBlocker = true;
        else if (ctx) {
          const otherResult = await capture(client.request('/api/session/' + id));
          if (otherResult.error || !text(otherResult.value?.data?.location?.directory)) {
            activeUnknown = true; activeDiagnostic ??= diagnosticOf(otherResult.error); continue;
          }
          try { if (overlaps(ctx.checkout, realpathSync(otherResult.value.data.location.directory))) otherCheckoutBlocker = true; }
          catch { activeUnknown = true; }
        }
      }
      add('execution', activeBlocker || otherCheckoutBlocker ? 'blocked' : activeUnknown ? 'unknown' : 'pass',
        activeBlocker ? 'Selected session is running' : otherCheckoutBlocker ?
          'Another active OpenCode session is in this checkout' : activeUnknown ?
            'One or more active session identities/statuses are unknown' : 'No active OpenCode session in this checkout',
        false, activeDiagnostic);
    }

    if (shellsResult.error) add('background', errorStatus(shellsResult.error), 'Project shell lookup failed: ' + errorReason(shellsResult.error),
      false, diagnosticOf(shellsResult.error));
    else if (!Array.isArray(shellsResult.value?.data) || !shellsResult.value.data.every(shell =>
      ['running', 'exited', 'timeout', 'killed'].includes(shell.status) &&
      (shell.status === 'running' || Number.isFinite(shell.time?.completed)))) {
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
        checkTransitionSource(prior, ctx);
        need(checks.some(item => item.name === 'ownership' && item.status === 'pass'), 'Checkout lease is active or unknown');
        need(!readClosure(stateRoot, prior), 'Prior closure is staged; resolve it before a transition');
        const engineChanged = prior.engineID !== client.engineID;
        await checkedClosureBoundary(client, stateRoot, { ...prior, adoption: undefined }, false, engineChanged);
        transition = { ...evidence, status: 'ready', command: 'transition', args: [workspacePath, planRealPath, prior.messageID],
          engineChanged, options: nonGitArgs, dispositions: [...(['REVIEWING', 'FINISHED'].includes(prior.phase) ? ['accepted'] : []),
            'blocked', 'without-acceptance'] };
      } catch (error) {
        transition = { ...evidence, status: 'blocked', reason: errorReason(error) };
      }
    }
  }
  let nextStep, nextCommand = null;
  if (!connected && connectionDiagnostic?.category === 'engine-version') nextStep =
    'OpenCode version mismatch: expected ' + connectionDiagnostic.expectedVersions.join(' or ') + ', observed ' +
    connectionDiagnostic.observedVersion + ' (' + connectionDiagnostic.versionSource +
    '). Use a validated matching engine/helper or revalidate API compatibility before rerunning preflight; no task was sent.';
  else if (!connected) nextStep = 'Restore the OpenCode connection and rerun preflight; this call sent no task.';
  else if (blockers.length && permanentRequest) {
    const diagnostic = permanentRequest.diagnostic;
    const operation = [diagnostic.method, diagnostic.operation].filter(Boolean).join(' ');
    const page = diagnostic.page ? ' (' + diagnostic.page + ' page)' : '';
    nextStep = 'OpenCode permanently rejected ' + (operation || 'the listed API request') + page +
      ' with HTTP ' + diagnostic.httpStatus + (diagnostic.errorCode ? ' (' + diagnostic.errorCode + ')' : '') +
      '. Do not retry the unchanged request. Check and correct this API request/cursor before rerunning preflight; no task was sent.';
  }
  else if (transition?.status === 'ready') nextStep =
    'Resolve the prior review or record the owner’s explicit decision to leave it without acceptance. For authorized next work run transition with that disposition, then rerun preflight.';
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
    ...(transition ? { transition } : {}),
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

export function withStateLock(stateRoot, operation) {
  const statePath = join(stateRoot, 'state.json');
    try { mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); }
    catch (error) { throw stateFailure(error, 'state-directory'); }
    const lockPath = join(stateRoot, 'state.lock');
    let lock, result, primary, releaseError, lastLockError;
    const token = randomUUID();
    const lockDeadline = performance.now() + 120;
    for (let attempt = 0; attempt < 7; attempt++) {
      if (attempt > 0 && performance.now() >= lockDeadline) break;
      try { lock = openSync(lockPath, 'wx', 0o600); break; }
      catch (error) {
        lastLockError = error;
        if (error?.code !== 'EEXIST' || attempt >= 6 || performance.now() >= lockDeadline) throw stateFailure(error, 'state-lock');
        // Wait briefly for a synchronous state transaction; never remove a foreign/crashed lock.
        Atomics.wait(stateLockWait, 0, 0, Math.max(1, Math.min(1, lockDeadline - performance.now())));
      }
    }
    if (lock === undefined) throw stateFailure(lastLockError, 'state-lock');
    try {
      writeFileSync(lock, token);
      result = operation(readState(statePath));
      need(!result || typeof result.then !== 'function', 'State lock cannot cover asynchronous work');
    } catch (error) { primary = error; }
    let owned = false;
    try { owned = readFileSync(lockPath, 'utf8') === token; }
    catch (error) { releaseError = error; }
    try { closeSync(lock); }
    catch (error) { releaseError ??= error; }
    if (owned && !releaseError) {
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

// Lifecycle cleanup runs only when explicitly invoked before a task; state.lock
// also serializes its journal with every existing helper writer.
export function maintainTasks(workspace, planPath, { stateRoot = resolve(homedir(), '.local/state/code-duet'), now = Date.now() } = {}) {
  need(Number.isSafeInteger(now) && now >= 0, 'Invalid maintenance time');
  const ctx = observationContext(workspace, planPath);
  const ledgerPath = join(stateRoot, 'task-lifecycle.json'), statePath = join(stateRoot, 'state.json');
  const period = 30 * 24 * 60 * 60 * 1000;
  return withStateLock(stateRoot, state => {
    let ledger = { schema: 1, entries: [] };
    if (existsSync(ledgerPath)) {
      ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      need(ledger?.schema === 1 && Array.isArray(ledger.entries) && Object.keys(ledger).length === 2,
        'Invalid task lifecycle journal');
    }
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
      validateState({ schema: 1, bindings: [], plans: [entry.plan] });
      seen.add(entry.planPath);
    }
    const owners = readOwnerships(join(stateRoot, 'ownership'));
    need(!owners.invalid, 'Cannot maintain tasks while ownership is invalid');
    const observerRoot = join(stateRoot, 'observers');
    const externalObserver = existsSync(observerRoot) && readdirSync(observerRoot).some(name => name.startsWith('external-'));
    const inUse = plan => {
      if (externalObserver) return true;
      const bindings = state.bindings.filter(item => item.planPath === plan.planPath);
      if (bindings.some(item => item.phase !== 'FINISHED' || item.uncertain || item.nextAssignment)) return true;
      if (owners.owners.some(owner => overlaps(plan.workspace, owner.checkout))) return true;
      return bindings.some(binding => existsSync(join(stateRoot, 'observers',
        createHash('sha256').update(binding.codexChat).digest('hex'), 'active')));
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

function observerPresent(stateRoot) {
  const observers = join(stateRoot, 'observers');
  return existsSync(observers) && readdirSync(observers, { withFileTypes: true }).some(entry =>
    entry.name.startsWith('external-') || entry.isDirectory() && existsSync(join(observers, entry.name, 'active')));
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
    need(!observerPresent(stateRoot), 'An observer is active or uncertain; no counter reset');
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
  let observingProcess;
  function ownerships() {
    const result = readOwnerships(ownershipRoot);
    if (result.invalid) throw ownershipError();
    return result.owners;
  }
  function claimOwnership(state, ctx, binding, operation, bindProcess) {
    for (const owner of ownerships()) if (overlaps(ctx.checkout, owner.checkout)) throw ownershipError();
    try { mkdirSync(ownershipRoot, { recursive: true, mode: 0o700 }); }
    catch (error) { throw stateFailure(error, 'state-directory'); }
    const token = randomUUID(), path = join(ownershipRoot, 'owner-' + token + '.lock');
    const value = { schema: 1, token, codexChat: chatID, workspace: ctx.workspace, checkout: ctx.checkout,
      sessionID: binding?.sessionID ?? null, assignmentID: binding?.assignmentID ?? null, operation };
    if (['wait', 'resume-watch'].includes(operation)) Object.assign(value,
      { schema: 2, process: observingProcess, messageID: binding.messageID,
        fingerprint: observationFingerprint(binding, planCounter(state, binding).correctionCount) });
    if (operation === 'bind') Object.assign(value, { schema: 2, process: bindProcess, planPath: ctx.planPath,
      workspaceID: ctx.workspaceID, checkoutID: ctx.checkoutID, messageID: binding?.messageID ?? null,
      fingerprint: bindFingerprint(state, binding) });
    let handle;
    try {
      handle = openSync(path, 'wx', 0o600);
      writeFileSync(handle, JSON.stringify(value));
      closeSync(handle);
      handle = undefined;
    } catch (error) {
      if (handle !== undefined) { try { closeSync(handle); } catch {} }
      throw stateFailure(error, 'state-lock');
    }
    return { path, token };
  }
  function pinBindSave(lease, state, binding) {
    const { path, ...owner } = ownerships().find(item => item.token === lease.token) ?? {};
    const saved = readState(statePath);
    const fingerprint = bindFingerprint(saved, saved.bindings.find(item => item.codexChat === chatID));
    need(path === lease.path && owner.operation === 'bind' && owner.schema === 2 && owner.codexChat === chatID &&
      [owner.fingerprint, owner.nextFingerprint].includes(fingerprint), 'Bind ownership or saved binding changed');
    // Record both sides before the state save, so a crash at either side leaves a verifiable pin.
    try { saveJSON(path, { ...owner, fingerprint, nextFingerprint: bindFingerprint(state, binding) }, stateRoot); }
    catch (error) { throw stateFailure(error, 'state-write'); }
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
    try { result = await operation(); }
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
    const active = await client.request('/api/session/active');
    need(active?.data && typeof active.data === 'object' && !Array.isArray(active.data), 'Unknown engine execution status');
    for (const [sessionID, status] of Object.entries(active.data)) {
      need(/^ses_[a-zA-Z0-9]+$/.test(sessionID) && status && typeof status.type === 'string', 'Invalid active session status');
      const response = await client.request('/api/session/' + sessionID);
      need(response?.data?.id === sessionID && text(response.data.location?.directory), 'Unknown active session identity');
      const directory = realpathSync(response.data.location.directory);
      need(!overlaps(ctx.checkout, directory), 'Active executor in this physical checkout');
    }
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
    saveState(statePath, state);
    return { ...summary(state, binding, kind), error: reason, executorStopped: false, retried: false, stateChange: 'saved' };
  }
  const bindingFields = ['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath',
    'engineID', 'sessionID', 'assignmentID', 'messageID', 'submittedAt', 'phase', 'uncertain'];
  function unchanged(current, expected, state) {
    return !!current && bindingFields.every(key => current[key] === expected[key]) &&
      planCounter(state, current).correctionCount === expected.correctionCount &&
      JSON.stringify(current.pending ?? null) === JSON.stringify(expected.pending ?? null) &&
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
      saveState(statePath, state);
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
    const history = inspectMessages(withShellEvidence(stateRoot, binding), await assignmentMessages(client, binding));
    need(!history.kind, 'Failed/interrupted assignment cannot be released');
    const shells = await client.request('/api/shell?location[directory]=' + encodeURIComponent(binding.workspace));
    completion(history, current.session, shells, invocationCheck);
    const confirmed = await snapshot(binding);
    need(!confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
      JSON.stringify(confirmed.session.time) === JSON.stringify(current.session.time), 'Execution changed during review transition');
    return { lastMessageID: history.idle.id, idleAt: current.session.time.idle };
  }
  async function idleExisting(state, binding) {
    await idleWorkspace(state, binding);
    const current = await snapshot(binding), session = current.session;
    need(!current.active && !current.forms.length && !current.permissions.length, 'Existing session busy or interactive');
    need(session.time && typeof session.time === 'object' && session.time.archived === undefined &&
      (session.archived === undefined || session.archived === false), 'Archived/unknown existing session');
    need(Object.keys(session.model).every(key => ['providerID', 'id', 'variant'].includes(key)) &&
      (session.model.variant === undefined || text(session.model.variant) && session.model.variant.length <= 80), 'Unsupported existing model options');
    const messages = await recentSessionMessages(client, binding.sessionID);
    const shells = await client.request('/api/shell?location[directory]=' + encodeURIComponent(binding.workspace));
    need(Array.isArray(shells?.data) && shells.data.every(shell => ['exited', 'timeout', 'killed'].includes(shell.status) &&
      Number.isFinite(shell.time?.completed)), 'Project shell still running or unknown');
    if (messages.length) {
      need(session.outcome === 'succeeded', 'Existing session outcome is not confirmed successful');
      const previous = messages[0].id === binding.messageID ? withShellEvidence(stateRoot, binding) :
        { workspace: binding.workspace, messageID: messages[0].id };
      const history = inspectMessages(previous, messages, { adopting: true });
      need(!history.kind, 'Existing session failed/interrupted; no automatic recovery');
      completion(history, session, shells);
    } else need(session.outcome === undefined && session.time.idle === undefined, 'Existing history/status mismatch');
    const lastMessageID = messages.at(-1)?.id ?? null;
    const head = await client.request(`/api/session/${binding.sessionID}/message?limit=1&order=desc`);
    need(Array.isArray(head?.data) && head.data.length === (lastMessageID === null ? 0 : 1) &&
      (head.data[0]?.id ?? null) === lastMessageID, 'Existing history changed during inspection');
    const confirmed = await snapshot(binding);
    need(!confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
      JSON.stringify(confirmed.session.time) === JSON.stringify(session.time) &&
      JSON.stringify(confirmed.session.model) === JSON.stringify(session.model), 'Existing session changed during inspection');
    await idleWorkspace(state, binding);
    return { variant: session.model.variant ?? null, lastMessageID, idleAt: session.time.idle ?? null };
  }
  return {
    statePath,
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
      if (selectedOwner?.operation === 'bind') {
        const legacy = selectedOwner.schema === 1;
        function selectBind(state) {
          const owners = ownerships();
          const owner = owners.find(item => item.token === token);
          need(owner?.operation === 'bind' && owner.schema === selectedOwner.schema && owner.codexChat === chatID &&
            owner.workspace === ctx.workspace && owner.checkout === ctx.checkout, 'Bind lease is missing or belongs to another chat or checkout');
          need(owners.filter(item => overlaps(ctx.checkout, item.checkout)).length === 1,
            'Another operation owns this checkout');
          const binding = state.bindings.find(item => item.codexChat === chatID);
          const fingerprint = bindFingerprint(state, binding);
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
            [owner.fingerprint, owner.nextFingerprint].includes(fingerprint), 'Bind lease pins or saved binding changed');
          return { owner, binding, fingerprint, counter };
        }
        const selected = selectBind(readState(statePath)), { owner, binding, counter } = selected;
        const proof = legacy ? { status: 'unknown', reason: 'legacy-bind-needs-local-reboot-proof' } :
          owner.process.start ? ownerLiveness(owner.process, probeOwner) : { status: 'unknown', reason: 'process-start-unavailable' };
        const legacyBind = legacy && binding.phase === 'FINISHED' && binding.messageID && !binding.pending ? {
          explanation: 'This lease has no PID or process start time. Windows must confirm a restart after the lease was written.',
          steps: [
            ['ownership', workspace, planPath, token, '--action', 'recover-legacy-bind'],
            ['replace-finished-session', workspace, planPath, binding.messageID, '--session', binding.sessionID,
              '--lost-powershell-calls', '<comma-separated-call-ids>', '--recovered-bind', token],
            ['preflight', workspace, planPath, '--session', '<new-session-id>'],
          ].map(args => nonGitBaseline ? [...args, '--non-git-baseline', nonGitBaseline] : args),
        } : undefined;
        const result = { kind: 'ownership-status', token, operation: 'bind', ownerStatus: proof.status, reason: proof.reason,
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
            need(!observerPresent(stateRoot), 'An observer is active or uncertain; no legacy bind recovery');
            checkoutAvailable(state, ctx, current.binding);
          };
          checkLocal(readState(statePath));
          const quiet = async () => {
            const snapshot = await observationSnapshot(client, binding);
            need(!snapshot.active && !snapshot.forms.length && !snapshot.permissions.length && snapshot.session.outcome === 'succeeded' &&
              Number.isFinite(snapshot.session.time?.idle),
              'Prior session is active, awaiting a reply or missing a successful outcome');
            const shells = await client.request('/api/shell?location[directory]=' + encodeURIComponent(ctx.workspace));
            need(Array.isArray(shells?.data) && shells.data.every(shell =>
              ['exited', 'timeout', 'killed'].includes(shell.status) && Number.isFinite(shell.time?.completed)),
            'Project shell is running or unknown');
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
        return { ...result, kind: 'bind-ownership-released', leaseArchived: true };
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
          const boundary = await reviewedResult(begun.expected, { verified });
          return commit(begun.expected, (state, binding) => {
            saveInvocationProofs(stateRoot, binding, verified);
            if (binding.adoption) Object.assign(binding.adoption, boundary);
            binding.nextAssignment = kind; binding.phase = 'PREPARING';
            return summary(state, binding, 'prepared');
          }).result;
        } catch (error) { return stoppedOutcome(begun.expected, error); }
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
          await reviewedResult(begun.expected, { verified, archive });
          return commit(begun.expected, (state, binding) => {
            saveInvocationProofs(stateRoot, binding, verified);
            binding.phase = 'FINISHED';
            return summary(state, binding, 'released');
          }).result;
        } catch (error) { return archive ? rejectedOutcome(begun.expected, error) : stoppedOutcome(begun.expected, error); }
      });
    },
    async transition(workspace, planPath, messageID, disposition, { kind, nonGitBaseline, connectionError } = {}) {
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
        checkTransitionSource(binding, ctx);
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
          assignmentKind, lease: claimOwnership(state, ctx, binding, 'finish') };
      });
      if (start.outcome) return start.outcome;
      return withOwnership(start.lease, async () => {
        const boundary = await checkedClosureBoundary(client, stateRoot, { ...start.source, adoption: undefined },
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
            // Keep the source before moving ownership. A staged retry must verify the live boundary again.
            saveJSON(path, receipt);
            Object.assign(binding, { codexChat: chatID, planPath: ctx.planPath, engineID: client.engineID, phase: 'PREPARING' });
            delete binding.stopReason; delete binding.diagnostic;
            if (binding.adoption) Object.assign(binding.adoption, boundary);
            if (receipt.kind !== 'initial') binding.nextAssignment = receipt.kind;
            saving = true;
            saveState(statePath, state);
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
          lease: claimOwnership(state, ctx, binding, 'next') };
      });
      if (start.outcome) return start.outcome;
      return withOwnership(start.lease, async () => {
        const expected = start.expected;
        const boundary = await checkedClosureBoundary(client, stateRoot, { ...expected, adoption: undefined });
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
    async connectionLost(error) {
      return locked(state => {
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        if (!binding) return null;
        if (binding.phase === 'STOPPED') return { ...summary(state, binding, 'stopped'),
          error: binding.stopReason || 'Prior mutation uncertain; explicit continuation required',
          executorStopped: false, retried: false, stateChange: 'unchanged', ...(binding.diagnostic ? { diagnostic: binding.diagnostic } : {}) };
        const diagnostic = error?.diagnostic ? validateDiagnostic(error.diagnostic) : diagnose(error, 'unknown', 'connection');
        const retried = !!error?.bootstrap?.retried;
        if (['PREPARING', 'FINISHED'].includes(binding.phase)) return { ...summary(state, binding, 'connection-unavailable'),
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
      observingProcess = processOwner(); // Capture outside the short state transaction.
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
          stream = await watch(client, expected.sessionID, combined, expected.workspace);
          let history, messages;
          while (true) {
            locked(state => need(unchanged(state.bindings.find(binding => binding.codexChat === chatID), expected, state),
              'Saved assignment/count changed during wait; no stale state write'));
            if (signal.aborted) return stopWait('interrupted', 'Advisor wait interrupted; executor termination unconfirmed',
              diagnose(null, 'interrupted', 'wait', stream.observation));
            if (deadline.aborted) return stopWait('connection-uncertain', 'Wait deadline reached; executor termination unconfirmed',
              diagnose(null, 'deadline', 'wait', stream.observation));
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
              history = inspectMessages(postgresRecovery ? { ...boundHistory, postgresRecovery } : boundHistory, messages);
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
              return { ...stopWait(failure, 'Bound assignment failed/interrupted; inspect its session'), ...progress };
            }
            const pending = current.permissions.length ? ['permission', current.permissions[0]] :
              current.forms.length ? ['question', current.forms[0]] : null;
            if (pending) {
              const result = interactive(...pending, expected, history);
              const saved = record((state, binding) => {
                binding.phase = 'WAITING_FOR_ANSWER';
                binding.pending = { kind: result.kind, id: result.request.id, fingerprint: result.fingerprint };
              }, result.kind);
              return { ...saved, ...progress, request: result.request, fingerprint: result.fingerprint };
            }
            if (expected.pending && expected.phase !== 'STOPPED') record((state, binding) => {
              delete binding.pending; binding.phase = 'EXECUTING';
            }, 'observing');
            if (!current.active && current.session.time?.idle >= expected.submittedAt) {
              need(current.session.outcome === 'succeeded', 'Unknown terminal outcome');
              const shells = await client.request('/api/shell?location[directory]=' + encodeURIComponent(expected.workspace));
              const result = completion(history, current.session, shells);
              const confirmed = await snapshot(expected);
              need(!confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
                JSON.stringify(confirmed.session.time) === JSON.stringify(current.session.time), 'Execution changed during completion confirmation');
              if (postgresRecovery) {
                const [latest, latestShells] = await Promise.all([assignmentMessages(client, expected),
                  client.request('/api/shell?location[directory]=' + encodeURIComponent(expected.workspace))]);
                need(JSON.stringify(latest) === JSON.stringify(messages) && JSON.stringify(latestShells) === JSON.stringify(shells),
                  'History or project shells changed during PostgreSQL recovery');
              }
              if (stream.fault || combined.aborted) continue;
              return { ...record((state, binding) => {
                delete binding.pending; binding.phase = 'REVIEWING';
                if (postgresRecovery) {
                  const path = postgresPath(stateRoot, binding.messageID);
                  const receipt = { owner: deliveryFingerprint(binding), evidence: postgresRecovery, timeline: result.result.postgresRecovery };
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
          need(expected.pending.fingerprint === verified.fingerprint, 'Pending request changed; no reply');
          const latest = await client.request('/api/session/' + expected.sessionID + (kind === 'question' ? '/form' : '/permission'));
          need(Array.isArray(latest?.data), 'Unknown pending status before reply');
          const stillPending = latest.data.find(item => item.id === requestID);
          if (!stillPending) return commit(expected, (state, binding) => {
            delete binding.pending; binding.phase = 'EXECUTING';
            return summary(state, binding, 'stale-request');
          }).result;
          need(interactive(kind, stillPending, expected, history).fingerprint === verified.fingerprint,
            'Request changed before reply; no mutation');
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
          if (kind === 'permission' && payload.decision === 'reject') return commit(reserved.expected, (state, binding) => {
            delete binding.uncertain; delete binding.pending;
            binding.phase = 'STOPPED'; binding.stopReason = 'Permission rejected; coordination stopped, executor termination unconfirmed';
            return summary(state, binding, 'permission-rejected');
          }).result;
          return commit(reserved.expected, (state, binding) => {
            delete binding.uncertain; delete binding.pending; binding.phase = 'EXECUTING';
            return summary(state, binding, 'replied');
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
                const current = await idleExisting(start.state, start.expected);
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
            binding.adoption = await idleExisting(start.state, binding);
            return locked(state => {
              need(!state.bindings.some(item => item.codexChat === chatID), 'Binding appeared during adoption; no takeover');
              need(!state.bindings.some(item => item.engineID === client.engineID && item.sessionID === sessionID),
                'Session became bound to another Codex chat; no takeover');
              checkoutAvailable(state, start.ctx);
              planCounter(state, start.ctx, importedCount);
              state.bindings.push(binding);
              saving = true;
              saveState(statePath, state);
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
        Array.isArray(replacement.lostCalls) && replacement.lostCalls.length > 0 && replacement.lostCalls.length <= 32 &&
        replacement.lostCalls.every(id => /^call_[a-zA-Z0-9_]{1,120}$/.test(id)) &&
        new Set(replacement.lostCalls).size === replacement.lostCalls.length &&
        (replacement.recoveredBind === undefined || leaseTokenPattern.test(replacement.recoveredBind)),
      'Use exact prior session, delivery, PowerShell call IDs and legacy bind token');
      need(importedCount === undefined || Number.isInteger(importedCount) && importedCount >= 0 && importedCount <= 20,
        'Invalid imported correction count');
      const bindProcess = processOwner();
      need(validProcessOwner(bindProcess) && bindProcess.start, 'Cannot verify the bind owner process identity; no lease was created');
      const start = locked(state => {
        const existing = state.bindings.find(binding => binding.codexChat === chatID);
        planCounter(state, ctx, importedCount);
        if (replacement) {
          need(existing?.phase === 'FINISHED' && existing.assignmentID && existing.sessionID === replacement.sessionID &&
            existing.messageID === replacement.messageID, 'Only the exact FINISHED delivery in this chat can be replaced');
          const verifiedHistory = replacement.recoveredBind && legacyBindProof(replacement.recoveredBind, state, existing);
          savedContext(verifiedHistory ? { ...existing, engineID: client.engineID } : existing, ctx);
          need(!readClosure(stateRoot, existing) && !readTransition(stateRoot, existing.messageID), 'Another closure or transition already exists');
          need(!observerPresent(stateRoot), 'An observer is active or uncertain; no replacement');
          checkoutAvailable(state, ctx, existing);
          return { ctx, state: structuredClone(state), source: structuredClone(existing), verifiedHistory,
            correctionCount: planCounter(state, existing).correctionCount,
            lease: claimOwnership(state, ctx, existing, 'bind', bindProcess) };
        }
        if (existing) {
          if (existing.planPath !== ctx.planPath) {
            savedContext({ ...existing, planPath: ctx.planPath }, ctx);
            need(existing.phase === 'FINISHED', 'Previous plan assignment not released; no plan switch');
            checkoutAvailable(state, ctx, existing);
            return { ctx, state: structuredClone(state), expected: { ...structuredClone(existing),
              correctionCount: state.plans.find(plan => plan.planPath === existing.planPath).correctionCount },
              lease: claimOwnership(state, ctx, existing, 'bind', bindProcess), planSwitch: true };
          }
          savedContext(existing, ctx);
          checkoutAvailable(state, ctx, existing);
          return { ctx, state: structuredClone(state), expected: { ...structuredClone(existing),
            correctionCount: planCounter(state, ctx).correctionCount },
            lease: claimOwnership(state, ctx, existing, 'bind', bindProcess), planSwitch: false };
        }
        checkoutAvailable(state, ctx);
        return { ctx, state: structuredClone(state), lease: claimOwnership(state, ctx, null, 'bind', bindProcess), planSwitch: false };
      });
      return withOwnership(start.lease, async () => {
        if (start.expected && !start.planSwitch) {
          try {
            await sessionMatches(start.expected);
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
            const boundary = await reviewedResult(start.expected);
            return commit(start.expected, (state, binding) => {
              if (binding.adoption) Object.assign(binding.adoption, boundary);
              planCounter(state, ctx, importedCount);
              binding.planPath = ctx.planPath; binding.phase = 'PREPARING';
              for (const key of ['assignmentID', 'messageID', 'submittedAt', 'nextAssignment']) delete binding[key];
              pinBindSave(start.lease, state, binding);
              return summary(state, binding, 'reused-plan');
            }).result;
          } catch (error) { return stoppedOutcome(start.expected, error, 'connection-uncertain'); }
        }
        let archive;
        if (start.source) {
          const gaps = [], lostCalls = new Set(replacement.lostCalls);
          const boundary = await checkedClosureBoundary(client, stateRoot, start.source, true, !!start.verifiedHistory,
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
              need(!observerPresent(stateRoot), 'An observer is active or uncertain; no replacement');
            } else need(!current, 'Binding appeared during create preparation');
            checkoutAvailable(state, ctx, current);
            const plan = planCounter(state, ctx, importedCount);
            const binding = { codexChat: chatID, ...ctx, engineID: client.engineID,
              sessionID: null, phase: 'STOPPED', uncertain: 'create' };
            if (archive) {
              const path = join(stateRoot, 'finished-session-replacements', start.source.messageID + '.json');
              mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
              if (existsSync(path)) need(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(archive),
                'A different replacement record already exists');
              else saveJSON(path, archive);
              state.bindings[state.bindings.indexOf(current)] = binding;
            } else state.bindings.push(binding);
            pinBindSave(start.lease, state, binding);
            reservationExpected = { ...structuredClone(binding), correctionCount: plan.correctionCount };
            reservationAttempted = true;
            saveState(statePath, state);
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
            title: 'Code Duet: ' + basename(ctx.workspace), location: { directory: ctx.workspace }, model: EXECUTOR_MODEL,
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
            pinBindSave(start.lease, state, binding);
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
            delete binding.uncertain; binding.phase = 'PREPARING';
            pinBindSave(start.lease, state, binding);
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
    async submit(workspace, planPath, assignmentID, packetPath, nonGitBaseline, kind = 'initial') {
      need(['initial', 'block', 'correction'].includes(kind), 'Invalid assignment kind');
      need(text(assignmentID) && /^[a-zA-Z0-9._-]{1,120}$/.test(assignmentID), 'Invalid assignment ID');
      need(isAbsolute(packetPath), 'Use absolute packet path');
      const ctx = context(workspace, planPath, nonGitBaseline), packet = realpathSync(packetPath);
      need(statSync(packet).isFile() && inside(ctx.workspace, packet), 'Packet outside physical workspace');
      const task = readFileSync(packet, 'utf8');
      need(text(task), 'Empty assignment packet');
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
        const adoption = start.expected.adoption;
        if (start.closed) {
          need(sameBoundary(start.closed.boundary, await checkedClosureBoundary(client, stateRoot, start.expected)),
            'History changed since closure; no dispatch');
        } else if (adoption) {
          const current = await idleExisting(start.state, start.expected);
          need(['variant', 'lastMessageID', 'idleAt'].every(key => current[key] === adoption[key]),
            'Existing session changed since preparation; no dispatch');
        } else if (start.expected.assignmentID) await reviewedResult(start.expected);
        const session = await sessionMatches(start.expected);
        await noForms(start.expected);
        await idleWorkspace(start.state, ctx);
        if (session.model.variant !== EXECUTOR_MODEL.variant) {
          const sessionRoute = '/api/session/' + session.id;
          await client.request(sessionRoute + '/model', { model: EXECUTOR_MODEL });
          const expected = adoption ? { ...start.expected, adoption: { ...adoption, variant: EXECUTOR_MODEL.variant } } : start.expected;
          const confirmed = await snapshot(expected);
          need(confirmed.session.model.variant === EXECUTOR_MODEL.variant, 'OpenCode did not select High; no dispatch');
          need(!confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
            confirmed.session.time?.idle === session.time?.idle, 'Session activity changed during model selection; no dispatch');
          const boundary = start.closed?.boundary ?? adoption;
          if (boundary) {
            const page = await client.request(sessionRoute + '/message?limit=2&order=desc');
            const [head, prior] = Array.isArray(page?.data) ? page.data : [false];
            const sameHead = head !== false && (head?.id ?? null) === boundary.lastMessageID;
            need(sameHead || (prior?.id ?? null) === boundary.lastMessageID && head?.type === 'model-switched' &&
              head.model?.providerID === MODEL.providerID && head.model?.id === MODEL.id && head.model.variant === EXECUTOR_MODEL.variant &&
              head.previous?.providerID === MODEL.providerID && head.previous?.id === MODEL.id &&
              (head.previous.variant ?? null) === boundary.variant, 'Existing history changed during model selection; no dispatch');
          }
          await idleWorkspace(start.state, ctx);
        }
        let reservationAttempted = false, reservationExpected, reserved;
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
            id: reserved.expected.messageID,
            text: 'Assignment ID: ' + assignmentID + '\nCanonical plan: ' + JSON.stringify(ctx.planPath) +
              '\nRead that plan; only the assignment below is authorized. Do not edit canonical plans/index/checkpoints, ' +
              'commit, push, merge, switch branches, delegate, broaden scope or execute unassigned blocks. Finish all edits ' +
              'and ordinary foreground checks before the final response. Do not detach project-changing work. Report any ' +
              'remaining background operations; a final response does not itself transfer ownership.\n\n' + task,
          });
          need(response?.data?.id === reserved.expected.messageID && response.data.sessionID === reserved.expected.sessionID,
            'Submission identity uncertain; no retry');
        } catch (error) {
          error.stateOutcome = stoppedOutcome(reserved.expected, error, 'stopped');
          throw error;
        }
        try {
          return commit(reserved.expected, (state, binding) => {
            delete binding.uncertain; delete binding.nextAssignment; binding.phase = 'EXECUTING';
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
