import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MODEL, requireValue as need, diagnose, diagnosticError, diagnosticEvent } from './connection.mjs';
import { inferPostgresRecovery, verifyPostgresRecovery } from './postgres-recovery.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export function fingerprint(request) {
  return createHash('sha256').update(JSON.stringify(request, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value) ?
      Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
}

export function decodeFrame(frame, ignore = () => false) {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  let value;
  try { value = JSON.parse(data); if (typeof value === 'string') value = JSON.parse(value); }
  catch (error) { throw diagnosticError('Invalid event frame', 'event-json', 'decode', {}, error); }
  if (ignore(value)) return null;
  if (!(value && typeof value.type === 'string' && value.data && typeof value.data === 'object' && !Array.isArray(value.data))) throw diagnosticError('Unknown event shape', 'event-shape', 'decode');
  return value;
}

// The stream only wakes ordinary reconciliation; a token is never a result.
export async function watch(client, sessionID, signal, workspace) {
  const startedAt = Date.now();
  let lastEvent = null;
  const observation = () => ({ elapsedMs: Math.max(0, Date.now() - startedAt), lastEvent });
  const foreign = event => {
    if (/^(server|location)\.(shutdown|disposed)$/.test(event?.type)) return false;
    const ids = [event?.data?.sessionID, event?.data?.session?.id, event?.data?.form?.sessionID,
      event?.data?.permission?.sessionID].filter(value => /^ses_[a-zA-Z0-9]+$/.test(value));
    if (ids.length) return !ids.includes(sessionID);
    const directory = event?.location?.directory;
    if (typeof directory !== 'string' || typeof workspace !== 'string' || !isAbsolute(directory) || !isAbsolute(workspace)) return false;
    try { return relative(realpathSync(workspace), realpathSync(directory)) !== ''; }
    catch { return false; }
  };
  const handshake = new AbortController();
  const timer = setTimeout(() => handshake.abort(), 20_000);
  let response;
  try { response = await client.events(AbortSignal.any([signal, handshake.signal])); }
  catch (error) {
    if (handshake.signal.aborted && !signal.aborted) throw diagnosticError('Event handshake deadline reached', 'event-handshake-timeout', 'handshake', observation());
    throw Object.assign(new Error('Event connection uncertain'), { diagnostic: diagnose(error, 'event-open', 'handshake', observation()) });
  }
  finally { clearTimeout(timer); }
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    const error = !response.ok ? diagnosticError('Event HTTP ' + response.status, 'event-http', 'handshake', { ...observation(), httpStatus: response.status }) :
      diagnosticError('Invalid event stream', 'event-content-type', 'handshake', observation());
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  const reader = response.body.getReader();
  let wake, changed = false, fault = null, diagnostic = null, failureHint = false, closed = false;
  const notify = () => { changed = true; wake?.(); };
  const pumping = (async () => {
    let buffer = ''; const decoder = new TextDecoder();
    try {
      while (!closed) {
        const part = await reader.read();
        if (part.done) throw diagnosticError('Event stream closed; executor state unknown', 'event-eof', 'stream');
        buffer += decoder.decode(part.value, { stream: true });
        if (buffer.length > 1_048_576) throw diagnosticError('Event frame too large', 'event-buffer-limit', 'decode');
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
          const event = decodeFrame(buffer.slice(0, boundary), foreign);
          buffer = buffer.slice(boundary + separator.length);
          if (!event) continue;
          if (/^(server|location)\.(shutdown|disposed)$/.test(event.type)) {
            const server = event.type.startsWith('server.');
            // V2 lifecycle scope is on the event envelope, not its session payload.
            const directory = event.location?.directory;
            let scope = server ? 'server' : 'unknown';
            if (!server && typeof directory === 'string' && isAbsolute(directory) && typeof workspace === 'string' && isAbsolute(workspace)) {
              try { scope = relative(realpathSync(workspace), realpathSync(directory)) === '' ? 'selected' : 'foreign'; }
              catch { /* Unresolved paths cannot prove a foreign location. */ }
            }
            lastEvent = { at: Date.now(), type: diagnosticEvent(event.type) };
            if (scope === 'foreign') continue;
            throw diagnosticError('Lifecycle event interrupted observation', server ? 'engine-shutdown' : 'location-shutdown', 'stream', { eventScope: scope });
          }
          if (event.data.sessionID !== sessionID && event.data.session?.id !== sessionID && event.data.form?.sessionID !== sessionID) continue;
          lastEvent = { at: Date.now(), type: diagnosticEvent(event.type) };
          if (/execution\.(failed|interrupted)|step\.(failed|retry)/.test(event.type)) failureHint = true;
          if (/^(form|permission)\.|execution\.|step\.ended|tool\.(success|failed)$/.test(event.type)) notify();
        }
      }
    } catch (error) {
      if (!closed) {
        fault = 'connection-uncertain'; diagnostic = diagnose(error, 'event-read', 'stream', observation()); notify();
      }
    }
  })();
  return {
    get fault() { return fault; },
    get diagnostic() { return diagnostic; },
    get observation() { return observation(); },
    takeFailureHint() { const pending = failureHint; failureHint = false; return pending; },
    async next(milliseconds) {
      if (changed) { changed = false; return; }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, milliseconds);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined; changed = false;
    },
    async close() { closed = true; await reader.cancel().catch(() => {}); await pumping; },
  };
}

export async function observationWake(client, sessionID, signal, workspace, pollOnly = false) {
  const started = Date.now();
  const recoverable = diagnostic => ['event-eof', 'event-read', 'event-open', 'event-handshake-timeout'].includes(diagnostic?.category);
  let stream, disconnected, refreshed = false;
  try { if (!pollOnly) stream = await watch(client, sessionID, signal, workspace); }
  catch (error) {
    if (signal.aborted || !recoverable(error.diagnostic)) throw error;
    disconnected = error.diagnostic;
  }
  const fallback = () => {
    if (!disconnected && !signal.aborted && recoverable(stream?.diagnostic)) disconnected = stream.diagnostic;
    return pollOnly || disconnected;
  };
  return {
    get fault() { return fallback() ? null : stream?.fault; },
    get diagnostic() { return disconnected ?? (signal.aborted ? null : stream?.diagnostic); },
    get observation() { return stream?.observation ?? { elapsedMs: Date.now() - started, lastEvent: null }; },
    takeFailureHint() {
      if (fallback() && !refreshed) { refreshed = true; return true; }
      return stream?.takeFailureHint();
    },
    async next(ms) {
      if (fallback()) await delay(ms, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      else await stream.next(ms);
    },
    async close() { await stream?.close(); },
  };
}

async function messagesSince(client, sessionID, boundary, allowEmpty = false) {
  const base = `/api/session/${sessionID}/message`;
  let route = base + '?limit=100&order=desc', size = 0;
  const result = [], ids = new Set(), cursors = new Set();
  const budget = AbortSignal.timeout(90_000);
  const limit = reason => diagnosticError(reason, 'history-limit', 'history');
  for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
    if (budget.aborted) throw limit('History read exceeded 90 seconds before the delivery boundary');
    const page = await client.request(route, undefined, budget);
    need(Array.isArray(page?.data) && page.data.length <= 100, 'Unknown message page');
    for (const message of page.data) {
      need(message && typeof message.id === 'string' && !ids.has(message.id), 'Ambiguous message pagination');
      size += Buffer.byteLength(JSON.stringify(message));
      if (size > 64 * 1024 * 1024) throw limit('History exceeds 64 MiB before the delivery boundary');
      ids.add(message.id); result.push(message);
      if (boundary(message)) {
        if (pageIndex > 0) {
          const head = await client.request(base + '?limit=1&order=desc', undefined, budget);
          need(head?.data?.length === 1 && fingerprint(head.data[0]) === fingerprint(result[0]),
            'History head changed during paginated read');
        }
        return result.reverse();
      }
    }
    if (allowEmpty && result.length === 0 && page.data.length === 0) return [];
    need(page.data.length > 0 && typeof page.cursor?.next === 'string' && page.cursor.next.length > 0 &&
      page.cursor.next.length <= 2048 && !cursors.has(page.cursor.next), 'Assignment absent from message history or invalid cursor');
    cursors.add(page.cursor.next);
    route = base + '?limit=100&cursor=' + encodeURIComponent(page.cursor.next);
  }
  throw limit('Assignment history exceeds 200 pages before the delivery boundary');
}

export function assignmentMessages(client, binding) {
  return messagesSince(client, binding.sessionID, message => {
    if (message.id !== binding.messageID) return false;
    need(message.type === 'user' && message.text?.startsWith('Assignment ID: ' + binding.assignmentID + '\n'), 'Assignment message mismatch');
    return true;
  });
}

// Adoption examines only the latest exchange, never the whole prior transcript.
export const recentSessionMessages = (client, sessionID) => messagesSince(client, sessionID, message => message.type === 'user', true);

function nativeInstructions(binding, messages, index) {
  const message = messages[index], metadata = message.metadata, instruction = metadata?.instruction;
  if (typeof binding.workspace !== 'string' || !isAbsolute(binding.workspace) ||
    !metadata || Object.keys(metadata).length !== 1 || !instruction || Object.keys(instruction).length !== 1 ||
    !Array.isArray(instruction.paths) || !instruction.paths.length || new Set(instruction.paths).size !== instruction.paths.length) return false;
  const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
  const paths = instruction.paths;
  if (!paths.every(path => typeof path === 'string' && isAbsolute(path) && basename(path) === 'AGENTS.md' &&
    inside(binding.workspace, path) && relative(binding.workspace, dirname(path)) !== '')) return false;
  if (!message.text.startsWith('Instructions from: ' + paths[0] + '\n') ||
    !paths.slice(1).every(path => message.text.includes('\n\nInstructions from: ' + path + '\n'))) return false;
  return messages.slice(1, index).some(assistant => assistant.type === 'assistant' && Array.isArray(assistant.content) &&
    assistant.content.some(tool => {
      if (tool.type !== 'tool' || tool.name !== 'read' || !['running', 'completed'].includes(tool.state?.status) ||
        typeof tool.state.input?.path !== 'string' || !Number.isFinite(tool.time?.ran) ||
        !Number.isFinite(assistant.time?.created) || assistant.time.created > tool.time.ran ||
        message.time.created < tool.time.ran) return false;
      // Instruction injection happens inside read, before the tool's completed record.
      if (tool.state.status === 'completed' ? !Number.isFinite(tool.time.completed) || message.time.created > tool.time.completed :
        tool.time.completed !== undefined) return false;
      const readPath = resolve(binding.workspace, tool.state.input.path);
      return inside(binding.workspace, readPath) && paths.every(path =>
        relative(path, readPath) !== '' && inside(dirname(path), readPath));
    }));
}

function nativeSystem(message) {
  const metadata = message.metadata;
  return Object.keys(message).every(key => ['id', 'type', 'text', 'description', 'time', 'metadata'].includes(key)) &&
    typeof message.id === 'string' && message.id.startsWith('msg_') && typeof message.text === 'string' &&
    (message.description === undefined || typeof message.description === 'string') &&
    Number.isFinite(message.time?.created) && message.time.created >= 0 && Object.keys(message.time).length === 1 &&
    metadata && Object.keys(metadata).length === 2 && metadata.notice === 'instructions' &&
    Array.isArray(metadata.instructionSources) && metadata.instructionSources.length > 0 &&
    new Set(metadata.instructionSources).size === metadata.instructionSources.length &&
    metadata.instructionSources.every(source => ['core/codemode', 'core/skill-guidance'].includes(source));
}

function nativeSkill(message) {
  return /^msg_[a-zA-Z0-9]+$/.test(message.id) && typeof message.skill === 'string' && message.skill.length > 0 &&
    typeof message.name === 'string' && message.name.length > 0 && typeof message.text === 'string' &&
    Number.isSafeInteger(message.time?.created) && message.time.created >= 0 &&
    Object.keys(message).every(key => ['id', 'type', 'skill', 'name', 'text', 'time', 'metadata'].includes(key));
}

function nativeBackgroundShell(message, launches) {
  const { metadata, description, text, time } = message;
  if (!metadata || metadata.source !== 'shell' || typeof metadata.shellID !== 'string' ||
    !/^sh_[a-zA-Z0-9]{1,160}$/.test(metadata.shellID) ||
    metadata.jobID !== metadata.shellID || !['completed', 'error', 'cancelled'].includes(metadata.state) ||
    !Object.keys(message).every(key => ['id', 'type', 'text', 'description', 'time', 'metadata'].includes(key)) ||
    typeof message.id !== 'string' || !message.id.startsWith('msg_') || Object.keys(time).length !== 1 ||
    typeof description !== 'string' || !text.startsWith(`<shell id="${metadata.jobID}" state="${metadata.state}" command="${description}">\n`) ||
    !text.endsWith('\n</shell>')) return false;
  const result = metadata.state === 'completed';
  if (!Object.keys(metadata).every(key => ['source', 'shellID', 'jobID', 'state'].includes(key) ||
    result && ['truncated', 'exit', 'signal', 'timeout'].includes(key)) || result &&
    (typeof metadata.truncated !== 'boolean' || metadata.exit !== undefined && !Number.isSafeInteger(metadata.exit) ||
      metadata.signal !== undefined && typeof metadata.signal !== 'string' ||
      metadata.timeout !== undefined && typeof metadata.timeout !== 'boolean')) return false;
  const launch = launches.get(metadata.shellID);
  if (!launch || launch.notice || launch.command !== description || time.created < launch.ran) return false;
  launch.notice = message;
  return true;
}

function rejectedEdit(tool, workspace) {
  const input = tool.state?.input, error = tool.state?.error;
  if (tool.name !== 'edit' || tool.state.status !== 'error' || error?.type !== 'tool.execution' ||
    typeof workspace !== 'string' || !isAbsolute(workspace) || typeof input?.path !== 'string' ||
    typeof input.oldString !== 'string' || !input.oldString || typeof input.newString !== 'string' ||
    !Number.isFinite(tool.time?.ran) || !Number.isFinite(tool.time?.completed) || tool.time.completed < tool.time.ran) return null;
  // OpenCode 2.2.0 rejects these replacements before fileMutation.write.
  const missing = `Could not find oldString in ${input.path}. It must match exactly, including whitespace and indentation.`;
  const hint = typeof error.message === 'string' && (error.message === missing + '\n\nnewString is already in the file, so this edit may already be applied.' ||
    error.message.startsWith(missing + '\n\nThe closest lines in the file:\n'));
  if (error.message !== missing && !hint && !/^Found (?:[2-9]|[1-9]\d+) matches for oldString, but expected exactly one\. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence\.$/.test(error.message)) return null;
  try {
    const path = realpathSync(resolve(workspace, input.path)), rel = relative(realpathSync(workspace), path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return null;
    return path;
  } catch { return null; }
}

function readOnlyToolError(tool) {
  const { input, error } = tool.state ?? {};
  if (!['unknown', 'tool.execution'].includes(error?.type) ||
    !Number.isFinite(tool.time?.ran) || !Number.isFinite(tool.time?.completed) || tool.time.completed < tool.time.ran) return null;
  if (tool.name === 'read' && typeof input?.path === 'string' && input.path &&
    /^Cannot read binary file: [^\r\n\0]+$/.test(error.message)) return 'binary-read-rejected';
  if (tool.name === 'webfetch' && typeof input?.url === 'string' &&
    error.message === `StatusCode: non 2xx status code (429 GET ${input.url})`) {
    try { if (['http:', 'https:'].includes(new URL(input.url).protocol)) return 'http-rate-limit'; }
    catch { /* Unknown URLs do not establish a read-only request. */ }
  }
  if (error.type === 'tool.execution' && ['read', 'glob', 'grep'].includes(tool.name) &&
    (typeof input?.path === 'string' || typeof input?.pattern === 'string')) return 'read-operation-failed';
  return null;
}

function validateCompaction(message) {
  need(Object.keys(message).every(key => ['id', 'type', 'time', 'metadata', 'status', 'reason', 'model', 'summary', 'cost', 'tokens', 'error'].includes(key)) &&
    typeof message.id === 'string' && message.id.startsWith('msg_'), 'Unknown compaction record');
  need(['running', 'completed', 'failed'].includes(message.status), 'Unknown compaction status');
  need(['auto', 'manual'].includes(message.reason) && Number.isFinite(message.time?.created) && message.time.created >= 0 &&
    Object.keys(message.time).length === 1, 'Invalid compaction metadata');
  if (message.status === 'completed') need(message.model?.id === MODEL.id && message.model?.providerID === MODEL.providerID &&
    typeof message.summary === 'string', 'Compaction model/summary changed');
}

export function inspectMessages(binding, messages, { adopting = false } = {}) {
  need(messages[0]?.id === binding.messageID, 'Uncorrelated assignment');
  const tail = messages.slice(1);
  need(!tail.some(message => message.type === 'user'), 'Another user prompt followed the bound assignment');
  const unsupported = tail.find(message => !['assistant', 'idle', 'synthetic', 'compaction', 'system', 'skill'].includes(message.type));
  const knownType = ['system', 'skill', 'shell', 'agent-switched', 'model-switched', 'location-switched'].includes(unsupported?.type) ? unsupported.type : 'unrecognized';
  need(!unsupported, 'Unsupported execution history type: ' + knownType + ' (' + shellEvidenceID(unsupported?.id) + '); cannot transfer ownership');
  for (const message of tail) {
    if (message.type === 'system') need(nativeSystem(message), 'Unknown native system record (' + shellEvidenceID(message.id) + '); cannot transfer ownership');
    if (message.type === 'skill') need(nativeSkill(message), 'Unknown native skill record (' + shellEvidenceID(message.id) + '); cannot transfer ownership');
  }
  const inputs = tail.filter(message => message.type === 'synthetic');
  if (!inputs.every(message => typeof message.text === 'string' && Number.isFinite(message.time?.created) && message.time.created >= 0)) {
    throw diagnosticError('Invalid synthetic input metadata; no ownership transfer', 'history-correlation', 'history',
      { historyType: 'synthetic', errorCode: 'InvalidSyntheticInput' });
  }
  for (const message of tail) if (message.type === 'compaction') validateCompaction(message);
  const assistants = tail.filter(message => message.type === 'assistant');
  for (const message of assistants) {
    need(message.model?.id === MODEL.id && message.model?.providerID === MODEL.providerID && Array.isArray(message.content), 'Executor model/history changed');
  }
  const backgroundShells = new Map();
  for (const [index, message] of tail.entries()) {
    if (message.type === 'assistant') for (const tool of message.content) {
      const { input, metadata, status } = tool.state ?? {};
      if (tool.type !== 'tool' || tool.name !== 'shell' || input?.background !== true ||
        typeof input.command !== 'string' || typeof metadata?.shellID !== 'string' || !Number.isFinite(tool.time?.ran) ||
        !(status === 'running' && tool.time.completed === undefined || status === 'completed' && metadata.status === 'running' &&
          Number.isFinite(tool.time.completed) && tool.time.completed >= tool.time.ran) ||
        !Number.isFinite(message.time?.created) || message.time.created > tool.time.ran ||
        (Number.isFinite(messages[0].time?.created) && messages[0].time.created > message.time.created)) continue;
      need(!backgroundShells.get(metadata.shellID)?.notice, 'Background shell launch is ambiguous');
      backgroundShells.set(metadata.shellID, backgroundShells.has(metadata.shellID) ? null :
        { command: input.command, ran: tool.time.ran, toolID: tool.id, messageID: message.id });
    }
    if (message.type === 'synthetic' && !nativeBackgroundShell(message, backgroundShells) && !adopting &&
      !nativeInstructions(binding, messages, index + 1)) {
      throw diagnosticError('Synthetic input is not correlated to this assignment; no ownership transfer', 'history-correlation', 'history',
        { historyType: 'synthetic', errorCode: 'UncorrelatedSyntheticInput' });
    }
  }
  const final = assistants.at(-1), idle = tail.at(-1);
  const retries = new Map();
  if (idle?.type === 'idle' && idle.outcome === 'succeeded' && final?.finish === 'stop' &&
    Number.isFinite(final.time?.created) && Number.isFinite(final.time?.completed)) {
    for (const message of assistants.slice(0, -1)) {
      const retry = message.retry, status = retry?.error?.status;
      if (Number.isSafeInteger(retry?.attempt) && retry.attempt > 0 && Number.isFinite(retry.at) &&
        Number.isFinite(message.time?.created) && message.time.created <= retry.at && retry.at <= final.time.created &&
        [429, 502, 503, 504].includes(status) && !message.content.some(part => part.type === 'tool') &&
        (!message.error || message.error.type === retry.error.type && message.error.status === status))
        retries.set(message, { messageID: message.id, attempt: retry.attempt, status });
    }
  }
  const failed = tail.find(message => !retries.has(message) && (message.error || message.retry || message.type === 'idle' && message.outcome === 'failed' ||
    message.type === 'compaction' && message.status === 'failed' ||
    message.type === 'assistant' && ['error', 'length', 'content-filter', 'unknown'].includes(message.finish)));
  const interrupted = tail.find(message => message.type === 'idle' && message.outcome === 'interrupted');
  const tools = assistants.flatMap(message => message.content.filter(part => part.type === 'tool').map(part => ({ ...part, messageID: message.id })));
  const evidence = (reason, messageID, tool) => ({ reason,
    ...(/^msg_[a-zA-Z0-9]{1,160}$/.test(messageID) ? { messageID } : {}),
    ...(tool && /^[a-zA-Z0-9_-]{1,160}$/.test(tool.id) ? { toolID: tool.id } : {}),
    ...(tool && /^[a-zA-Z0-9_-]{1,80}$/.test(tool.name) ? { toolName: tool.name } : {}) });
  const recoveredToolErrors = [], unresolved = [], toolErrors = [];
  for (const [index, tool] of tools.entries()) {
    const launch = backgroundShells.get(tool.state?.metadata?.shellID);
    const result = launch?.notice?.metadata;
    if (result && launch.toolID === tool.id && launch.messageID === tool.messageID &&
      (result.state !== 'completed' || result.exit !== 0 || result.timeout || result.signal !== undefined)) {
      unresolved.push({ tool, recoverable: false });
      toolErrors.push({ ...evidence('tool-error', tool.messageID, tool), classification: 'blocking', semanticRecoveryVerified: false });
    }
    if (tool.state?.status !== 'error') continue;
    const category = readOnlyToolError(tool);
    if (category) {
      toolErrors.push({ ...evidence('tool-error', tool.messageID, tool), classification: 'read-only-warning', category,
        semanticRecoveryVerified: false });
      continue;
    }
    const path = rejectedEdit(tool, binding.workspace);
    const repair = path && tools.slice(index + 1).find(candidate => {
      if (candidate.name !== 'edit' || candidate.state?.status !== 'completed' ||
        typeof candidate.state.input?.oldString !== 'string' || !candidate.state.input.oldString ||
        typeof candidate.state.input?.newString !== 'string' ||
        typeof candidate.state.input?.path !== 'string' || !Number.isFinite(candidate.time?.ran) ||
        !Number.isFinite(candidate.time?.completed) || candidate.time.ran <= tool.time.completed ||
        candidate.time.completed < candidate.time.ran) return false;
      try { return relative(path, realpathSync(resolve(binding.workspace, candidate.state.input.path))) === ''; }
      catch { return false; }
    });
    if (repair) recoveredToolErrors.push({ messageID: tool.messageID, id: tool.id, recoveredBy: repair.id,
      evidence: 'later-edit-same-file', semanticRecoveryVerified: false });
    else unresolved.push({ tool, recoverable: !!path });
    toolErrors.push({ ...evidence('tool-error', tool.messageID, tool), classification: repair ? 'recovered-edit' : 'blocking',
      ...(repair ? { recoveredBy: repair.id } : {}), semanticRecoveryVerified: false });
  }
  const history = { tools, final, idle, tail, backgroundShells, recoveredToolErrors, toolErrors, retries,
    invocationProofs: binding.invocationProofs, recoveryBinding: binding };
  // Keep history failure separate from current executor activity; preserve tools for questions.
  if (failed) return { ...history, kind: 'failed', exchangeFailure: evidence(
    failed.error ? 'message-error' : failed.retry ? 'retry-record' : failed.type === 'idle' ? 'failed-idle' :
      failed.type === 'compaction' ? 'failed-compaction' : 'assistant-finish', failed.id) };
  if (interrupted) return { ...history, kind: 'interrupted', exchangeFailure: evidence('interrupted-idle', interrupted.id) };
  return unresolved.length ? { ...history, kind: 'failed', toolFailure: true,
    exchangeFailure: evidence('tool-error', unresolved[0].tool.messageID, unresolved[0].tool),
    recoverablePending: unresolved.every(value => value.recoverable) } : history;
}

export function interactive(kind, request, binding, history) {
  need(request.sessionID === binding.sessionID && typeof request.id === 'string', 'Wrong interactive session/request');
  const source = kind === 'question' ? request.metadata?.tool : request.source;
  need(source && (kind === 'question' || source.type === 'tool') && history.tools?.some(tool => tool.messageID === source.messageID && tool.id === source.id), 'Interactive request not correlated to this assignment tool');
  let manualReason;
  if (kind === 'question') {
    need(/^frm_[a-zA-Z0-9]+$/.test(request.id) && Array.isArray(request.fields) && request.fields.length > 0, 'Unknown question form');
    if (request.metadata?.kind !== 'question') manualReason = 'Native form requires an answer in OpenCode';
    const keys = new Set();
    for (const field of request.fields) {
      need(field && typeof field.key === 'string' && !keys.has(field.key), 'Invalid or duplicate question field');
      if (field.when?.length || field.hidden || field.type === 'external' || field.format ||
        !['string', 'multiselect', 'number', 'integer', 'boolean'].includes(field.type))
        manualReason ??= field.hidden || field.when?.length ? 'Conditional or hidden fields require an answer in OpenCode' :
          'Unsupported field semantics require an answer in OpenCode';
      keys.add(field.key);
      need(field.options === undefined || Array.isArray(field.options) && field.options.every(option => typeof option.value === 'string' && typeof option.label === 'string'), 'Invalid question options');
    }
  } else {
    need(/^per[a-zA-Z0-9_]+$/.test(request.id) && typeof request.action === 'string' && Array.isArray(request.resources) && request.resources.every(resource => typeof resource === 'string'), 'Unknown permission request');
  }
  return { kind, request, fingerprint: fingerprint(request), ...(manualReason ? { manualReason } : {}) };
}

export function validateAnswer(request, payload) {
  need(payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 1 && payload.answer && typeof payload.answer === 'object' && !Array.isArray(payload.answer), 'Expected {answer:{field:value}}');
  need(Object.keys(payload.answer).every(key => request.fields.some(field => field.key === key)), 'Unknown answer field');
  for (const field of request.fields) {
    const value = payload.answer[field.key];
    if (value === undefined) { need(field.required === false, 'Missing answer field'); continue; }
    if (field.type === 'boolean') { need(typeof value === 'boolean', 'Invalid boolean answer'); continue; }
    if (['number', 'integer'].includes(field.type)) {
      need(Number.isFinite(value) && (field.type !== 'integer' || Number.isSafeInteger(value)) &&
        value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity), 'Invalid numeric answer');
      continue;
    }
    const values = field.type === 'multiselect' ? value : [value];
    need(Array.isArray(values) && values.every(item => typeof item === 'string') && new Set(values).size === values.length, 'Invalid single/multiple answer');
    if (field.type === 'string') need(typeof value === 'string' && value.length >= (field.minLength ?? 0) && value.length <= (field.maxLength ?? Infinity) && (!field.pattern || new RegExp(field.pattern).test(value)), 'Invalid string answer');
    else need(values.length >= (field.minItems ?? 0) && values.length <= (field.maxItems ?? Infinity), 'Invalid selection count');
    need(!field.options || field.custom === true || values.every(item => field.options.some(option => option.value === item)), 'Answer outside offered options');
  }
}

export function completion(history, session, shells, invocationCheck) {
  need(!history.kind, 'Failed/interrupted exchange cannot complete');
  const { final, idle, tools } = history;
  need(final?.finish === 'stop' && Number.isFinite(final.time?.completed), 'No completed final assistant response');
  need(history.tail.filter(message => message.type === 'assistant').every(message => history.retries?.has(message) ||
    Number.isFinite(message.time?.completed)), 'Unfinished assistant step');
  need(idle?.type === 'idle' && idle.outcome === 'succeeded' && idle.time?.created >= final.time.completed && session.time.idle >= idle.time.created, 'No correlated terminal idle');
  const finalIndex = history.tail.indexOf(final);
  const notices = new Set([...history.backgroundShells?.values() ?? []].map(launch => launch?.notice).filter(Boolean));
  for (const [index, message] of history.tail.entries()) {
    if (notices.has(message)) need(message.time.created <= idle.time.created, 'Shell completion notice is newer than terminal idle');
    else if (['synthetic', 'system', 'skill'].includes(message.type)) need(index < finalIndex &&
      message.time.created <= final.time.completed, 'No completed final after ' + message.type + ' input');
    if (message.type === 'compaction') {
      need(message.status === 'completed', 'Compaction has not completed');
      need(idle.time.created >= message.time.created, 'No terminal idle after compaction');
    }
  }
  const recovered = history.recoveredToolErrors ?? [];
  need(recovered.every(value => tools.some(tool => tool.id === value.recoveredBy &&
    tool.time?.completed <= final.time.completed)), 'No completed final after recovered edit');
  need(tools.every(tool => {
    const launch = history.backgroundShells?.get(tool.state?.metadata?.shellID);
    if (launch?.notice && launch.toolID === tool.id && launch.messageID === tool.messageID)
      return launch.ran <= final.time.completed && launch.notice.time.created <= idle.time.created;
    return (tool.state?.status === 'completed' || tool.state?.status === 'error' &&
    (readOnlyToolError(tool) || recovered.some(value => value.id === tool.id && value.messageID === tool.messageID))) &&
      Number.isFinite(tool.time?.completed) && tool.time.completed <= final.time.completed;
  }), 'Outstanding/unknown tool operation');
  const postgres = endedShells(history, shells, false, invocationCheck);
  const shellOutcomes = tools.filter(tool => /^(bash|shell|exec|terminal|powershell)$/.test(tool.name)).map(tool => {
    const metadata = tool.state.metadata ?? {}, registered = shells.data.find(shell => shell.id && shell.id === metadata.shellID);
    const notice = history.backgroundShells?.get(metadata.shellID)?.notice?.metadata;
    const exit = notice?.exit ?? registered?.exit ?? metadata.exit, signal = notice?.signal ?? registered?.signal ?? metadata.signal;
    const timeout = notice?.timeout === true || registered?.status === 'timeout' || metadata.timeout === true;
    return { callID: shellEvidenceID(tool.id), outcome: timeout ? 'timeout' : signal || registered?.status === 'killed' ? 'signalled' :
      Number.isSafeInteger(exit) ? exit === 0 ? 'succeeded' : 'nonzero-exit' : 'completed',
      ...(Number.isSafeInteger(exit) ? { exit } : {}), ...(timeout ? { timeout } : {}),
      ...(typeof signal === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(signal) ? { signal } : {}) };
  });
  const output = final.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  need(output.trim(), 'Empty final response');
  return { kind: 'completed-for-review', result: { assistantID: final.id, text: output, tools: tools.map(tool => ({ id: tool.id, name: tool.name, status: tool.state.status,
    ...(tool.state.metadata?.timeout === true ? { timeout: true } : {}) })),
    ...(postgres.length ? { postgresRecovery: postgres } : {}),
    ...(shellOutcomes.length ? { shellOutcomes } : {}),
    ...(history.toolErrors?.length ? { toolErrors: history.toolErrors } : {}),
    ...(history.retries?.size ? { recoveredRetries: [...history.retries.values()] } : {}),
    ...(recovered.length ? { recoveredToolErrors: recovered } : {}), endedAt: idle.time.created } };
}

const detachedLauncher = /Start-Process|Start-(?:Thread)?Job|\bsaps\b|\bnohup\b|\bdisown\b|\bsetsid\b|\bdetach(?:ed)?\b|\bspawn\b|\bPopen\b|\bstart(?=[\s'";|&]|$)/i;

function detachedReason(command, maskInvocationCalls, postgresRecovery) {
  // shortcut: only exempt simple output data when the engine omits the shell dialect.
  const outputData = /^[ \t]*Write-(?:Output|Host)(?:[ \t]+(?:[\w.-]+|'[\w .-]*'))*(?:[ \t]+#[\w .-]*)?[ \t]*$/i;
  // Keep the existing exemption for a literal rg search pattern, within a simple invocation.
  const launcherSource = outputData.test(command) ? '' : (postgresRecovery ?
    command.replace(/^[ \t]*"--- pg_ctl start log ---"[ \t]*\r?$/gm, '') : command).replace(
    /^([ \t]*rg[ \t]+-n[ \t]+)'[\w .:-]*(\|[\w:.-]+(?:\|[\w:.-]+)*)?'(?=[ \t])/i,
    (pattern, prefix, alternatives) => detachedLauncher.test(alternatives ?? '') ? pattern : prefix + 'quoted');
  let verified;
  const verifiedSource = () => verified ??= maskInvocationCalls(command);
  const rawLauncher = launcherSource.match(detachedLauncher);
  const launcher = rawLauncher && /(?:\bWrite-(?:Output|Host)\b|#)/i.test(command) && verifiedSource() !== command ?
    verifiedSource().match(detachedLauncher) : rawLauncher;
  if (launcher) return 'possible detached launcher ' + launcher[0].toLowerCase();
  const nested = /\b(?:bash|sh|zsh|cmd)(?:\.exe)?[ \t]+-(?:c|lc)\b|\bcmd(?:\.exe)?[ \t]+\/c\b|\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*?[ \t]-(?:c|command)\b/i.exec(command);
  if (nested && /(^|[^&])&([^&]|$)/.test(command.slice(nested.index + nested[0].length).replace(/\b\d+>&\d+\b/g, 'redirect')))
    return 'unclassified ampersand in nested shell';

  // A physical line cannot start a Bash background operator unless the line continues a command.
  const separateLines = !/[\\^`]\r?\n/.test(command);
  const normalize = source => (separateLines ? source.replace(/(^|\r?\n)[ \t]*&[ \t]*(?=\(|['"\$\w])/g, '$1') : source)
    .replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g, 'quoted')
    .replace(/\b\d+>&\d+\b/g, 'redirect')
    .replace(/(^|[;{])\s*&\s*(?=quoted|\$[a-zA-Z_]|[a-zA-Z_])/g, '$1 ');
  const loneAmpersand = /(^|[^&])&([^&]|$)/;
  if (loneAmpersand.test(normalize(command)) &&
    loneAmpersand.test(normalize(verifiedSource())))
    return 'unclassified or background ampersand';
}

const invocationCallProbe = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$call = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($call.command, [ref]$tokens, [ref]$errors)
if ($errors.Count) { exit }
$offsets = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and $node.InvocationOperator -eq 'Ampersand'
}, $true) | ForEach-Object { $_.Extent.StartOffset } | Sort-Object -Unique)
if ($call.syntaxOnly) { ConvertTo-Json -Compress -InputObject $offsets; exit }
$dataExtents = @($tokens | Where-Object Kind -eq 'Comment' | ForEach-Object Extent)
$dataExtents += @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -in 'Write-Output','Write-Host'
}, $true) | ForEach-Object { $_.CommandElements | Select-Object -Skip 1 | Where-Object {
  $_ -is [System.Management.Automation.Language.StringConstantExpressionAst]
} | ForEach-Object Extent })
$dataRanges = @($dataExtents | Sort-Object StartOffset -Unique | ForEach-Object { @{ start=$_.StartOffset; end=$_.EndOffset } })
if (!$offsets.Count -and !$dataRanges.Count) { exit }
$start = [DateTimeOffset]::FromUnixTimeMilliseconds($call.ran).LocalDateTime
$end = [DateTimeOffset]::FromUnixTimeMilliseconds($call.completed).LocalDateTime
$exe = Join-Path $PSHOME 'powershell.exe'
$prefix = "$exe -NoLogo -NoProfile -NonInteractive -Command "
# The event query can round timestamps. Check the exact millisecond window below.
$filter = @{ ProviderName='PowerShell'; Id=400,403; StartTime=$start.AddSeconds(-1); EndTime=$end.AddSeconds(1) }
if ($call.archive) { $filter.Path = $call.archive } else { $filter.LogName = 'Windows PowerShell' }
$events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents 257)
if ($events.Count -ge 257) { exit }
$matchesByProcess = @($events | ForEach-Object {
  $at = ([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds()
  $context = ([string]$_.Properties[2].Value).Replace([Environment]::NewLine, [string][char]10)
  $applicationField = [regex]::Match($context, '(?ms)^[ \t]*HostApplication=(.*)\n[ \t]*EngineVersion=')
  if ($_.LogName -eq 'Windows PowerShell' -and $at -ge $call.ran -and $at -le $call.completed -and $applicationField.Success) {
    $application = $applicationField.Groups[1].Value
    if ($application.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        $application.Substring($prefix.Length) -ceq $call.command.Replace([Environment]::NewLine, [string][char]10) -and
        $context.Substring(0, $applicationField.Index) -match '(?im)^[ \t]*HostId=([0-9a-f-]{36})$') {
      [pscustomobject]@{ id=$_.Id; at=$at; record=$_.RecordId; pid=$_.ProcessId; host=$Matches[1] }
    }
  }
})
if ($matchesByProcess.Count -eq 2 -and $matchesByProcess[0].Id -eq 403 -and $matchesByProcess[1].Id -eq 400 -and
  $matchesByProcess[0].pid -gt 0 -and $matchesByProcess[0].pid -eq $matchesByProcess[1].pid -and
  $matchesByProcess[0].host -eq $matchesByProcess[1].host) {
  ConvertTo-Json -Compress -InputObject @{ offsets=$offsets; dataRanges=$dataRanges; events=@($matchesByProcess[1],$matchesByProcess[0]) }
}`;

function invocationProbe(input) {
  const exe = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const output = execFileSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(invocationCallProbe, 'utf16le').toString('base64')], {
    input: Buffer.from(JSON.stringify(input)).toString('base64'),
    encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65_536, stdio: ['pipe', 'pipe', 'ignore'],
  });
  return output.trim() ? JSON.parse(output) : undefined;
}

function maskInvocationOffsets(command, offsets) {
  const characters = command.split('');
  for (const offset of offsets) characters[offset] = ' ';
  return characters.join('');
}

function maskVerifiedInvocationCalls(command, tool, saved, check) {
  const { ran, completed } = tool.time ?? {};
  if (process.platform !== 'win32' || !process.env.SystemRoot || tool.name !== 'shell' ||
    tool.state.status !== 'completed' || tool.state.metadata?.status !== 'completed' ||
    !Number.isSafeInteger(ran) || !Number.isSafeInteger(completed) || ran >= completed || command.length > 32_768) return command;
  const original = tool.state.input.command;
  const identity = { id: tool.id, messageID: tool.messageID, ran, completed,
    hash: createHash('sha256').update(original).digest('hex') };
  const valid = proof => Array.isArray(proof?.offsets) && (proof.offsets.length > 0 || proof.dataRanges?.length > 0) &&
    proof.offsets.every((offset, index) => Number.isSafeInteger(offset) && command[offset] === '&' &&
      (index === 0 || offset > proof.offsets[index - 1])) &&
    (proof.dataRanges === undefined || Array.isArray(proof.dataRanges) && proof.dataRanges.every((range, index) =>
      Number.isSafeInteger(range?.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.start < range.end &&
      range.end <= command.length && (!index || proof.dataRanges[index - 1].end <= range.start))) &&
    Array.isArray(proof.events) && proof.events.length === 2 && proof.events.every((event, index) =>
      event?.id === (index === 0 ? 400 : 403) && Number.isSafeInteger(event.at) && event.at >= ran && event.at <= completed &&
      Number.isSafeInteger(event.record) && event.record > 0 && Number.isSafeInteger(event.pid) && event.pid > 0 &&
      typeof event.host === 'string' && /^[a-f0-9-]{36}$/i.test(event.host)) &&
    proof.events[0].pid === proof.events[1].pid && proof.events[0].host === proof.events[1].host &&
    proof.events[0].at <= proof.events[1].at && proof.events[0].record < proof.events[1].record;
  const probe = archive => {
    try {
      const proof = invocationProbe({ command: original, ran, completed, archive });
      return valid(proof) ? proof : undefined;
    } catch { return undefined; }
  };
  const matching = saved?.find(proof => proof && Object.keys(identity).every(key => proof[key] === identity[key]) && valid(proof));
  const proof = matching ?? probe() ?? (check?.archive ? probe(check.archive) : undefined);
  if (!proof) return command;
  check?.verified?.push({ ...identity, offsets: proof.offsets, events: proof.events,
    ...(proof.dataRanges ? { dataRanges: proof.dataRanges } : {}) });
  const masked = maskInvocationOffsets(command, proof.offsets).split('');
  for (const range of proof.dataRanges ?? []) for (let i = range.start; i < range.end; i++) {
    if (!/[\r\n]/.test(masked[i])) masked[i] = ' ';
  }
  return masked.join('');
}

const shellEvidenceID = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : 'unknown';

// shortcut: only the portable PostgreSQL clients have an independent process check for this handoff.
function maskLegacyPostgresCalls(command, tool, recovery) {
  const original = tool.state.input.command;
  if (process.platform !== 'win32' || !process.env.SystemRoot || tool.name !== 'shell' ||
    tool.state.status !== 'completed' || tool.state.metadata?.status !== 'completed' || tool.state.metadata.exit !== 0 ||
    tool.state.metadata.timeout || !Number.isSafeInteger(tool.time?.ran) || !Number.isSafeInteger(tool.time?.completed) ||
    tool.time.ran >= tool.time.completed || original.length > 32_768 ||
    /\\(?:!|i(?:r|nclude)?\b|copy\b|gexec\b)|\bprogram\b/i.test(original)) return command;
  const run = dirname(dirname(recovery.dataDirectory)), bin = join(run, 'tools', 'pgsql', 'bin');
  const definitions = [...original.matchAll(/^\s*\$bin[ \t]*=[ \t]*(.+)\r?$/gmi)];
  if (definitions.length !== 1) return command;
  const definition = definitions[0][1].trim();
  const literal = definition.match(/^'([^']+)'$/)?.[1];
  const declaredRun = original.match(/^\$run[ \t]*=[ \t]*'([^']+)'\r?$/mi)?.[1];
  const knownDirectory = literal && isAbsolute(literal) && !relative(bin, literal) ||
    /^Join-Path \$run 'tools[\\/]pgsql[\\/]bin'$/i.test(definition) && declaredRun &&
    isAbsolute(declaredRun) && !relative(run, declaredRun);
  if (!knownDirectory) return command;
  try {
    const offsets = invocationProbe({ command: original, syntaxOnly: true });
    if (!Array.isArray(offsets)) return command;
    const eligible = offsets.filter(offset => {
      if (!Number.isSafeInteger(offset) || command[offset] !== '&') return false;
      const tail = original.slice(offset), prefix = original.slice(0, offset);
      if (/^&[ \t]+\(Join-Path \$bin 'pg_isready\.exe'\)(?=[ \t\r\n]|$)/i.test(tail)) return true;
      const psql = tail.match(/^& \(Join-Path \$bin 'psql\.exe'\) -X -w -h 127\.0\.0\.1 -p (\d+) -U \$cred\.\w+ -d (?:postgres|\$cred\.database)(?: -v ON_ERROR_STOP=1)? -(?:q|At)[ \t]*(?=\r?\n|$)/i);
      if (psql && /\|[ \t]*$/.test(prefix)) return Number(psql[1]) === recovery.port;
      return /^& \(Join-Path \$bin \$e\) --version[ \t]*(?=\r?\n|$)/i.test(tail) &&
        /foreach \(\$e in 'postgres\.exe','initdb\.exe','pg_ctl\.exe','psql\.exe','pg_isready\.exe'\) \{[ \t]*\r?\n[ \t]*\$out[ \t]*=[ \t]*$/i.test(prefix);
    });
    return maskInvocationOffsets(command, eligible);
  } catch { return command; }
}

function endedShells(history, shells, closing = false, invocationCheck) {
  need(shells?.data && Array.isArray(shells.data), 'Unknown project shell status');
  const unfinishedIndex = shells.data.findIndex(shell => !['exited', 'timeout', 'killed'].includes(shell?.status) || !Number.isFinite(shell?.time?.completed));
  if (unfinishedIndex >= 0) {
    const unfinished = shells.data[unfinishedIndex];
    const tool = history.tools.find(tool => unfinished?.id && tool.state.metadata?.shellID === unfinished.id);
    throw new Error('Project shell still running or unknown (' + (tool ? 'call ' + shellEvidenceID(tool.id) : 'shell ' + shellEvidenceID(unfinished?.id)) + ')');
  }
  const binding = history.recoveryBinding;
  const evidence = binding?.postgresRecovery ?? (binding && !closing ? inferPostgresRecovery(binding, history.tools) : undefined);
  const postgres = evidence ? verifyPostgresRecovery({ ...binding, postgresRecovery: evidence }, history.tools,
    history.idle?.time?.created, undefined, history.backgroundShells) : new Map();
  if (postgres.size && invocationCheck) invocationCheck.postgresEvidence = evidence;
  // A completed launcher alone cannot certify a detached process.
  for (const tool of history.tools) {
    const input = tool.state.input ?? {};
    const shellID = tool.state.metadata?.shellID;
    const call = ' (call ' + shellEvidenceID(tool.id) + ')';
    const listed = typeof shellID === 'string' ? shells.data.filter(shell => shell.id === shellID) : [];
    need(listed.length <= 1, 'Ambiguous project shell registry entry' + call);
    const launch = history.backgroundShells?.get(shellID);
    const notice = launch && launch.toolID === tool.id && launch.messageID === tool.messageID ? launch.notice : undefined;
    if (notice) need(listed.length <= 1 && listed.every(shell => shell.status === 'exited' &&
      shell.command === input.command && shell.exit === notice.metadata.exit && shell.signal === undefined &&
      Number.isFinite(shell.time.started) && shell.time.started >= launch.ran &&
      shell.time.completed >= shell.time.started && shell.time.completed <= notice.time.created),
      'Project shell disagrees with completion notice' + call);
    const shellEnded = listed.length === 1 || Boolean(notice && (!closing ||
      notice.metadata.state === 'completed' && Number.isSafeInteger(notice.metadata.exit)));
    need(!/background/i.test(tool.name) && (!(input.background === true || tool.state.metadata?.background === true) ||
      shellEnded), 'Background operation status unknown; no ownership transfer' + call);
    if (/^(bash|shell|exec|terminal|powershell)$/.test(tool.name)) {
      need(typeof input.command === 'string', 'Unknown shell command' + call);
      need(tool.state.metadata?.status === 'completed' || shellEnded || closing && tool.state.status === 'error' &&
        shellID === undefined && !tool.state.metadata?.background && input.background !== true, 'Unknown shell/background completion status' + call);
      const recovered = postgres.get(tool.id);
      if (tool.state.metadata?.timeout === true || tool.state.metadata?.signal !== undefined)
        need(recovered || notice || listed.some(shell => shell.command === input.command), 'Shell termination is not confirmed' + call);
      const stop = [...postgres.values()].find(launch => launch.stop?.tool === tool)?.stop;
      const command = recovered?.command ?? stop?.command ?? input.command;
      let reason = detachedReason(command, source => maskVerifiedInvocationCalls(source, tool, history.invocationProofs, invocationCheck),
        postgres.size > 0);
      if (reason === 'unclassified or background ampersand' && postgres.size && invocationCheck?.lostCalls?.has(tool.id)) {
        reason = detachedReason(command, source => maskLegacyPostgresCalls(source, tool, evidence), true);
        if (!reason) invocationCheck.gaps.push({ id: tool.id, messageID: tool.messageID, ran: tool.time?.ran,
          completed: tool.time?.completed, hash: createHash('sha256').update(input.command).digest('hex') });
      }
      need(!reason, 'Detached command status unknown; no ownership transfer' + call + ': ' + reason);
    }
  }
  const timeline = [...postgres].map(([id, { pid, startedAt, endedAt, timeout }]) => ({ id, pid, startedAt, endedAt, timeout }));
  if (history.recoveryBinding?.postgresTimeline) need(JSON.stringify(history.recoveryBinding.postgresTimeline) === JSON.stringify(timeline),
    'PostgreSQL recovery history changed after review opened');
  return timeline;
}

export function sessionAvailable(session) {
  return !!session.time && typeof session.time === 'object' && !Array.isArray(session.time) && session.time.archived === undefined &&
    (session.archived === undefined || session.archived === false);
}

export function deliveredExchange(messages) {
  const late = messages.findIndex((item, index) => item.type === 'model-switched' ||
    item.type === 'compaction' && item.reason === 'manual' && messages[index - 1]?.type === 'idle');
  return late < 0 ? messages : messages.slice(0, late);
}

export function deliveredBoundary(binding, messages, session, review = false) {
  const modelRef = model => model?.providerID === MODEL.providerID && model?.id === MODEL.id &&
    (model.variant === undefined || typeof model.variant === 'string' && model.variant.length <= 80);
  const terminal = item => item?.type === 'idle' && ['succeeded', 'failed', 'interrupted'].includes(item.outcome) &&
    Number.isSafeInteger(item.time?.created) && item.time.created >= binding.submittedAt;
  need(modelRef(session.model), 'Unsupported model for delivered history');
  const exchange = deliveredExchange(messages);
  const ended = exchange.at(-1);
  need(exchange.length > 1 && terminal(ended), 'No correlated terminal idle for the delivered assignment');
  let idle = ended, lastTime = ended.time.created, compacting = false, selected;
  const executorVariant = exchange.findLast(item => item.type === 'assistant')?.model?.variant;
  for (const item of messages.slice(exchange.length)) {
    const time = item.time?.created;
    need(Number.isSafeInteger(time) && time >= lastTime, 'Unordered history after assignment idle');
    lastTime = time;
    if (!compacting && item.type === 'model-switched' && modelRef(item.previous) && modelRef(item.model) &&
      (selected ? (item.previous.variant ?? null) === (selected.variant ?? null) :
        executorVariant === undefined || item.previous.variant === executorVariant)) selected = item.model;
    else if (!compacting && item.type === 'compaction' && item.reason === 'manual' && item.status === 'completed' && modelRef(item.model)) {
      if (review) {
        validateCompaction(item);
        need(!item.error && !item.retry, 'Compaction after assignment idle failed or retried');
      }
      compacting = true;
    } else if (compacting && terminal(item)) { idle = item; compacting = false; }
    else throw new Error('Unrelated or unfinished history after assignment idle; no closure');
  }
  need(!compacting && (!selected || (selected.variant ?? null) === (session.model.variant ?? null)) &&
    session.time?.idle === idle.time.created && session.outcome === idle.outcome &&
    (session.time.busy === undefined || Number.isSafeInteger(session.time.busy) && session.time.busy <= idle.time.created),
  'Live idle state disagrees with delivered history');
  return { exchange, boundary: { lastMessageID: messages.at(-1).id, idleAt: idle.time.created, variant: session.model.variant ?? null } };
}

export function closureBoundary(binding, messages, session, shells, invocationCheck, delivered = deliveredBoundary(binding, messages, session)) {
  const { exchange, boundary } = delivered, ended = exchange.at(-1);
  const history = inspectMessages(invocationCheck?.lostCalls ? { ...binding, legacyPostgresClients: true } : binding, exchange, { adopting: true });
  need(exchange.slice(1, -1).every(item => item.type === 'assistant' ?
    Number.isSafeInteger(item.time?.completed) && item.time.completed <= ended.time.created :
    Number.isSafeInteger(item.time?.created) && item.time.created <= ended.time.created &&
    (item.type !== 'compaction' || ['completed', 'failed'].includes(item.status))) &&
    history.tools.every(tool => ['completed', 'error'].includes(tool.state?.status) &&
      Number.isSafeInteger(tool.time?.completed) && tool.time.completed <= ended.time.created), 'Unfinished operation in delivered assignment');
  if (invocationCheck?.lostCalls) completion(history, session, shells, invocationCheck);
  else endedShells(history, shells, true, invocationCheck);
  return boundary;
}
