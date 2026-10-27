import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MODEL, requireValue as need, diagnose, diagnosticError, validateDiagnostic } from './connection.mjs';
import { assignmentMessages, recentSessionMessages, completion, inspectMessages, interactive, validateAnswer, watch } from './interaction.mjs';

const phases = ['PREPARING', 'EXECUTING', 'WAITING_FOR_ANSWER', 'REVIEWING', 'STOPPED', 'FINISHED'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const identity = path => { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; };

export function context(workspace, planPath, nonGitBaseline) {
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
    need(text(nonGitBaseline) && readFileSync(plan, 'utf8').includes(nonGitBaseline), 'Non-Git workspace requires an explicit baseline declaration in its plan');
  }
  return { workspace: directory, workspaceID: identity(directory), checkout, checkoutID: identity(checkout), planPath: plan };
}

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
    need(Number.isInteger(plan.correctionCount) && plan.correctionCount >= 0 && plan.correctionCount <= 20, 'Invalid correction count');
  }
  for (const binding of state.bindings) need(state.plans.some(plan => plan.workspace === binding.workspace && plan.planPath === binding.planPath), 'Missing bound plan counter');
  return state;
}

function readState(path) {
  if (!existsSync(path)) return { schema: 1, bindings: [], plans: [] };
  try { return validateState(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new Error('Invalid helper state; stop without replacing it'); }
}

function saveState(path, state) {
  validateState(state);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

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
    connection: { verified: !!client, engineID: client?.engineID ?? null },
    binding: { status: text(chatID) ? 'unbound' : 'unknown' }, workspace: null, session: null,
    live: { verified: false }, blockers: [], snapshotOnly: true,
    stateLocked: existsSync(join(stateRoot, 'state.lock')) };
  try {
    const state = readState(join(stateRoot, 'state.json'));
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
      need(!result.workspace || result.workspace.directory === binding.workspace, 'Inspection workspace differs from saved binding');
      result.workspace = { directory: binding.workspace, checkout: binding.checkout };
      if (binding.phase !== 'PREPARING') result.blockers.push('Binding phase is ' + binding.phase);
      if (binding.uncertain) result.blockers.push('Prior mutation uncertain; no retry');
      if (binding.nextAssignment === 'correction' && plan.correctionCount === 20) result.blockers.push('Twenty corrections exhausted');
      if (state.bindings.some(other => other !== binding && overlaps(binding.checkout, other.checkout) &&
        (!['PREPARING', 'FINISHED'].includes(other.phase) || other.uncertain))) result.blockers.push('Another helper owns this checkout');
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
      result.retried = false;
    }
    return result;
  } catch (error) {
    return { ...result, kind: 'stopped', error: error.message, diagnostic: diagnose(error, 'unknown', 'snapshot'), retried: false };
  }
}

function stateFailure(error, stage) {
  const conflict = stage === 'state-lock' && error?.code === 'EEXIST';
  const denied = ['EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED'].includes(error?.code);
  return diagnosticError(conflict ? 'Helper state locked; inspect previous writer, no automatic unlock' :
    denied ? 'Helper state access denied; request host-approved access to the existing store, no automatic retry or relocation' :
      'Helper state filesystem error; inspect diagnostic, no automatic retry',
    conflict ? 'state-locked' : denied ? 'state-access' : 'state-io', stage, {}, error);
}

export function helper(client, { stateRoot = resolve(homedir(), '.local/state/code-duet'), chatID = process.env.CODEX_THREAD_ID } = {}) {
  need(text(chatID), 'Actual CODEX_THREAD_ID is required');
  const statePath = join(stateRoot, 'state.json');
  async function locked(operation) {
    try { mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); }
    catch (error) { throw stateFailure(error, 'state-directory'); }
    const lockPath = join(stateRoot, 'state.lock');
    let lock;
    try { lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) { throw stateFailure(error, 'state-lock'); }
    try { return await operation(readState(statePath)); }
    finally { closeSync(lock); unlinkSync(lockPath); }
  }

  function savedContext(binding, ctx) {
    need(binding.codexChat === chatID, 'Wrong Codex chat');
    for (const key of ['workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath']) need(binding[key] === ctx[key], 'Saved workspace/plan identity changed');
    need(binding.engineID === client.engineID, 'Engine changed; explicit continuation required');
    need(binding.sessionID && !binding.uncertain && binding.phase !== 'STOPPED', 'Binding stopped or mutation uncertain; do not retry');
  }
  const sessionMatches = binding => matchingSession(client, binding);
  async function idleWorkspace(state, ctx) {
    for (const binding of state.bindings) {
      if (overlaps(ctx.checkout, binding.checkout)) need(['PREPARING', 'FINISHED'].includes(binding.phase) && !binding.uncertain, 'Prior helper assignment not reviewed/stopped; no new writer');
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
    binding.phase = 'STOPPED'; delete binding.pending;
    binding.stopReason = reason;
    if (diagnostic) binding.diagnostic = validateDiagnostic(diagnostic);
    saveState(statePath, state);
    return { ...summary(state, binding, kind), error: reason, executorStopped: false, retried: false };
  }
  async function observed(workspace, planPath, nonGitBaseline, operation, allowedPhases = ['EXECUTING', 'WAITING_FOR_ANSWER', 'REVIEWING']) {
    return locked(async state => {
      const binding = state.bindings.find(binding => binding.codexChat === chatID);
      need(binding, 'No binding for this Codex chat');
      if (binding.phase === 'STOPPED') return { ...summary(state, binding, 'stopped'), error: binding.stopReason || 'Prior mutation uncertain; explicit continuation required', executorStopped: false, retried: false };
      try {
        savedContext(binding, context(workspace, planPath, nonGitBaseline));
        need(binding.assignmentID && allowedPhases.includes(binding.phase), 'No observable assignment in the required phase');
        return await operation(state, binding);
      } catch (error) { return stop(state, binding, 'connection-uncertain', error.message); }
    });
  }
  async function snapshot(binding) {
    const [session, active, forms, permissions] = await Promise.all([
      sessionMatches(binding), client.request('/api/session/active'),
      client.request(`/api/session/${binding.sessionID}/form`), client.request(`/api/session/${binding.sessionID}/permission`),
    ]);
    need(active?.data && typeof active.data === 'object' && !Array.isArray(active.data) && Array.isArray(forms?.data) && Array.isArray(permissions?.data), 'Unknown execution/interactive status');
    for (const id of Object.keys(active.data)) {
      if (id === binding.sessionID) continue;
      need(/^ses_[a-zA-Z0-9]+$/.test(id), 'Unknown active session identity');
      const other = await client.request('/api/session/' + id);
      need(text(other?.data?.location?.directory) && !overlaps(binding.checkout, realpathSync(other.data.location.directory)), 'Another executor in this checkout; no ownership transfer');
    }
    return { session, active: active.data[binding.sessionID], forms: forms.data, permissions: permissions.data };
  }


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
  async function reviewedResult(binding) {
    const current = await snapshot(binding);
    need(!current.active && !current.forms.length && !current.permissions.length && current.session.outcome === 'succeeded' &&
      current.session.time?.idle >= binding.submittedAt, 'Executor has not ended this assignment');
    const history = inspectMessages(binding, await assignmentMessages(client, binding));
    need(!history.kind, 'Failed/interrupted assignment cannot be released');
    const shells = await client.request('/api/shell?location[directory]=' + encodeURIComponent(binding.workspace));
    completion(history, current.session, shells);
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
      const history = inspectMessages({ messageID: messages[0].id }, messages);
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

    async next(workspace, planPath, kind, nonGitBaseline) {
      need(['block', 'correction'].includes(kind), 'Next assignment kind must be block or correction');
      return observed(workspace, planPath, nonGitBaseline, async (state, binding) => {
        const boundary = await reviewedResult(binding);
        if (binding.adoption) Object.assign(binding.adoption, boundary);
        if (kind === 'correction' && planCounter(state, binding).correctionCount === 20) {
          return stop(state, binding, 'correction-limit', 'Twenty correction cycles exhausted; review remains incomplete');
        }
        binding.nextAssignment = kind; binding.phase = 'PREPARING';
        saveState(statePath, state);
        return summary(state, binding, 'prepared');
      }, ['REVIEWING', 'FINISHED']);
    },
    async finish(workspace, planPath, nonGitBaseline) {
      return observed(workspace, planPath, nonGitBaseline, async (state, binding) => {
        await reviewedResult(binding);
        binding.phase = 'FINISHED';
        saveState(statePath, state);
        return summary(state, binding, 'released');
      }, ['REVIEWING', 'FINISHED']);
    },
    async connectionLost(error) {
      return locked(async state => {
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        if (!binding) return null;
        if (binding.phase === 'STOPPED') return { ...summary(state, binding, 'stopped'),
          error: binding.stopReason || 'Prior mutation uncertain; explicit continuation required', executorStopped: false, retried: false };
        return stop(state, binding, 'connection-uncertain', 'Connection/discovery failed; explicit continuation required', diagnose(error, 'unknown', 'connection'));
      });
    },
    async wait(workspace, planPath, { nonGitBaseline, timeoutMs = 3_600_000, signal = new AbortController().signal } = {}) {
      need(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3_600_000, 'Wait timeout must be 1..3600000 ms');
      return observed(workspace, planPath, nonGitBaseline, async (state, binding) => {
        const startedAt = Date.now();
        const deadline = AbortSignal.timeout(timeoutMs);
        const combined = AbortSignal.any([signal, deadline]);
        let stream;
        try {
          stream = await watch(client, binding.sessionID, combined);
          let history;
          while (true) {
            if (signal.aborted) return stop(state, binding, 'interrupted', 'Advisor wait interrupted; executor termination unconfirmed', diagnose(null, 'interrupted', 'wait', stream.observation));
            if (deadline.aborted) return stop(state, binding, 'connection-uncertain', 'Wait deadline reached; executor termination unconfirmed', diagnose(null, 'deadline', 'wait', stream.observation));
            if (stream.fault) return stop(state, binding, stream.fault, 'Event stream failed/interrupted; no reconnect or ownership transfer', stream.diagnostic);
            const current = await snapshot(binding);
            const refresh = stream.takeFailureHint();
            if (!history || refresh || current.forms.length || current.permissions.length || !current.active) history = inspectMessages(binding, await assignmentMessages(client, binding));
            if (stream.fault || combined.aborted) continue;
            if (history.kind) return stop(state, binding, history.kind, 'Bound assignment failed/interrupted; inspect its session');
            // An earlier assignment's outcome may remain while this assignment is running.
            if (!current.active && current.session.time?.idle >= binding.submittedAt && ['failed', 'interrupted'].includes(current.session.outcome)) return stop(state, binding, current.session.outcome, 'Bound session execution failed/interrupted');
            const pending = current.permissions.length ? ['permission', current.permissions[0]] : current.forms.length ? ['question', current.forms[0]] : null;
            if (pending) {
              const result = interactive(...pending, binding, history);
              binding.phase = 'WAITING_FOR_ANSWER';
              binding.pending = { kind: result.kind, id: result.request.id, fingerprint: result.fingerprint };
              saveState(statePath, state);
              return { ...summary(state, binding, result.kind), request: result.request, fingerprint: result.fingerprint };
            }
            if (binding.pending) { delete binding.pending; binding.phase = 'EXECUTING'; saveState(statePath, state); }
            if (!current.active && current.session.time?.idle >= binding.submittedAt) {
              need(current.session.outcome === 'succeeded', 'Unknown terminal outcome');
              const shells = await client.request('/api/shell?location[directory]=' + encodeURIComponent(binding.workspace));
              const result = completion(history, current.session, shells);
              const confirmed = await snapshot(binding);
              need(!confirmed.active && !confirmed.forms.length && !confirmed.permissions.length &&
                JSON.stringify(confirmed.session.time) === JSON.stringify(current.session.time), 'Execution changed during completion confirmation');
              if (stream.fault || combined.aborted) continue;
              binding.phase = 'REVIEWING'; saveState(statePath, state);
              return { ...summary(state, binding, result.kind), result: result.result };
            }
            await stream.next(Math.min(5_000, timeoutMs));
          }
        } catch (error) {
          const category = signal.aborted ? 'interrupted' : deadline.aborted ? 'deadline' : null;
          return stop(state, binding, signal.aborted ? 'interrupted' : 'connection-uncertain', error.message,
            diagnose(category ? null : error, category ?? 'unknown', category ? 'wait' : 'snapshot',
              stream?.observation ?? { elapsedMs: Math.max(0, Date.now() - startedAt), lastEvent: null }));
        } finally { await stream?.close(); }
      });
    },
    async reply(workspace, planPath, kind, requestID, payload, nonGitBaseline) {
      need(['question', 'permission'].includes(kind) && /^(frm_|per)[a-zA-Z0-9_]+$/.test(requestID), 'Invalid interactive kind/request ID');
      return observed(workspace, planPath, nonGitBaseline, async (state, binding) => {
        const current = await snapshot(binding);
        const requests = kind === 'question' ? current.forms : current.permissions;
        const request = requests.find(item => item.id === requestID);
        if (!request) {
          if (binding.pending?.id === requestID) { delete binding.pending; binding.phase = 'EXECUTING'; saveState(statePath, state); }
          return summary(state, binding, 'stale-request');
        }
        need(binding.phase === 'WAITING_FOR_ANSWER' && binding.pending?.kind === kind && binding.pending.id === requestID, 'Request was not observed by this advisor');
        const history = inspectMessages(binding, await assignmentMessages(client, binding));
        need(!history.kind, 'Assignment already failed/interrupted');
        const verified = interactive(kind, request, binding, history);
        need(binding.pending.fingerprint === verified.fingerprint, 'Pending request changed; no reply');
        if (kind === 'question') validateAnswer(request, payload);
        else need(payload && ['once', 'reject'].includes(payload.decision) && Object.keys(payload).every(key => ['decision', 'message'].includes(key)) &&
          (payload.message === undefined || typeof payload.message === 'string'), 'Permission requires explicit once/reject decision; never always');
        const latest = await client.request('/api/session/' + binding.sessionID + (kind === 'question' ? '/form' : '/permission'));
        need(Array.isArray(latest?.data), 'Unknown pending status before reply');
        const stillPending = latest.data.find(item => item.id === requestID);
        if (!stillPending) {
          delete binding.pending; binding.phase = 'EXECUTING'; saveState(statePath, state);
          return summary(state, binding, 'stale-request');
        }
        need(interactive(kind, stillPending, binding, history).fingerprint === verified.fingerprint, 'Request changed before reply; no mutation');
        binding.phase = 'STOPPED'; binding.uncertain = 'reply'; saveState(statePath, state);
        await client.request(`/api/session/${binding.sessionID}/${kind === 'question' ? 'form' : 'permission'}/${requestID}/reply`, payload);
        delete binding.uncertain; delete binding.pending;
        if (kind === 'permission' && payload.decision === 'reject') return stop(state, binding, 'permission-rejected', 'Permission rejected; coordination stopped, executor termination unconfirmed');
        binding.phase = 'EXECUTING'; saveState(statePath, state);
        return summary(state, binding, 'replied');
      });
    },

    async adopt(workspace, planPath, sessionID, nonGitBaseline, importedCount) {
      need(/^ses_[a-zA-Z0-9]+$/.test(sessionID), 'Use an exact existing session ID');
      return locked(async state => {
        const ctx = context(workspace, planPath, nonGitBaseline);
        const existing = state.bindings.find(binding => binding.codexChat === chatID);
        need(importedCount !== undefined || state.plans.some(plan => plan.planPath === ctx.planPath), 'Established correction count required for adoption; do not guess zero');
        if (existing) {
          savedContext(existing, ctx);
          need(existing.sessionID === sessionID, 'Another session is already bound to this Codex chat');
          need(['PREPARING', 'FINISHED'].includes(existing.phase), 'Existing binding still owns an assignment');
          planCounter(state, ctx, importedCount);
          if (existing.phase === 'FINISHED') await reviewedResult(existing);
          else {
            const current = await idleExisting(state, existing);
            if (existing.adoption) need(['variant', 'lastMessageID', 'idleAt'].every(key => current[key] === existing.adoption[key]), 'Existing session changed since preparation; no dispatch');
          }
          return summary(state, existing, 'reused');
        }
        need(!state.bindings.some(binding => binding.engineID === client.engineID && binding.sessionID === sessionID), 'Session is already bound to another Codex chat; no takeover');
        const binding = { codexChat: chatID, ...ctx, engineID: client.engineID, sessionID, phase: 'PREPARING' };
        binding.adoption = await idleExisting(state, binding);
        planCounter(state, ctx, importedCount);
        state.bindings.push(binding);
        saveState(statePath, state);
        return summary(state, binding, 'adopted');
      });
    },
    async bind(workspace, planPath, nonGitBaseline, importedCount) {
      return locked(async state => {
        const ctx = context(workspace, planPath, nonGitBaseline);
        const existing = state.bindings.find(binding => binding.codexChat === chatID);
        if (existing) {
          if (existing.planPath !== ctx.planPath) {
            savedContext({ ...existing, planPath: ctx.planPath }, ctx);
            need(existing.phase === 'FINISHED', 'Previous plan assignment not released; no plan switch');
            try { const boundary = await reviewedResult(existing); if (existing.adoption) Object.assign(existing.adoption, boundary); }
            catch (error) { return stop(state, existing, 'connection-uncertain', error.message); }
            planCounter(state, ctx, importedCount);
            existing.planPath = ctx.planPath; existing.phase = 'PREPARING';
            for (const key of ['assignmentID', 'messageID', 'submittedAt', 'nextAssignment']) delete existing[key];
            saveState(statePath, state);
            return summary(state, existing, 'reused-plan');
          }
          savedContext(existing, ctx);
          await sessionMatches(existing);
          await noForms(existing);
          planCounter(state, ctx, importedCount);
          return summary(state, existing, 'reused');
        }
        await idleWorkspace(state, ctx);
        planCounter(state, ctx, importedCount);
        const binding = { codexChat: chatID, ...ctx, engineID: client.engineID, sessionID: null, phase: 'STOPPED', uncertain: 'create' };
        state.bindings.push(binding);
        saveState(statePath, state);
        const response = await client.request('/api/session', { title: 'Code Duet: ' + basename(ctx.workspace), location: { directory: ctx.workspace }, model: MODEL });
        need(/^ses_[a-zA-Z0-9]+$/.test(response?.data?.id), 'Creation uncertain; no retry');
        binding.sessionID = response.data.id;
        saveState(statePath, state);
        await sessionMatches(binding);
        delete binding.uncertain;
        binding.phase = 'PREPARING';
        saveState(statePath, state);
        return summary(state, binding, 'created');
      });
    },
    async submit(workspace, planPath, assignmentID, packetPath, nonGitBaseline, kind = 'initial') {
      return locked(async state => {
        const ctx = context(workspace, planPath, nonGitBaseline);
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        need(binding, 'No binding for this Codex chat');
        savedContext(binding, ctx);
        need(['initial', 'block', 'correction'].includes(kind), 'Invalid assignment kind');
        need(binding.phase === 'PREPARING' && (binding.assignmentID === undefined || binding.nextAssignment === kind), 'Previous assignment not accepted; no repeat submit');
        need(binding.assignmentID !== assignmentID, 'Use a fresh assignment ID after review');
        const plan = planCounter(state, ctx);
        if (kind === 'correction' && plan.correctionCount === 20) return stop(state, binding, 'correction-limit', 'Twenty correction cycles exhausted; no cycle 21');
        need(text(assignmentID) && /^[a-zA-Z0-9._-]{1,120}$/.test(assignmentID), 'Invalid assignment ID');
        need(isAbsolute(packetPath), 'Use absolute packet path');
        const packet = realpathSync(packetPath);
        need(statSync(packet).isFile() && inside(ctx.workspace, packet), 'Packet outside physical workspace');
        const task = readFileSync(packet, 'utf8');
        need(text(task), 'Empty assignment packet');
        if (binding.adoption) {
          const current = await idleExisting(state, binding);
          need(['variant', 'lastMessageID', 'idleAt'].every(key => current[key] === binding.adoption[key]), 'Existing session changed since preparation; no dispatch');
        }
        await sessionMatches(binding);
        await noForms(binding);
        await idleWorkspace(state, ctx);
        // Reserve once before POST: an uncertain delivery may already have consumed the cycle.
        if (kind === 'correction') plan.correctionCount++;
        binding.assignmentID = assignmentID;
        binding.messageID = 'msg_' + randomUUID().replaceAll('-', '');
        binding.submittedAt = Date.now();
        binding.phase = 'STOPPED'; binding.uncertain = 'submit';
        saveState(statePath, state);
        const response = await client.request(`/api/session/${binding.sessionID}/prompt`, {
          id: binding.messageID,
          text: `Assignment ID: ${assignmentID}\nCanonical plan: ${JSON.stringify(ctx.planPath)}\nRead that plan; only the assignment below is authorized. Do not edit canonical plans/index/checkpoints, commit, push, merge, switch branches, delegate, broaden scope or execute unassigned blocks. Finish all edits and ordinary foreground checks before the final response. Do not detach project-changing work. Report any remaining background operations; a final response does not itself transfer ownership.\n\n${task}`,
        });
        need(response?.data?.id === binding.messageID && response.data.sessionID === binding.sessionID, 'Submission identity uncertain; no retry');
        delete binding.uncertain; delete binding.nextAssignment;
        binding.phase = 'EXECUTING';
        saveState(statePath, state);
        return summary(state, binding, 'admitted');
      });
    },
  };
}
