'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { openDb } = require('../src/db');

function start(opts = {}) {
  const server = createServer({ now: '2026-09', db: openDb(':memory:'), ...opts });
  return new Promise(r => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const stop = ({ server }) => { server.closeAllConnections?.(); server.close(); server.db.close(); };
const call = (base, method, p, body, headers = {}) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
});
const ask = async (base, questionId, country) => (await call(base, 'POST', '/api/answer', { questionId, country })).json();

const DE_DOC = {
  title: 'Leaver bonus rule (Germany)', type: 'Policy', date: '2026-09', owner: 'Jan Weber (Compliance DE)',
  countries: ['DE'], topic: 'leaver-bonus', claim: 'A', answer: 'Pro rata by months worked',
  body: '# Leaver bonus - Germany\nPro rata by months worked.', editedBy: 'Jan Weber'
};

test('creating a document is live: a knowledge gap closes without a restart', async () => {
  const ctx = await start();
  const before = await ask(ctx.base, 'leaver-bonus', 'DE');
  assert.equal(before.gap, true);

  const res = await call(ctx.base, 'POST', '/api/documents', DE_DOC);
  assert.equal(res.status, 201);
  const doc = await res.json();
  assert.equal(doc.file, 'leaver-bonus-rule-germany.md');
  assert.equal(doc.version, 1);

  const after = await ask(ctx.base, 'leaver-bonus', 'DE');
  assert.equal(after.gap, false);
  assert.equal(after.verdict, 'rely');
  assert.equal(after.basedOn.title, DE_DOC.title);

  const list = await (await fetch(ctx.base + '/api/documents')).json();
  assert.equal(list.length, 12);
  stop(ctx);
});

test('updating a document is live, merges fields and keeps version history', async () => {
  const ctx = await start();
  await call(ctx.base, 'POST', '/api/documents', DE_DOC);
  const file = 'leaver-bonus-rule-germany.md';

  const res = await call(ctx.base, 'PUT', `/api/documents/${file}`, { date: '2020-01', editedBy: 'Marc V.' });
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.version, 2);
  assert.equal(doc.title, DE_DOC.title);          // untouched fields survive the merge
  assert.equal(doc.date, '2020-01');

  const stale = await ask(ctx.base, 'leaver-bonus', 'DE');
  assert.equal(stale.verdict, 'check');            // an old document is trusted less

  const versions = await (await fetch(`${ctx.base}/api/documents/${file}/versions`)).json();
  assert.deepEqual(versions.map(v => v.version), [2, 1]);
  assert.equal(versions[0].editedBy, 'Marc V.');
  assert.equal(versions[1].date, '2026-09');
  assert.equal(versions[1].editedBy, 'Jan Weber');
  stop(ctx);
});

test('new owners become people records', async () => {
  const ctx = await start();
  await call(ctx.base, 'POST', '/api/documents', DE_DOC);
  const people = await (await fetch(ctx.base + '/api/people')).json();
  const jan = people.find(p => p.name === 'Jan Weber');
  assert.equal(jan.role, 'Compliance DE');
  assert.equal(jan.owned, 2);                      // DE handbook + the new document
  stop(ctx);
});

test('validation rejects bad documents', async () => {
  const ctx = await start();
  const post = body => call(ctx.base, 'POST', '/api/documents', { ...DE_DOC, ...body });
  assert.equal((await post({ date: '2026-13' })).status, 400);
  assert.equal((await post({ date: 'September' })).status, 400);
  assert.equal((await post({ countries: ['FR'] })).status, 400);
  assert.equal((await post({ countries: [] })).status, 400);
  assert.equal((await post({ topic: 'nope' })).status, 400);
  assert.equal((await post({ claim: undefined })).status, 400);
  assert.equal((await post({ title: '' })).status, 400);
  assert.equal((await post({ body: '' })).status, 400);
  assert.equal((await post({ file: '../evil.md' })).status, 400);
  assert.equal((await post({ file: 'payroll-manual-v7.md' })).status, 409);
  assert.equal((await call(ctx.base, 'PUT', '/api/documents/nope.md', { title: 'x' })).status, 404);
  assert.equal((await fetch(ctx.base + '/api/documents/nope.md/versions')).status, 404);
  const list = await (await fetch(ctx.base + '/api/documents')).json();
  assert.equal(list.length, 11);                   // nothing was stored
  stop(ctx);
});

test('hostile input is stored as plain text, never executed as SQL', async () => {
  const ctx = await start();
  const evil = "x'); DROP TABLE documents;--";
  const res = await call(ctx.base, 'POST', '/api/documents', { ...DE_DOC, title: evil, owner: evil });
  assert.equal(res.status, 201);
  const list = await (await fetch(ctx.base + '/api/documents')).json();
  assert.equal(list.length, 12);
  assert.ok(list.some(d => d.title === evil));
  stop(ctx);
});

test('write routes require the admin token when one is configured', async () => {
  const ctx = await start({ adminToken: 's3cret' });
  assert.equal((await call(ctx.base, 'POST', '/api/documents', DE_DOC)).status, 401);
  assert.equal((await call(ctx.base, 'POST', '/api/documents', DE_DOC, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call(ctx.base, 'POST', '/api/documents', DE_DOC, { Authorization: 'Bearer s3cret' })).status, 201);
  assert.equal((await fetch(ctx.base + '/api/documents')).status, 200);   // reads stay open
  stop(ctx);
});

test('gap log lives in the database', async () => {
  const ctx = await start();
  await ask(ctx.base, 'leaver-bonus', 'DE');
  await ask(ctx.base, 'leaver-bonus', 'BE');
  const g = await (await fetch(ctx.base + '/api/gaps')).json();
  const de = g.ranked.find(r => r.country === 'DE');
  const be = g.ranked.find(r => r.country === 'BE');
  assert.equal(de.gaps, 1);
  assert.equal(be.conflicts, 1);
  stop(ctx);
});
