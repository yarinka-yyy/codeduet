import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireValue as need, diagnose, observationReader } from './connection.mjs';
import { observationContext, observationSnapshot, planIdentity, matchesPlanIdentity, projectShells, readState, sameProjectShells } from './binding.mjs';
import { recentSessionMessages, inspectMessages, interactive, completion, observationWake } from './interaction.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const count = (state, pin) => state.plans.find(value => value.workspace === pin.workspace && value.planPath === pin.planPath)?.correctionCount ?? null;

export function externalUnchanged(pin, stateRoot) {
  const ctx = observationContext(pin.workspace, pin.planPath);
  need(Object.keys(ctx).every(key => ctx[key] === pin[key]) &&
    (pin.planHashVersion === 2 ? matchesPlanIdentity(pin.planPath, pin.planHash) : hash(readFileSync(pin.planPath)) === pin.planHash),
    'Observation physical context/plan changed');
  const state = readState(join(stateRoot, 'state.json'));
  need(!state.bindings.some(value => value.sessionID === pin.sessionID),
    'Session already has a helper binding; use its owner and ordinary observer');
  need(count(state, pin) === pin.correctionCount, 'Observation plan count changed');
}

// Pins are observation evidence, never a delivered assignment or a new binding.
export async function selectExternal(client, stateRoot, workspace, planPath, sessionID, messageID) {
  need(/^ses_[a-zA-Z0-9]+$/.test(sessionID) && (messageID === undefined || /^msg_[a-zA-Z0-9]+$/.test(messageID)), 'Invalid external session/message ID');
  const pin = { ...observationContext(workspace, planPath), mode: 'external', engineID: client.engineID, sessionID };
  const state = readState(join(stateRoot, 'state.json'));
  pin.correctionCount = count(state, pin);
  pin.planHash = planIdentity(pin.planPath);
  pin.planHashVersion = 2;
  externalUnchanged(pin, stateRoot);
  const current = await observationSnapshot(client, pin);
  const messages = await recentSessionMessages(client, sessionID), prompt = messages[0];
  need(prompt?.type === 'user' && /^msg_[a-zA-Z0-9]+$/.test(prompt.id) && typeof prompt.text === 'string' &&
    prompt.text.split(/\r?\n/).includes('Canonical plan: ' + JSON.stringify(pin.planPath)),
  'Latest prompt does not identify the exact selected plan path');
  need(messageID === undefined || prompt.id === messageID, 'Selected message is no longer the latest prompt');
  Object.assign(pin, { messageID: prompt.id, promptHash: hash(prompt.text),
    adoption: { variant: current.session.model.variant ?? null } });
  await externalOutcome(client, stateRoot, pin);
  return pin;
}

export async function externalOutcome(client, stateRoot, pin) {
  externalUnchanged(pin, stateRoot);
  need(client.engineID === pin.engineID, 'Observation engine changed');
  const current = await observationSnapshot(client, pin);
  need(current.session.time?.archived === undefined && (current.session.archived === undefined || current.session.archived === false), 'Cannot observe archived session');
  need(current.active === undefined || current.active?.type === 'running' && Object.keys(current.active).length === 1, 'Unknown active execution status');
  const messages = await recentSessionMessages(client, pin.sessionID);
  need(messages[0]?.id === pin.messageID && typeof messages[0]?.text === 'string' && hash(messages[0].text) === pin.promptHash,
    'Observation prompt changed; no automatic retarget');
  const history = inspectMessages(pin, messages);
  const base = { observationOnly: true, ownershipTransferred: false, taskSent: false, stateChange: 'unchanged',
    sessionID: pin.sessionID, messageID: pin.messageID, planPath: pin.planPath, correctionCount: pin.correctionCount,
    executorActivity: current.active ? 'running' : 'idle', dispatchAllowed: false };
  const outcome = (kind, extra = {}) => ({ ...base, kind, exchangeOutcome: history.kind ?? (kind === 'observing' ? 'in-progress' :
    kind === 'external-completed' ? 'completed-for-review' : kind), reviewAllowed: kind === 'external-completed',
    ...(history.toolErrors.length ? { toolErrors: history.toolErrors } : {}),
    ...(history.exchangeFailure ? { exchangeFailure: history.exchangeFailure } : {}), ...extra });
  const failure = history.kind ?? (['failed', 'interrupted'].includes(current.session.outcome) ? current.session.outcome : null);
  if (failure && !current.active && !current.forms.length && !current.permissions.length) {
    const confirmed = await observationSnapshot(client, pin);
    const latest = await recentSessionMessages(client, pin.sessionID);
    externalUnchanged(pin, stateRoot);
    need(latest[0]?.id === pin.messageID && typeof latest[0]?.text === 'string' && hash(latest[0].text) === pin.promptHash,
      'Observation prompt changed; no automatic retarget');
    if (confirmed.active || confirmed.forms.length || confirmed.permissions.length ||
      JSON.stringify(confirmed.session.time) !== JSON.stringify(current.session.time) ||
      hash(JSON.stringify(latest)) !== hash(JSON.stringify(messages))) {
      return outcome('observing', { executorActivity: confirmed.active ? 'running' : 'idle' });
    }
    return outcome(failure, history.toolFailure && history.standIssue ? { error: history.standIssue } : {});
  }
  const pending = current.permissions.length ? ['permission', current.permissions[0]] : current.forms.length ? ['question', current.forms[0]] : null;
  if (pending) { const request = interactive(...pending, pin, history); return outcome(request.kind, request); }
  if (current.active) return outcome('observing');
  need(current.session.outcome === 'succeeded', 'No confirmed execution outcome');
  const shells = await projectShells(client, pin);
  let result, completionError;
  try { result = completion(history, current.session, shells); }
  catch (error) { completionError = error; }
  const confirmed = await observationSnapshot(client, pin);
  const [latest, latestShells] = await Promise.all([recentSessionMessages(client, pin.sessionID), projectShells(client, pin)]);
  externalUnchanged(pin, stateRoot);
  need(latest[0]?.id === pin.messageID && typeof latest[0]?.text === 'string' && hash(latest[0].text) === pin.promptHash,
    'Observation prompt changed; no automatic retarget');
  if (confirmed.active || confirmed.forms.length || confirmed.permissions.length || confirmed.session.outcome !== 'succeeded' ||
    JSON.stringify(confirmed.session.time) !== JSON.stringify(current.session.time) ||
    hash(JSON.stringify(latest)) !== hash(JSON.stringify(messages)) || !sameProjectShells(latestShells, shells)) {
    return outcome('retryable-read', { error: 'Execution changed during completion confirmation' });
  }
  if (completionError) throw completionError;
  return outcome('external-completed', { result: result.result });
}

export async function waitExternal(client, stateRoot, pin, { signal, timeoutMs, onReady }) {
  const deadline = AbortSignal.timeout(timeoutMs), combined = AbortSignal.any([signal, deadline]);
  const reader = observationReader(client, combined);
  const interrupted = () => ({ kind: 'observer-error', diagnostic: diagnose(null, signal.aborted ? 'interrupted' : 'deadline', 'wait', stream?.observation) });
  let stream;
  try {
    stream = await observationWake(client, pin.sessionID, combined, pin.workspace);
    while (true) {
      if (combined.aborted) return interrupted();
      if (stream.fault) return { kind: 'observer-error', diagnostic: stream.diagnostic };
      const outcome = await externalOutcome(reader, stateRoot, pin);
      if (stream.fault || combined.aborted) continue;
      if (!['observing', 'retryable-read'].includes(outcome.kind)) return outcome;
      await onReady?.(); onReady = undefined;
      await stream.next(Math.min(outcome.kind === 'retryable-read' ? 250 : 5000, timeoutMs));
    }
  } catch (error) {
    if (combined.aborted) return interrupted();
    throw error;
  } finally { await stream?.close(); }
}
