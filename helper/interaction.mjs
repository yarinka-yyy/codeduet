import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MODEL, requireValue as need, diagnose, diagnosticError, diagnosticEvent } from './connection.mjs';

export function fingerprint(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export function decodeFrame(frame) {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  let value;
  try { value = JSON.parse(data); if (typeof value === 'string') value = JSON.parse(value); }
  catch (error) { throw diagnosticError('Invalid event frame', 'event-json', 'decode', {}, error); }
  if (!(value && typeof value.type === 'string' && value.data && typeof value.data === 'object' && !Array.isArray(value.data))) throw diagnosticError('Unknown event shape', 'event-shape', 'decode');
  return value;
}

// The stream only wakes ordinary reconciliation; a token is never a result.
export async function watch(client, sessionID, signal) {
  const startedAt = Date.now();
  let lastEvent = null;
  const observation = () => ({ elapsedMs: Math.max(0, Date.now() - startedAt), lastEvent });
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
          const event = decodeFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + separator.length);
          if (!event) continue;
          if (/^(server|location)\.(shutdown|disposed)$/.test(event.type)) throw diagnosticError('Engine/location shutdown', 'engine-shutdown', 'stream');
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

async function messagesSince(client, sessionID, boundary, allowEmpty = false) {
  let route = `/api/session/${sessionID}/message?limit=100&order=desc`;
  const result = [], ids = new Set(), cursors = new Set();
  // Bound reads stop at this assignment, never at an arbitrary short page.
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await client.request(route);
    need(Array.isArray(page?.data), 'Unknown message page');
    for (const message of page.data) {
      need(message && typeof message.id === 'string' && !ids.has(message.id), 'Ambiguous message pagination');
      ids.add(message.id); result.push(message);
      if (boundary(message)) return result.reverse();
    }
    if (allowEmpty && result.length === 0 && page.data.length === 0) return [];
    need(page.data.length > 0 && typeof page.cursor?.next === 'string' && !cursors.has(page.cursor.next), 'Assignment absent from message history');
    cursors.add(page.cursor.next);
    route = `/api/session/${sessionID}/message?limit=100&cursor=${encodeURIComponent(page.cursor.next)}`;
  }
  throw new Error('Assignment history exceeds bounded read');
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

export function inspectMessages(binding, messages, { adopting = false } = {}) {
  need(messages[0]?.id === binding.messageID, 'Uncorrelated assignment');
  const tail = messages.slice(1);
  need(!tail.some(message => message.type === 'user'), 'Another user prompt followed the bound assignment');
  const unsupported = tail.find(message => !['assistant', 'idle', 'synthetic', 'compaction'].includes(message.type));
  const knownType = ['system', 'skill', 'shell', 'agent-switched', 'model-switched', 'location-switched'].includes(unsupported?.type) ? unsupported.type : 'unrecognized';
  need(!unsupported, 'Unsupported execution history type: ' + knownType + '; cannot transfer ownership');
  const inputs = tail.filter(message => message.type === 'synthetic');
  if (!inputs.every(message => typeof message.text === 'string' && Number.isFinite(message.time?.created) && message.time.created >= 0)) {
    throw diagnosticError('Invalid synthetic input metadata; no ownership transfer', 'history-correlation', 'history',
      { historyType: 'synthetic', errorCode: 'InvalidSyntheticInput' });
  }
  if (!adopting && inputs.some(message => !nativeInstructions(binding, messages, messages.indexOf(message)))) {
    throw diagnosticError('Synthetic input is not correlated to this assignment read; no ownership transfer', 'history-correlation', 'history',
      { historyType: 'synthetic', errorCode: 'UncorrelatedSyntheticInput' });
  }
  const compactions = tail.filter(message => message.type === 'compaction');
  for (const message of compactions) {
    need(['running', 'completed', 'failed'].includes(message.status), 'Unknown compaction status');
    need(['auto', 'manual'].includes(message.reason) && Number.isFinite(message.time?.created) && message.time.created >= 0, 'Invalid compaction metadata');
    if (message.status === 'completed') need(message.model?.id === MODEL.id && message.model?.providerID === MODEL.providerID &&
      typeof message.summary === 'string', 'Compaction model/summary changed');
  }
  const assistants = tail.filter(message => message.type === 'assistant');
  for (const message of assistants) {
    need(message.model?.id === MODEL.id && message.model?.providerID === MODEL.providerID && Array.isArray(message.content), 'Executor model/history changed');
  }
  if (tail.some(message => message.error || message.retry || message.type === 'idle' && message.outcome === 'failed' ||
    message.type === 'compaction' && message.status === 'failed' ||
    message.type === 'assistant' && ['error', 'length', 'content-filter', 'unknown'].includes(message.finish))) return { kind: 'failed' };
  if (tail.some(message => message.content?.some(part => part.type === 'tool' && part.state?.status === 'error')))
    return { kind: 'failed', toolFailure: !tail.some(message => message.type === 'idle' && message.outcome === 'interrupted') };
  if (tail.some(message => message.type === 'idle' && message.outcome === 'interrupted')) return { kind: 'interrupted' };
  const tools = assistants.flatMap(message => message.content.filter(part => part.type === 'tool').map(part => ({ ...part, messageID: message.id })));
  const final = assistants.at(-1);
  const idle = tail.at(-1);
  return { tools, final, idle, tail };
}

export function interactive(kind, request, binding, history) {
  need(request.sessionID === binding.sessionID && typeof request.id === 'string', 'Wrong interactive session/request');
  const source = kind === 'question' ? request.metadata?.tool : request.source;
  need(source && (kind === 'question' || source.type === 'tool') && history.tools?.some(tool => tool.messageID === source.messageID && tool.id === source.id), 'Interactive request not correlated to this assignment tool');
  if (kind === 'question') {
    need(request.metadata?.kind === 'question' && /^frm_[a-zA-Z0-9]+$/.test(request.id) && Array.isArray(request.fields) && request.fields.length > 0, 'Unknown question form');
    const keys = new Set();
    for (const field of request.fields) {
      need(field && typeof field.key === 'string' && !keys.has(field.key) && ['string', 'multiselect'].includes(field.type) && !field.when && !field.hidden, 'Unsupported question field');
      keys.add(field.key);
      need(field.options === undefined || Array.isArray(field.options) && field.options.every(option => typeof option.value === 'string' && typeof option.label === 'string'), 'Invalid question options');
    }
  } else {
    need(/^per[a-zA-Z0-9_]+$/.test(request.id) && typeof request.action === 'string' && Array.isArray(request.resources) && request.resources.every(resource => typeof resource === 'string'), 'Unknown permission request');
  }
  return { kind, request, fingerprint: fingerprint(request) };
}

export function validateAnswer(request, payload) {
  need(payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 1 && payload.answer && typeof payload.answer === 'object' && !Array.isArray(payload.answer), 'Expected {answer:{field:value}}');
  need(Object.keys(payload.answer).every(key => request.fields.some(field => field.key === key)), 'Unknown answer field');
  for (const field of request.fields) {
    const value = payload.answer[field.key];
    if (value === undefined) { need(field.required === false, 'Missing answer field'); continue; }
    const values = field.type === 'multiselect' ? value : [value];
    need(Array.isArray(values) && values.every(item => typeof item === 'string') && new Set(values).size === values.length, 'Invalid single/multiple answer');
    if (field.type === 'string') need(typeof value === 'string' && value.length >= (field.minLength ?? 0) && value.length <= (field.maxLength ?? Infinity) && (!field.pattern || new RegExp(field.pattern).test(value)), 'Invalid string answer');
    else need(values.length >= (field.minItems ?? 0) && values.length <= (field.maxItems ?? Infinity), 'Invalid selection count');
    need(!field.options || field.custom === true || values.every(item => field.options.some(option => option.value === item)), 'Answer outside offered options');
  }
}

export function completion(history, session, shells) {
  const { final, idle, tools } = history;
  need(final?.finish === 'stop' && Number.isFinite(final.time?.completed), 'No completed final assistant response');
  need(history.tail.filter(message => message.type === 'assistant').every(message => Number.isFinite(message.time?.completed)), 'Unfinished assistant step');
  need(idle?.type === 'idle' && idle.outcome === 'succeeded' && idle.time?.created >= final.time.completed && session.time.idle >= idle.time.created, 'No correlated terminal idle');
  const finalIndex = history.tail.indexOf(final);
  for (const [index, message] of history.tail.entries()) {
    if (message.type === 'synthetic') need(index < finalIndex &&
      message.time.created <= final.time.completed, 'No completed final after synthetic input');
    if (message.type === 'compaction') {
      need(message.status === 'completed', 'Compaction has not completed');
      need(idle.time.created >= message.time.created, 'No terminal idle after compaction');
    }
  }
  need(tools.every(tool => tool.state?.status === 'completed' && Number.isFinite(tool.time?.completed)), 'Outstanding/unknown tool operation');
  need(shells?.data && Array.isArray(shells.data), 'Unknown project shell status');
  need(shells.data.every(shell => ['exited', 'timeout', 'killed'].includes(shell.status) && Number.isFinite(shell.time?.completed)), 'Project shell still running or unknown');
  // Detached processes cannot be certified by a completed launcher. Stop instead of supervising the OS.
  for (const tool of tools) {
    const input = tool.state.input ?? {};
    const shellID = tool.state.metadata?.shellID;
    need(!/background/i.test(tool.name) && (!(input.background === true || tool.state.metadata?.background === true) ||
      typeof shellID === 'string' && shells.data.some(shell => shell.id === shellID)), 'Background operation status unknown; no ownership transfer');
    if (/^(bash|shell|exec|terminal|powershell)$/.test(tool.name)) {
      need(typeof input.command === 'string', 'Unknown shell command');
      need(tool.state.metadata?.status === 'completed' || typeof shellID === 'string' && shells.data.some(shell => shell.id === shellID), 'Unknown shell/background completion status');
      const command = input.command;
      const unquoted = command.replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g, 'quoted')
        .replace(/\b\d+>&\d+\b/g, 'redirect')
        .replace(/(^|[;{])\s*&\s*(?=quoted|\$[a-zA-Z_]|[a-zA-Z_])/g, '$1 ');
      need(!/Start-Process|Start-Job|\bnohup\b|\bdisown\b|\bsetsid\b|\bdetach(?:ed)?\b|\bspawn\b|\bPopen\b|\b(?:cmd\s+\/c\s+)?start\s/i.test(command) &&
        !/(^|[^&])&([^&]|$)/.test(unquoted), 'Detached command status unknown; no ownership transfer');
    }
  }
  const output = final.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  need(output.trim(), 'Empty final response');
  return { kind: 'completed-for-review', result: { assistantID: final.id, text: output, tools: tools.map(tool => ({ id: tool.id, name: tool.name, status: tool.state.status })), endedAt: idle.time.created } };
}
