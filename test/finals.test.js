'use strict';
// "Keep it trusted": expertise from work signals, verified freshness, departed owners,
// the steward's attention budget, one-click checks, HR events, expert replies, free-text routing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankExperts, decay } = require('../src/expertise');
const { scoreSource } = require('../src/trust');
const ai = require('../src/ai');
const { createServer } = require('../src/server');
const { openDb } = require('../src/db');

process.env.TRUST_AI = 'off'; // tests never call the network

async function start() {
  const server = createServer({ now: '2026-09', db: openDb(':memory:') });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => {
    const r = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    return { status: r.status, body: await r.json() };
  };
  const stop = () => { server.closeAllConnections?.(); server.close(); server.db.close(); };
  return { call, stop };
}

test('expertise fades with time and ignores people who left', () => {
  assert.equal(decay(0), 1);
  assert.equal(decay(6), 0.5);
  const signals = [
    { person: 'Old Hand', kind: 'chat_answer', month: '2024-01' },
    { person: 'Old Hand', kind: 'chat_answer', month: '2024-02' },
    { person: 'New Star', kind: 'chat_answer', month: '2026-09' },
    { person: 'Gone', kind: 'ticket', month: '2026-09' }
  ];
  const people = [{ name: 'Gone', role: 'X', active: false }, { name: 'New Star', role: 'Payroll', active: true }];
  const r = rankExperts(signals, people, '2026-09');
  assert.deepEqual(r.map(e => e.name), ['New Star']); // Old Hand faded below the threshold, Gone left
  assert.equal(r[0].role, 'Payroll');
  assert.match(r[0].why.join(' '), /answered 1 similar question in chat/);
  assert.deepEqual(rankExperts(signals, people, '2026-09', { exclude: ['New Star'] }), []);
});

test('a one-click confirmation resets freshness; an owner who left scores 0', () => {
  const base = { date: '2023-01', owner: 'A (B)', countries: ['BE'], claim: 'A' };
  assert.equal(scoreSource(base, 'BE', [base], '2026-09').fresh, 0);
  const verified = { ...base, verifiedOn: '2026-09', verifiedBy: 'A' };
  const s = scoreSource(verified, 'BE', [verified], '2026-09');
  assert.equal(s.fresh, 30);
  assert.equal(s.verified, true);
  assert.equal(scoreSource({ ...base, ownerActive: false }, 'BE', [base], '2026-09').owner, 0);
});

test('keyword fallback routes free text, detects countries and matches claims by meaning', async () => {
  const topics = [{ id: 'leaver-bonus', text: 'How is a leaver’s year-end bonus calculated?' }, { id: 'retro-correction', text: 'Who can approve a retroactive payslip correction?' }];
  const r = await ai.routeQuestion('who knows the leaver bonus rules in Germany', topics);
  assert.equal(r.questionId, 'leaver-bonus');
  assert.equal(r.country, 'DE');
  assert.equal(r.via, 'keyword fallback');
  assert.equal((await ai.routeQuestion('where is the coffee machine', topics)).questionId, null);
  const src = [{ claim: 'A', says: 'Pro rata by months worked', title: 'Manual' }, { claim: 'C', says: 'Pro rata by days worked', title: 'Wiki' }];
  assert.deepEqual((await ai.matchClaim('In the Netherlands it is pro rata by days worked', src)).label, 'C');
  const fresh = await ai.matchClaim('Full bonus, always', src);
  assert.equal(fresh.label, 'B');
  assert.equal(fresh.matched, null);
});

test('steward: no one is disturbed until a conflicting answer is actually needed, then one owner gets one click', async () => {
  const { call, stop } = await start();
  try {
    assert.equal((await call('/api/verifications')).body.length, 0);
    const a = (await call('/api/answer', { questionId: 'leaver-bonus', country: 'BE' })).body;
    assert.equal(a.verdict, 'check');
    assert.equal(a.experts[0].name, 'Pieter Claes'); // learned from chat answers and tickets, not declared
    const checks = (await call('/api/verifications')).body;
    assert.equal(checks.length, 1);
    assert.equal(checks[0].person, 'Nadia Peeters');
    assert.equal(checks[0].kind, 'conflict');
    // asking again does not send a second check
    await call('/api/answer', { questionId: 'leaver-bonus', country: 'BE' });
    assert.equal((await call('/api/verifications')).body.length, 1);
    assert.equal((await call('/api/verifications/' + checks[0].id, { response: 'nope' })).status, 400);
    assert.equal((await call('/api/verifications/' + checks[0].id, { response: 'keep' })).status, 200);
    assert.equal((await call('/api/verifications/' + checks[0].id, { response: 'keep' })).status, 409);
    const b = (await call('/api/answer', { questionId: 'leaver-bonus', country: 'BE' })).body;
    assert.equal(b.verdict, 'rely');
    assert.ok(!b.sources.some(s => s.file === 'teams-payroll-help.md')); // the ownerless chat was retired
    const manual = b.sources.find(s => s.file === 'payroll-manual-v7.md');
    assert.equal(manual.verifiedBy, 'Nadia Peeters');
  } finally { stop(); }
});

test('HR event: the departed owner’s source gets a handover to whoever the work signals point to', async () => {
  const { call, stop } = await start();
  try {
    const rc = (await call('/api/events/role-change', { person: 'Nadia Peeters', newRole: 'Finance Ops' })).body;
    assert.deepEqual(rc.orphaned.map(d => d.file), ['payroll-manual-v7.md']);
    const h = (await call('/api/verifications')).body.find(v => v.kind === 'handover');
    assert.equal(h.person, 'Pieter Claes');
    const a = (await call('/api/answer', { questionId: 'leaver-bonus', country: 'BE' })).body;
    assert.equal(a.sources.find(s => s.file === 'payroll-manual-v7.md').score.owner, 0);
    await call('/api/verifications/' + h.id, { response: 'accept' });
    const doc = (await call('/api/documents/payroll-manual-v7.md')).body;
    assert.equal(doc.owner, 'Pieter Claes (Payroll BE)');
    assert.equal((await call('/api/events/role-change', { person: 'Nobody Known' })).status, 404);
  } finally { stop(); }
});

test('expert reply in chat becomes a draft, published in one click, closing the gap', async () => {
  const { call, stop } = await start();
  try {
    assert.equal((await call('/api/answer', { questionId: 'leaver-bonus', country: 'DE' })).body.verdict, 'hold');
    const r = await call('/api/expert-replies', { questionId: 'leaver-bonus', country: 'DE', person: 'Jan Weber', text: 'Pro rata by months worked, as in Belgium.' });
    assert.equal(r.status, 201);
    assert.equal(r.body.document.status, 'draft');
    assert.equal(r.body.claim.label, 'A'); // same meaning as the Belgian manual
    assert.equal((await call('/api/answer', { questionId: 'leaver-bonus', country: 'DE' })).body.verdict, 'hold'); // drafts are not used
    const d = (await call('/api/verifications')).body.find(v => v.kind === 'draft');
    assert.equal(d.person, 'Jan Weber');
    await call('/api/verifications/' + d.id, { response: 'publish' });
    assert.equal((await call('/api/answer', { questionId: 'leaver-bonus', country: 'DE' })).body.verdict, 'rely');
    assert.equal((await call('/api/expert-replies', { questionId: 'nope', country: 'DE', person: 'x', text: 'y' })).status, 400);
  } finally { stop(); }
});

test('free-text ask and connector ingest work without anyone labelling anything', async () => {
  const { call, stop } = await start();
  try {
    const a = (await call('/api/ask', { text: 'Who approves a retroactive correction of a payslip?', country: 'NL' })).body;
    assert.equal(a.matched, true);
    assert.equal(a.questionId, 'retro-correction');
    assert.equal(a.verdict, 'rely');
    assert.equal((await call('/api/ask', { text: 'Where is the coffee machine?', country: 'BE' })).body.matched, false);
    assert.equal((await call('/api/ask', { text: '' })).status, 400);
    const ing = (await call('/api/ingest', { title: 'Teams: #payroll-help (NL)', source: 'Teams', body: 'Q: leaver bonus NL?\nA: In the Netherlands the leaver bonus is pro rata by days worked.' })).body;
    assert.equal(ing.document.topic, 'leaver-bonus');
    assert.equal(ing.document.claim, 'C'); // agrees with the NL wiki
    assert.deepEqual(ing.document.countries, ['NL']);
    const act = (await call('/api/activity')).body;
    assert.equal(act.counts.ingest, 1);
    assert.ok(act.items.some(i => i.kind === 'watch'));
  } finally { stop(); }
});
