import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MODEL, requireValue as need } from './connection.mjs';
import { assignmentMessages, completion, inspectMessages, interactive, validateAnswer, watch } from './interaction.mjs';

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
    need(Object.keys(binding).every(key => ['codexChat', 'workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath', 'engineID', 'sessionID', 'phase', 'uncertain', 'assignmentID', 'messageID', 'submittedAt', 'pending', 'stopReason'].includes(key)), 'Unexpected binding fields');
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

export function helper(client, { stateRoot = resolve(homedir(), '.local/state/code-duet'), chatID = process.env.CODEX_THREAD_ID } = {}) {
  need(text(chatID), 'Actual CODEX_THREAD_ID is required');
  const statePath = join(stateRoot, 'state.json');
  async function locked(operation) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const lockPath = join(stateRoot, 'state.lock');
    let lock;
    try { lock = openSync(lockPath, 'wx', 0o600); } catch { throw new Error('Helper state locked; inspect previous writer, no automatic unlock'); }
    try { return await operation(readState(statePath)); }
    finally { closeSync(lock); unlinkSync(lockPath); }
  }

  function savedContext(binding, ctx) {
    need(binding.codexChat === chatID, 'Wrong Codex chat');
    for (const key of ['workspace', 'workspaceID', 'checkout', 'checkoutID', 'planPath']) need(binding[key] === ctx[key], 'Saved workspace/plan identity changed');
    need(binding.engineID === client.engineID, 'Engine changed; explicit continuation required');
    need(binding.sessionID && !binding.uncertain && binding.phase !== 'STOPPED', 'Binding stopped or mutation uncertain; do not retry');
  }
  async function sessionMatches(binding) {
    const response = await client.request('/api/session/' + binding.sessionID);
    const session = response?.data;
    need(session?.id === binding.sessionID && session.model?.providerID === MODEL.providerID && session.model?.id === MODEL.id, 'Wrong session/model');
    need(typeof session.location?.directory === 'string' && realpathSync(session.location.directory) === binding.workspace && realpathSync(binding.workspace) === binding.workspace && identity(binding.workspace) === binding.workspaceID && identity(binding.checkout) === binding.checkoutID, 'Session physical directory mismatch');
    return session;
  }
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
    return { kind, workspace: binding.workspace, planPath: binding.planPath, sessionID: binding.sessionID, phase: binding.phase, model: MODEL, correctionCount: plan.correctionCount, ...(binding.assignmentID ? { assignmentID: binding.assignmentID, messageID: binding.messageID } : {}) };
  }
  function stop(state, binding, kind, reason) {
    binding.phase = 'STOPPED'; delete binding.pending;
    binding.stopReason = reason;
    saveState(statePath, state);
    return { ...summary(state, binding, kind), error: reason, executorStopped: false, retried: false };
  }
  async function observed(workspace, planPath, nonGitBaseline, operation) {
    return locked(async state => {
      const binding = state.bindings.find(binding => binding.codexChat === chatID);
      need(binding, 'No binding for this Codex chat');
      if (binding.phase === 'STOPPED') return { ...summary(state, binding, 'stopped'), error: binding.stopReason || 'Prior mutation uncertain; explicit continuation required', executorStopped: false, retried: false };
      try {
        savedContext(binding, context(workspace, planPath, nonGitBaseline));
        need(binding.assignmentID && ['EXECUTING', 'WAITING_FOR_ANSWER', 'REVIEWING'].includes(binding.phase), 'No observable assignment');
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

  return {
    statePath,
    async connectionLost() {
      return locked(async state => {
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        if (!binding) return null;
        return stop(state, binding, 'connection-uncertain', 'Connection/discovery failed; explicit continuation required');
      });
    },
    async wait(workspace, planPath, { nonGitBaseline, timeoutMs = 600_000, signal = new AbortController().signal } = {}) {
      need(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3_600_000, 'Wait timeout must be 1..3600000 ms');
      return observed(workspace, planPath, nonGitBaseline, async (state, binding) => {
        const deadline = AbortSignal.timeout(timeoutMs);
        const combined = AbortSignal.any([signal, deadline]);
        let stream;
        try {
          stream = await watch(client, binding.sessionID, combined);
          let history;
          while (true) {
            if (signal.aborted) return stop(state, binding, 'interrupted', 'Advisor wait interrupted; executor termination unconfirmed');
            if (deadline.aborted) return stop(state, binding, 'connection-uncertain', 'Wait deadline reached; executor termination unconfirmed');
            if (stream.fault) return stop(state, binding, stream.fault, 'Event stream failed/interrupted; no reconnect or ownership transfer');
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
          return stop(state, binding, signal.aborted ? 'interrupted' : 'connection-uncertain', error.message);
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

    async bind(workspace, planPath, nonGitBaseline) {
      return locked(async state => {
        const ctx = context(workspace, planPath, nonGitBaseline);
        const existing = state.bindings.find(binding => binding.codexChat === chatID);
        if (existing) {
          savedContext(existing, ctx);
          await sessionMatches(existing);
          await noForms(existing);
          return summary(state, existing, 'reused');
        }
        await idleWorkspace(state, ctx);
        if (!state.plans.some(plan => plan.planPath === ctx.planPath)) state.plans.push({ workspace: ctx.workspace, planPath: ctx.planPath, correctionCount: 0 });
        need(state.plans.find(plan => plan.planPath === ctx.planPath).workspace === ctx.workspace, 'Plan workspace counter conflict');
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
    async submit(workspace, planPath, assignmentID, packetPath, nonGitBaseline) {
      return locked(async state => {
        const ctx = context(workspace, planPath, nonGitBaseline);
        const binding = state.bindings.find(binding => binding.codexChat === chatID);
        need(binding, 'No binding for this Codex chat');
        savedContext(binding, ctx);
        need(binding.phase === 'PREPARING' && binding.assignmentID === undefined, 'Previous assignment not accepted; no repeat submit');
        need(text(assignmentID) && /^[a-zA-Z0-9._-]{1,120}$/.test(assignmentID), 'Invalid assignment ID');
        need(isAbsolute(packetPath), 'Use absolute packet path');
        const packet = realpathSync(packetPath);
        need(statSync(packet).isFile() && inside(ctx.workspace, packet), 'Packet outside physical workspace');
        const task = readFileSync(packet, 'utf8');
        need(text(task), 'Empty assignment packet');
        await sessionMatches(binding);
        await noForms(binding);
        await idleWorkspace(state, ctx);
        binding.assignmentID = assignmentID;
        binding.messageID = 'msg_' + randomUUID().replaceAll('-', '');
        binding.submittedAt = Date.now();
        binding.phase = 'STOPPED'; binding.uncertain = 'submit';
        saveState(statePath, state);
        const response = await client.request(`/api/session/${binding.sessionID}/prompt`, {
          id: binding.messageID,
          text: `Assignment ID: ${assignmentID}\nCanonical plan: ${JSON.stringify(ctx.planPath)}\nRead that plan; only the assignment below is authorized. Finish all edits and ordinary foreground checks before the final response. Do not detach project-changing work. Report any remaining background operations; a final response does not itself transfer ownership.\n\n${task}`,
        });
        need(response?.data?.id === binding.messageID && response.data.sessionID === binding.sessionID, 'Submission identity uncertain; no retry');
        delete binding.uncertain;
        binding.phase = 'EXECUTING';
        saveState(statePath, state);
        return summary(state, binding, 'admitted');
      });
    },
  };
}
