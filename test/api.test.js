'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { openDb } = require('../src/db');

// No top-level before/after hooks: Node 18 does not run them. The server starts at load time
// and the last test closes it.
const server = createServer({ now: '2026-09', db: openDb(':memory:') });
const ready = new Promise(r => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));

const post = async (p, body) => fetch((await ready) + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('GET /api/health', async () => {
  const j = await (await fetch((await ready) + '/api/health')).json();
  assert.equal(j.ok, true);
  assert.equal(j.now, '2026-09');
  assert.equal(j.documents, 11);
  assert.ok(['node:sqlite', 'better-sqlite3'].includes(j.driver));
});

test('GET /api/questions lists the questions', async () => {
  const j = await (await fetch((await ready) + '/api/questions')).json();
  assert.equal(j.questions.length, 3);
  assert.deepEqual(j.countries, ['BE', 'NL', 'DE']);
});

test('GET / serves the UI', async () => {
  const r = await fetch((await ready) + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Trust Lens/);
});

test('POST /api/answer returns a verdict with explanations', async () => {
  const r = await post('/api/answer', { questionId: 'leaver-bonus', country: 'BE' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.verdict, 'check');
  assert.ok(j.sources.every(s => s.why.fresh && s.why.owner && s.why.applies && s.why.agreed));
});

test('POST /api/answer validates input', async () => {
  assert.equal((await post('/api/answer', { questionId: 'nope', country: 'BE' })).status, 400);
  assert.equal((await post('/api/answer', { questionId: 'leaver-bonus', country: 'FR' })).status, 400);
  assert.equal((await post('/api/answer', '{not json')).status, 400);
});

test('GET /api/gaps logs non-reliable answers only', async () => {
  await post('/api/answer', { questionId: 'retro-correction', country: 'NL' });
  await post('/api/answer', { questionId: 'leaver-bonus', country: 'DE' });
  await post('/api/answer', { questionId: 'leaver-bonus', country: 'DE' });
  const j = await (await fetch((await ready) + '/api/gaps')).json();
  const top = j.ranked[0];
  assert.equal(top.questionId, 'leaver-bonus');
  assert.equal(top.country, 'DE');
  assert.ok(top.asked >= 2);
  assert.ok(!j.recent.some(g => g.questionId === 'retro-correction'));
});

test('unknown route returns 404', async () => {
  assert.equal((await fetch((await ready) + '/nope')).status, 404);
});

test('GET /api/documents lists corpus files without bodies', async () => {
  const j = await (await fetch((await ready) + '/api/documents')).json();
  assert.equal(j.length, 11);
  assert.ok(j.every(d => d.body === undefined));
});

test('GET /api/documents/:file returns the source text; unknown file is 404', async () => {
  const j = await (await fetch((await ready) + '/api/documents/payroll-manual-v7.md')).json();
  assert.match(j.body, /pro rata by months worked/);
  assert.equal((await fetch((await ready) + '/api/documents/..%2Fpackage.json')).status, 404);
});

test('answers point back to their source file', async () => {
  const j = await (await post('/api/answer', { questionId: 'leaver-bonus', country: 'BE' })).json();
  assert.equal(j.sources[0].file, 'payroll-manual-v7.md');
});

test('oversized body returns 413', async () => {
  const r = await post('/api/answer', { questionId: 'x'.repeat(20_000), country: 'BE' });
  assert.equal(r.status, 413);
});

test('non-object body returns 400', async () => {
  assert.equal((await post('/api/answer', '[1,2]')).status, 400);
});

test('shut down', async () => {
  await ready;
  server.closeAllConnections?.();
  server.close();
  server.db.close();
});
