import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

export const MODEL = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
export const ENGINE_VERSIONS = Object.freeze(['2.1.4', '2.2.0', '2.2.1']);
const releaseVersion = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
const categories = new Set(['unknown', 'request-read', 'request-timeout', 'request-http', 'request-json',
  'event-open', 'event-handshake-timeout', 'event-http', 'event-content-type', 'event-eof', 'event-read',
  'event-json', 'event-shape', 'event-buffer-limit', 'engine-shutdown', 'location-shutdown', 'interrupted', 'deadline',
  'state-locked', 'state-access', 'state-io', 'engine-version', 'history-correlation']);
const stages = new Set(['connection', 'request', 'handshake', 'stream', 'decode', 'wait', 'snapshot', 'history', 'state-directory', 'state-lock', 'state-write']);
const names = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'EEXIST', 'EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED', 'ENOENT', 'ENOTDIR', 'EISDIR',
  'ENOSPC', 'EDQUOT', 'EIO', 'EMFILE', 'ENFILE', 'ELOOP', 'EBUSY', 'ENAMETOOLONG', 'UNKNOWN',
  'InvalidCursorError', 'InvalidRequestError', 'UncorrelatedSyntheticInput', 'InvalidSyntheticInput']);
const operations = new Map([
  ['GET /api/info', 'server.info'], ['GET /api/model', 'model.list'],
  ['GET /api/session', 'session.list'], ['POST /api/session', 'session.create'],
  ['GET /api/session/active', 'session.active'], ['GET /api/session/:session', 'session.get'],
  ['GET /api/session/:session/message', 'session.message.list'],
  ['GET /api/session/:session/form', 'session.form.list'],
  ['GET /api/session/:session/permission', 'session.permission.list'],
  ['GET /api/shell', 'shell.list'], ['POST /api/session/:session/prompt', 'session.prompt'],
  ['POST /api/session/:session/form/:request/reply', 'session.form.reply'],
  ['POST /api/session/:session/permission/:request/reply', 'session.permission.reply'],
]);
const operationNames = new Set(['unknown', ...operations.values()]);
function requestDetails(route, body) {
  const [path, query] = route.split('?'), method = body === undefined ? 'GET' : 'POST';
  const template = path.replace(/\/ses_[a-zA-Z0-9]+(?=\/|$)/g, '/:session')
    .replace(/(\/(?:form|permission))\/(?:frm_|per)[a-zA-Z0-9_]+(?=\/|$)/g, '$1/:request');
  const operation = operations.get(method + ' ' + template) ?? 'unknown';
  return { operation, method, ...(operation === 'session.message.list' ?
    { page: new URLSearchParams(query).has('cursor') ? 'cursor' : 'first' } : {}) };
}

async function apiErrorCode(response) {
  if (response.status !== 400 || !response.body) return undefined;
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) return undefined;
      chunks.push(part.value);
    }
    const tag = JSON.parse(Buffer.concat(chunks).toString('utf8'))?._tag;
    return ['InvalidCursorError', 'InvalidRequestError'].includes(tag) ? tag : undefined;
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => {}); }
}
const eventType = /^(?:(?:session\.)?(?:execution\.(?:started|running|succeeded|failed|interrupted)|step\.(?:ended|failed|retry))|(?:form|permission)\.(?:created|updated|replied|resolved)|tool\.(?:success|failed)|(?:server|location)\.(?:shutdown|disposed)|other)$/;
export function validateDiagnostic(value) {
  requireValue(value && categories.has(value.category) && stages.has(value.stage) &&
    Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 &&
    Object.keys(value).every(key => ['category', 'stage', 'elapsedMs', 'lastEvent', 'httpStatus', 'errorName', 'errorCode', 'operation', 'method', 'page', 'expectedVersions', 'observedVersion', 'versionSource', 'historyType', 'eventScope'].includes(key)), 'Invalid diagnostic');
  requireValue(value.lastEvent === null || value.lastEvent && Object.keys(value.lastEvent).length === 2 &&
    Number.isSafeInteger(value.lastEvent.at) && value.lastEvent.at >= 0 && eventType.test(value.lastEvent.type), 'Invalid diagnostic event');
  if (value.httpStatus !== undefined) requireValue(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599, 'Invalid diagnostic HTTP status');
  if (value.errorName !== undefined) requireValue(names.has(value.errorName), 'Invalid diagnostic error name');
  if (value.errorCode !== undefined) requireValue(codes.has(value.errorCode), 'Invalid diagnostic error code');
  if (value.operation !== undefined) requireValue(operationNames.has(value.operation), 'Invalid diagnostic operation');
  if (value.method !== undefined) requireValue(['GET', 'POST'].includes(value.method), 'Invalid diagnostic method');
  if (value.page !== undefined) requireValue(['first', 'cursor'].includes(value.page), 'Invalid diagnostic page');
  if (value.historyType !== undefined) requireValue(value.category === 'history-correlation' && value.historyType === 'synthetic', 'Invalid diagnostic history type');
  if (value.eventScope !== undefined) requireValue(['server', 'selected', 'unknown'].includes(value.eventScope) &&
    ['engine-shutdown', 'location-shutdown'].includes(value.category), 'Invalid lifecycle scope');
  if (value.category === 'engine-version' || ['expectedVersions', 'observedVersion', 'versionSource'].some(key => value[key] !== undefined)) {
    requireValue(value.category === 'engine-version' && Array.isArray(value.expectedVersions) &&
      value.expectedVersions.length >= 1 && value.expectedVersions.length <= 8 && value.expectedVersions.every(releaseVersion) &&
      (value.observedVersion === 'unknown' || releaseVersion(value.observedVersion)) &&
      ['registration', 'server-info'].includes(value.versionSource), 'Invalid diagnostic engine version');
  }
  return value;
}

function versionMismatch(observed, expectedVersions, versionSource) {
  return diagnosticError('Unsupported engine version; revalidate API', 'engine-version', 'connection', {
    expectedVersions: [...expectedVersions], observedVersion: releaseVersion(observed) ? observed : 'unknown', versionSource,
  });
}

export function diagnose(error, category, stage, details = {}) {
  let previous;
  try { if (error?.diagnostic) previous = validateDiagnostic(error.diagnostic); } catch { /* Untrusted diagnostics are never copied. */ }
  const code = error?.code ?? error?.cause?.code;
  return validateDiagnostic({ category, stage, elapsedMs: 0, lastEvent: null,
    ...(names.has(error?.name) ? { errorName: error.name } : {}),
    ...(codes.has(code) ? { errorCode: code } : {}), ...previous, ...details });
}

export function diagnosticError(message, category, stage, details, cause) {
  return Object.assign(new Error(message), { diagnostic: diagnose(cause, category, stage, details) });
}

export function diagnosticEvent(type) { return eventType.test(type) ? type : 'other'; }

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function localEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid engine URL'); }
  requireValue(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Non-loopback HTTP engine');
  requireValue(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Invalid engine URL components');
  return url.origin;
}

export async function connect({ registrationPath = resolve(homedir(), '.local/state/opencode/service.json'),
  fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const startedAt = now();
  let attempts = 0, lastError;
  const finishError = error => {
    const lastDiagnostic = error?.diagnostic ? validateDiagnostic(error.diagnostic) : diagnose(error, 'unknown', 'connection');
    return Object.assign(error instanceof Error ? error : new Error('Engine connection failed'), {
      bootstrap: { attempts, retried: attempts > 1, lastDiagnostic },
    });
  };
  const retryable = error => {
    const diagnostic = error?.diagnostic;
    return diagnostic && ([502, 503, 504].includes(diagnostic.httpStatus) ||
      diagnostic.category === 'request-timeout' ||
      diagnostic.category === 'request-read' &&
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(diagnostic.errorCode));
  };
  while (attempts < 3) {
    const remaining = 30_000 - (now() - startedAt);
    if (remaining <= 0) break;
    attempts++;
    try {
      let registration;
      try { registration = JSON.parse(readFileSync(registrationPath, 'utf8')); }
      catch { throw new Error('Missing or invalid engine registration'); }
      requireValue(registration && typeof registration.id === 'string' && registration.id.length > 0 &&
        typeof registration.password === 'string' && registration.password.length > 0, 'Invalid engine registration fields');
      if (!ENGINE_VERSIONS.includes(registration.version)) throw versionMismatch(registration.version, ENGINE_VERSIONS, 'registration');
      const base = localEndpoint(registration.url);
      const auth = 'Basic ' + Buffer.from('opencode:' + registration.password).toString('base64');
      async function request(route, body, parentSignal, timeoutMs = 20_000) {
        requireValue(typeof route === 'string' && route.startsWith('/api/') && !route.startsWith('//'), 'Invalid API route');
        const details = requestDetails(route, body), requestStarted = now();
        const controller = new AbortController();
        let timedOut = false;
        const abortFromParent = () => controller.abort(parentSignal.reason);
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
        const timer = setTimer(() => {
          timedOut = true;
          controller.abort(new DOMException('Request timed out', 'TimeoutError'));
        }, timeoutMs);
        try {
          const response = await fetchImpl(base + route, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal, redirect: 'error',
          });
          if (!response.ok) {
            const errorCode = await apiErrorCode(response);
            if (response.status !== 400) await response.body?.cancel().catch(() => {});
            throw diagnosticError('Engine HTTP ' + response.status + (body === undefined ? '' : '; mutation uncertain, do not retry'),
              'request-http', 'request', { ...details, elapsedMs: Math.max(0, now() - requestStarted), httpStatus: response.status,
                ...(errorCode ? { errorCode } : {}) });
          }
          if (response.status === 204) return undefined;
          try { return await response.json(); }
          catch (error) {
            throw diagnosticError(body === undefined ? 'Invalid engine JSON' : 'Mutation response invalid; do not retry',
              timedOut ? 'request-timeout' : 'request-json', 'request',
              { ...details, elapsedMs: Math.max(0, now() - requestStarted) }, error);
          }
        } catch (error) {
          if (error?.diagnostic) throw error;
          throw diagnosticError(body === undefined ? 'Engine read failed' : 'Engine mutation uncertain; do not retry',
            timedOut ? 'request-timeout' : 'request-read', 'request',
            { ...details, elapsedMs: Math.max(0, now() - requestStarted) }, error);
        } finally {
          clearTimer(timer);
          parentSignal?.removeEventListener('abort', abortFromParent);
        }
      }
      const attemptController = new AbortController();
      const requestTimeout = Math.max(1, Math.min(20_000, 30_000 - (now() - startedAt)));
      const bootstrapRequests = [
        request('/api/info', undefined, attemptController.signal, requestTimeout),
        request('/api/model', undefined, attemptController.signal, requestTimeout),
      ];
      let info, models;
      try { [info, models] = await Promise.all(bootstrapRequests); }
      catch (error) {
        attemptController.abort();
        await Promise.allSettled(bootstrapRequests);
        throw error;
      }
      requireValue(typeof info?.version === 'string' && Array.isArray(models?.data), 'Invalid engine info/model response');
      if (info.version !== registration.version) throw versionMismatch(info.version, [registration.version], 'server-info');
      requireValue(models.data.some(model => model.providerID === MODEL.providerID && model.id === MODEL.id &&
        model.enabled === true && model.status === 'active'), 'Required Go model unavailable; no fallback');
      const bootstrap = { attempts, retried: attempts > 1 };
      return {
        engineID: registration.id, version: info.version, request, bootstrap,
        async events(signal) {
          try {
            // SSE lifetime belongs to wait, not fetch's implicit body-idle deadline.
            return await new Promise((resolve, reject) => {
              const streamRequest = httpRequest(base + '/api/event', {
                agent: false, signal, headers: { Authorization: auth, Accept: 'text/event-stream' },
              }, response => {
                response.setTimeout(0);
                resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
                  headers: new Headers({ 'content-type': response.headers['content-type'] ?? '' }),
                  body: Readable.toWeb(response) });
              });
              streamRequest.on('error', reject);
              streamRequest.end();
            });
          } catch (error) { throw diagnosticError('Event connection uncertain', 'event-open', 'handshake', {}, error); }
        },
      };
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempts >= 3) throw finishError(error);
      const delay = attempts === 1 ? 500 : 1_000;
      if (30_000 - (now() - startedAt) <= delay) throw finishError(error);
      await sleep(delay);
    }
  }
  throw finishError(lastError ?? new Error('Engine connection budget exhausted'));
}
