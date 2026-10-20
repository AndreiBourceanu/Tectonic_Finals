'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { openDb } = require('../src/db');
const { generate, keywords, summary } = require('../src/metadata');

function start(opts = {}) {
  const server = createServer({ now: '2026-09', db: openDb(':memory:'), ...opts });
  return new Promise(r => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const stop = ({ server }) => { server.closeAllConnections?.(); server.close(); server.db.close(); };
const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const FILE = { email: 'Anna.Peeters@acme.be', fileName: 'holiday-carryover.md', countries: ['BE'],
  content: '# Holiday carry-over\nUnused holiday days can be carried over until 31 March.' };

test('metadata generator produces summary and weighted keywords', () => {
  const g = generate('# Bonus rules\nThe bonus is paid pro rata. Bonus bonus.', 'Bonus rules');
  assert.equal(g.keywords[0].keyword, 'bonus');
  assert.ok(g.summary.length > 0 && !g.summary.includes('#'));
  assert.deepEqual(keywords('the and for'), []);
  assert.ok(summary('x'.repeat(1000)).length <= 280);
});

test('upload creates a document with generated metadata and email ownership', async () => {
  const ctx = await start();
  const r = await post(ctx.base, '/api/upload', FILE);
  assert.equal(r.status, 201);
  const { action, document: d } = await r.json();
  assert.equal(action, 'created');
  assert.equal(d.title, 'Holiday carry-over');
  assert.equal(d.ownerEmail, 'anna.peeters@acme.be');
  assert.equal(d.lastEditedByEmail, 'anna.peeters@acme.be');
  assert.equal(d.source, 'upload');
  assert.equal(d.metaSource, 'heuristic');
  assert.equal(d.date, '2026-09');
  assert.ok(d.keywords.includes('holiday'));
  assert.match(d.summary, /carried over/);
  assert.equal(d.originalName, 'holiday-carryover.md');
  assert.ok(d.sizeBytes > 0 && d.contentHash.length === 64);
  stop(ctx);
});

test('update keeps the owner, records the editor, bumps the version and refreshes metadata', async () => {
  const ctx = await start();
  const { document: d } = await (await post(ctx.base, '/api/upload', FILE)).json();
  const r = await post(ctx.base, '/api/upload', { email: 'tom@acme.be', fileName: 'v2.md', replaces: d.file, content: '# Holiday carry-over\nCarry-over now ends 30 April, check with payroll.' });
  assert.equal(r.status, 200);
  const u = (await r.json()).document;
  assert.equal(u.version, 2);
  assert.equal(u.ownerEmail, 'anna.peeters@acme.be');
  assert.equal(u.lastEditedByEmail, 'tom@acme.be');
  assert.ok(u.keywords.includes('april'));
  assert.equal(u.countries[0], 'BE');
  const versions = await (await fetch(`${ctx.base}/api/documents/${d.file}/versions`)).json();
  assert.equal(versions.length, 2);
  stop(ctx);
});

test('uploads link to a question, reuse claims for equal answers and create conflicts for different ones', async () => {
  const ctx = await start();
  const up = async (email, name, says) => (await (await post(ctx.base, '/api/upload', { email, fileName: name, countries: ['DE'], topic: 'leaver-bonus', answer: says, content: `# ${name}\n${says}` })).json()).document;
  const a = await up('jan@nw.de', 'a.md', 'Pro rata by months worked');
  const b = await up('eva@nw.de', 'b.md', 'pro rata by months worked');
  const c = await up('max@nw.de', 'c.md', 'Full bonus');
  assert.equal(a.claim, b.claim);
  assert.notEqual(a.claim, c.claim);
  const ans = await (await post(ctx.base, '/api/answer', { questionId: 'leaver-bonus', country: 'DE' })).json();
  assert.equal(ans.gap, false);
  assert.ok(ans.conflict);
  stop(ctx);
});

test('upload validation and duplicate detection', async () => {
  const ctx = await start();
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, email: 'nope' })).status, 400);
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, fileName: 'x.exe' })).status, 400);
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, content: '  ' })).status, 400);
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, countries: undefined })).status, 400);
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, topic: 'leaver-bonus' })).status, 400); // needs "what it says"
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, replaces: 'nope.md' })).status, 404);
  assert.equal((await post(ctx.base, '/api/upload', FILE)).status, 201);
  const dup = await post(ctx.base, '/api/upload', { ...FILE, email: 'other@acme.be' });
  assert.equal(dup.status, 409);
  assert.match((await dup.json()).error, /already stored/);
  stop(ctx);
});

test('documents over the size limit are rejected with a clear message', async () => {
  const ctx = await start();
  const big = await post(ctx.base, '/api/upload', { ...FILE, content: 'a '.repeat(100_001) });
  assert.equal(big.status, 400);
  assert.match((await big.json()).error, /too large/);
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, content: 'word '.repeat(39_000) })).status, 201); // ~195 KB is fine
  stop(ctx);
});

test('uploaded documents are searchable by their keywords', async () => {
  const ctx = await start();
  await post(ctx.base, '/api/upload', FILE);
  const r = await (await fetch(ctx.base + '/api/search?q=' + encodeURIComponent('holiday carry over'))).json();
  assert.equal(r.documents[0].title, 'Holiday carry-over');
  const q = await (await fetch(ctx.base + '/api/search?q=' + encodeURIComponent('how is a leaver bonus calculated'))).json();
  assert.equal(q.questions[0].id, 'leaver-bonus');
  const none = await (await fetch(ctx.base + '/api/search?q=zzzzqqq')).json();
  assert.deepEqual([none.questions.length, none.documents.length], [0, 0]);
  assert.equal((await (await fetch(ctx.base + '/api/search?q=')).json()).documents.length, 0);
  stop(ctx);
});

test('seeded documents have generated metadata', async () => {
  const ctx = await start();
  const docs = await (await fetch(ctx.base + '/api/documents')).json();
  assert.ok(docs.every(d => d.summary && d.keywords.length));
  stop(ctx);
});

test('a new type is added to the database on first use; matching ignores case and spacing', async () => {
  const ctx = await start();
  const types0 = await (await fetch(ctx.base + '/api/types')).json();
  for (const t of ['Policy', 'Wiki', 'Chat', 'Email', 'Contract', 'Document']) assert.ok(types0.includes(t), t);
  assert.ok(!types0.includes('Meeting notes'));
  const r = await (await post(ctx.base, '/api/upload', { ...FILE, type: '  Meeting   notes ' })).json();
  assert.equal(r.document.type, 'Meeting notes');
  assert.equal(r.added.type, 'Meeting notes');
  const r2 = await (await post(ctx.base, '/api/upload', { ...FILE, fileName: 'b.md', content: '# Other\nSomething else.', type: 'meeting NOTES' })).json();
  assert.equal(r2.document.type, 'Meeting notes');   // reuses the stored spelling
  assert.equal(r2.added.type, null);
  const r3 = await (await post(ctx.base, '/api/upload', { ...FILE, fileName: 'c.md', content: '# Third\nMore text.', type: 'policy' })).json();
  assert.equal(r3.document.type, 'Policy');
  assert.equal(r3.added.type, null);
  const types = await (await fetch(ctx.base + '/api/types')).json();
  assert.equal(types.filter(t => t.toLowerCase() === 'meeting notes').length, 1);
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, fileName: 'd.md', content: 'zzz', type: '<script>' })).status, 400);
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, fileName: 'd.md', content: 'zzz', type: 'x'.repeat(41) })).status, 400);
  assert.ok(!(await (await fetch(ctx.base + '/api/types')).json()).includes('<script>'));
  // updating can change the type to a new one too; blank keeps the current one
  const u = await (await post(ctx.base, '/api/upload', { email: 'tom@acme.be', fileName: 'v.md', replaces: r.document.file, content: '# Meeting\nNew text.', type: 'Minutes' })).json();
  assert.equal(u.document.type, 'Minutes');
  const k = await (await post(ctx.base, '/api/upload', { email: 'tom@acme.be', fileName: 'v.md', replaces: r.document.file, content: '# Meeting\nNewer text.' })).json();
  assert.equal(k.document.type, 'Minutes');
  stop(ctx);
});

test('manual keywords are stored, merged with generated ones, kept on update, and new ones are added', async () => {
  const ctx = await start();
  const r = await (await post(ctx.base, '/api/upload', { ...FILE, keywords: 'Carry-over, vacation , holiday' })).json();
  assert.deepEqual(r.document.keywords.slice(0, 3).sort(), ['carry-over', 'holiday', 'vacation']);
  assert.ok(r.document.keywords.includes('days'));              // generated ones are still there
  assert.deepEqual(r.added.keywords.sort(), ['carry-over', 'vacation']); // "holiday" already existed
  const all = await (await fetch(ctx.base + '/api/keywords?limit=500')).json();
  assert.ok(all.some(k => k.keyword === 'vacation' && k.uses === 1));
  // search finds the document through a manual keyword that is not in its text
  const found = await (await fetch(ctx.base + '/api/search?q=vacation')).json();
  assert.equal(found.documents[0].title, 'Holiday carry-over');
  // update without keywords: manual ones survive, generated ones follow the new text
  const u = await (await post(ctx.base, '/api/upload', { email: 'tom@acme.be', fileName: 'v2.md', replaces: r.document.file, content: '# Holiday carry-over\nNow ends 30 April.' })).json();
  assert.ok(u.document.keywords.includes('vacation'));
  assert.ok(u.document.keywords.includes('april'));
  assert.ok(!u.document.keywords.includes('days'));
  // update with new keywords replaces the manual set
  const u2 = await (await post(ctx.base, '/api/upload', { email: 'tom@acme.be', fileName: 'v3.md', replaces: r.document.file, content: '# Holiday carry-over\nEnds 30 April, see payroll.', keywords: ['leave'] })).json();
  assert.ok(u2.document.keywords.includes('leave') && !u2.document.keywords.includes('vacation'));
  assert.equal((await post(ctx.base, '/api/upload', { ...FILE, fileName: 'e.md', content: 'qqq', keywords: 'ok, <b>' })).status, 400);
  stop(ctx);
});

test('home page contains the search bar and upload form', async () => {
  const ctx = await start();
  const html = await (await fetch(ctx.base + '/')).text();
  for (const id of ['id="q"', 'id="sf"', 'id="uf"', 'id="email"', 'id="file"', 'id="kwin"', 'id="type"', 'id="typelist"', 'id="cadd"', 'id="cbtn"']) assert.ok(html.includes(id), id);
  for (const gone of ['id="topic"', 'id="says"', 'id="token"']) assert.ok(!html.includes(gone), gone);
  stop(ctx);
});
