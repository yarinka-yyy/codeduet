import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const MODEL = Object.freeze({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
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
    try {
      response = await fetchImpl(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
    } catch {
      // Never echo response bodies, auth headers or exceptions containing them.
      throw new Error(body === undefined ? 'Engine read failed' : 'Engine mutation uncertain; do not retry');
    }
    requireValue(response.ok, `Engine HTTP ${response.status}` + (body === undefined ? '' : '; mutation uncertain, do not retry'));
    if (response.status === 204) return undefined;
    try { return await response.json(); }
    catch { throw new Error(body === undefined ? 'Invalid engine JSON' : 'Mutation response invalid; do not retry'); }
  }
  const [info, models] = await Promise.all([request('/api/info'), request('/api/model')]);
  requireValue(info?.version === registration.version && Array.isArray(models?.data), 'Invalid engine info/model response');
  requireValue(models.data.some(model => model.providerID === MODEL.providerID && model.id === MODEL.id && model.enabled === true && model.status === 'active'), 'Required Go model unavailable; no fallback');
  return {
    engineID: registration.id, version: info.version, request,
    async events(signal) {
      try {
        return await fetchImpl(base + '/api/event', { headers: { Authorization: auth }, signal, redirect: 'error' });
      } catch { throw new Error('Event connection uncertain'); }
    },
  };
}
