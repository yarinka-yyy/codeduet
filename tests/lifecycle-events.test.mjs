import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { watch } from '../helper/interaction.mjs';
import { validateDiagnostic } from '../helper/connection.mjs';

async function stream(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'duet-lifecycle-'));
  const workspace = resolve(root, 'selected'), foreign = resolve(root, 'foreign');
  mkdirSync(workspace); mkdirSync(foreign);
  let controller;
  const client = { events: async () => new Response(new ReadableStream({ start(value) { controller = value; } }),
    { headers: { 'content-type': 'text/event-stream' } }) };
  const reader = await watch(client, 'ses_selected', new AbortController().signal, workspace);
  t.after(async () => { await reader.close(); rmSync(root, { recursive: true }); });
  return { reader, workspace, foreign, end: () => controller.close(), emit: event => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n')) };
}

for (const type of ['location.shutdown', 'location.disposed']) {
  test(type + ' for a foreign location does not stop or wake the selected session', async t => {
    const f = await stream(t);
    f.emit({ type, location: { directory: f.foreign }, data: { sessionID: 'ses_selected' } });
    await new Promise(done => setImmediate(done));
    assert.equal(f.reader.fault, null);
    f.emit({ type: 'form.created', data: { sessionID: 'ses_selected' } });
    await f.reader.next(1000);
    assert.equal(f.reader.fault, null);
    assert.equal(f.reader.observation.lastEvent.type, 'form.created');
  });
  for (const scope of ['selected', 'unknown']) test(type + ' with ' + scope + ' scope fails closed with exact cause', async t => {
    const f = await stream(t);
    f.emit({ type, ...(scope === 'selected' ? { location: { directory: f.workspace } } : {}), data: { sessionID: 'ses_other' } });
    await f.reader.next(1000);
    const diagnostic = validateDiagnostic(f.reader.diagnostic);
    assert.equal(f.reader.fault, 'connection-uncertain');
    assert.equal(diagnostic.category, 'location-shutdown');
    assert.equal(diagnostic.eventScope, scope);
    assert.equal(diagnostic.lastEvent.type, type);
    assert.ok(!JSON.stringify(diagnostic).includes(f.workspace));
  });
}
test('server shutdown remains global and EOF remains uncertain', async t => {
  const f = await stream(t);
  f.emit({ type: 'server.shutdown', location: { directory: resolve('unrelated') }, data: {} });
  await f.reader.next(1000);
  assert.equal(f.reader.diagnostic.category, 'engine-shutdown');
  assert.equal(f.reader.diagnostic.eventScope, 'server');
  assert.equal(f.reader.diagnostic.lastEvent.type, 'server.shutdown');
  const eof = await stream(t); eof.end(); await eof.reader.next(1000);
  assert.equal(eof.reader.diagnostic.category, 'event-eof');
});
