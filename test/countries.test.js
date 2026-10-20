'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { openDb } = require('../src/db');
const { ISO, resolve } = require('../src/countries');

function start() {
  const server = createServer({ now: '2026-09', db: openDb(':memory:') });
  return new Promise(r => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const stop = ({ server }) => { server.closeAllConnections?.(); server.close(); server.db.close(); };
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('ISO list has 249 unique countries and resolves names, codes, accents and aliases', () => {
  assert.equal(ISO.length, 249);
  assert.equal(new Set(ISO.map(c => c.code)).size, 249);
  assert.deepEqual(resolve('France'), { code: 'FR', name: 'France' });
  assert.equal(resolve('  fr ').code, 'FR');
  assert.equal(resolve('UK').code, 'GB');
  assert.equal(resolve('Cote d Ivoire').code, 'CI');
  assert.equal(resolve('turkiye').code, 'TR');
  for (const bad of ['', 'Atlantis', 'XX', 'ZZ', 'EU', 'UN', 'Fr4nce', 'x'.repeat(100), null, undefined]) assert.equal(resolve(bad), null, String(bad));
});

test('adding a country: only real ones, stored once, then usable everywhere', async () => {
  const ctx = await start();
  const list0 = await (await fetch(ctx.base + '/api/countries')).json();
  assert.deepEqual(list0.map(c => c.code), ['BE', 'NL', 'DE']);

  // not usable before it is added
  const doc = { email: 'a@b.fr', fileName: 'a.md', content: '# Congés\nLes congés payés.', countries: ['FR'] };
  assert.equal((await post(ctx.base, '/api/upload', doc)).status, 400);
  assert.equal((await post(ctx.base, '/api/answer', { questionId: 'leaver-bonus', country: 'FR' })).status, 400);

  const add = await post(ctx.base, '/api/countries', { country: 'france' });
  assert.equal(add.status, 201);
  assert.deepEqual(await add.json(), { code: 'FR', name: 'France', added: true });
  const again = await post(ctx.base, '/api/countries', { country: 'FR' });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).added, false);

  const list = await (await fetch(ctx.base + '/api/countries')).json();
  assert.equal(list.filter(c => c.code === 'FR').length, 1);
  const q = await (await fetch(ctx.base + '/api/questions')).json();
  assert.ok(q.countries.includes('FR') && q.countryList.some(c => c.name === 'France'));

  assert.equal((await post(ctx.base, '/api/upload', doc)).status, 201);               // documents can apply to it
  const ans = await (await post(ctx.base, '/api/answer', { questionId: 'leaver-bonus', country: 'FR' })).json();
  assert.equal(ans.gap, true);                                                       // and it shows up as a knowledge gap
  stop(ctx);
});

test('invented or malformed countries are rejected and not stored', async () => {
  const ctx = await start();
  for (const country of ['Atlantis', 'XX', '', '<script>', 'x'.repeat(200)]) {
    const r = await post(ctx.base, '/api/countries', { country });
    assert.equal(r.status, 400, country);
    assert.match((await r.json()).error, /not a recognised country/);
  }
  assert.equal((await post(ctx.base, '/api/countries', {})).status, 400);
  assert.equal((await (await fetch(ctx.base + '/api/countries')).json()).length, 3);
  const iso = await (await fetch(ctx.base + '/api/countries/iso')).json();
  assert.equal(iso.length, 249);
  stop(ctx);
});

test('a new email becomes a people record, once', async () => {
  const ctx = await start();
  const up = (email, name, text) => post(ctx.base, '/api/upload', { email, fileName: name, content: text, countries: ['BE'] });
  assert.equal((await up('Anna.Peeters@acme.be', 'a.md', '# A\nFirst text.')).status, 201);
  assert.equal((await up('anna.peeters@acme.be', 'b.md', '# B\nSecond text.')).status, 201);
  const people = await (await fetch(ctx.base + '/api/people')).json();
  const anna = people.filter(p => p.email === 'anna.peeters@acme.be');
  assert.equal(anna.length, 1);
  assert.equal(anna[0].name, 'Anna Peeters');
  assert.equal(anna[0].owned, 2);
  stop(ctx);
});
