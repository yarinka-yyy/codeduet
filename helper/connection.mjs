import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

export const MODEL = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
const categories = new Set(['unknown', 'request-read', 'request-timeout', 'request-http', 'request-json',
  'event-open', 'event-handshake-timeout', 'event-http', 'event-content-type', 'event-eof', 'event-read',
  'event-json', 'event-shape', 'event-buffer-limit', 'engine-shutdown', 'interrupted', 'deadline']);
const stages = new Set(['connection', 'request', 'handshake', 'stream', 'decode', 'wait', 'snapshot']);
const names = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const eventType = /^(?:(?:session\.)?(?:execution\.(?:started|running|succeeded|failed|interrupted)|step\.(?:ended|failed|retry))|(?:form|permission)\.(?:created|updated|replied|resolved)|tool\.(?:success|failed)|(?:server|location)\.(?:shutdown|disposed)|other)$/;
export function validateDiagnostic(value) {
  requireValue(value && categories.has(value.category) && stages.has(value.stage) &&
    Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 &&
    Object.keys(value).every(key => ['category', 'stage', 'elapsedMs', 'lastEvent', 'httpStatus', 'errorName', 'errorCode'].includes(key)), 'Invalid diagnostic');
  requireValue(value.lastEvent === null || value.lastEvent && Object.keys(value.lastEvent).length === 2 &&
    Number.isSafeInteger(value.lastEvent.at) && value.lastEvent.at >= 0 && eventType.test(value.lastEvent.type), 'Invalid diagnostic event');
  if (value.httpStatus !== undefined) requireValue(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599, 'Invalid diagnostic HTTP status');
  if (value.errorName !== undefined) requireValue(names.has(value.errorName), 'Invalid diagnostic error name');
  if (value.errorCode !== undefined) requireValue(codes.has(value.errorCode), 'Invalid diagnostic error code');
  return value;
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

export async function connect({ registrationPath = resolve(homedir(), '.local/state/opencode/service.json'), fetchImpl = fetch } = {}) {
  let registration;
  try { registration = JSON.parse(readFileSync(registrationPath, 'utf8')); } catch { throw new Error('Missing or invalid engine registration'); }
  requireValue(registration && typeof registration.id === 'string' && registration.id.length > 0 && typeof registration.password === 'string' && registration.password.length > 0, 'Invalid engine registration fields');
  requireValue(registration.version === '2.1.4', 'Unsupported engine version; revalidate API');
  const base = localEndpoint(registration.url);
  const auth = 'Basic ' + Buffer.from('opencode:' + registration.password).toString('base64');
  async function request(route, body) {
    requireValue(typeof route === 'string' && route.startsWith('/api/') && !route.startsWith('//'), 'Invalid API route');
    let response;
    const startedAt = Date.now(), signal = AbortSignal.timeout(20_000);
    try {
      response = await fetchImpl(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal, redirect: 'error',
      });
    } catch (error) {
      // Never echo response bodies, auth headers or exceptions containing them.
      throw diagnosticError(body === undefined ? 'Engine read failed' : 'Engine mutation uncertain; do not retry',
        signal.aborted ? 'request-timeout' : 'request-read', 'request', { elapsedMs: Date.now() - startedAt }, error);
    }
    if (!response.ok) throw diagnosticError(`Engine HTTP ${response.status}` + (body === undefined ? '' : '; mutation uncertain, do not retry'),
      'request-http', 'request', { elapsedMs: Date.now() - startedAt, httpStatus: response.status });
    if (response.status === 204) return undefined;
    try { return await response.json(); }
    catch (error) { throw diagnosticError(body === undefined ? 'Invalid engine JSON' : 'Mutation response invalid; do not retry',
      signal.aborted ? 'request-timeout' : 'request-json', 'request', { elapsedMs: Date.now() - startedAt }, error); }
  }
  const [info, models] = await Promise.all([request('/api/info'), request('/api/model')]);
  requireValue(info?.version === registration.version && Array.isArray(models?.data), 'Invalid engine info/model response');
  requireValue(models.data.some(model => model.providerID === MODEL.providerID && model.id === MODEL.id && model.enabled === true && model.status === 'active'), 'Required Go model unavailable; no fallback');
  return {
    engineID: registration.id, version: info.version, request,
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
}
