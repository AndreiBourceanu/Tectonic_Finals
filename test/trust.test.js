'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { answer, scoreSource, parseMonth } = require('../src/trust');
const { openDb } = require('../src/db');
const { createRepo } = require('../src/repo');
const { seedIfEmpty } = require('../src/seed');
const db = openDb(':memory:');
const repo = createRepo(db);
seedIfEmpty(repo);
test.after(() => db.close());
const NOW = '2026-09';
const q = id => repo.getQuestionWithSources(id);

test('parseMonth rejects bad input', () => {
  assert.throws(() => parseMonth('2026/09'));
  assert.equal(parseMonth('2026-09') - parseMonth('2026-03'), 6);
});

test('freshness buckets', () => {
  const s = { date: '2026-03', owner: null, countries: ['BE'], claim: 'A' };
  assert.equal(scoreSource(s, 'BE', [s], NOW).fresh, 30);
  assert.equal(scoreSource({ ...s, date: '2025-09' }, 'BE', [s], NOW).fresh, 20);
  assert.equal(scoreSource({ ...s, date: '2024-09' }, 'BE', [s], NOW).fresh, 10);
  assert.equal(scoreSource({ ...s, date: '2022-01' }, 'BE', [s], NOW).fresh, 0);
});

test('agreement is capped at 20 and requires applicability', () => {
  const mk = () => ({ date: '2026-08', owner: 'x', countries: ['BE'], claim: 'A' });
  const all = [mk(), mk(), mk(), mk()];
  assert.equal(scoreSource(all[0], 'BE', all, NOW).agreed, 20);
  assert.equal(scoreSource(all[0], 'NL', all, NOW).agreed, 0);
});

test('BE leaver bonus: conflict downgrades a 90/100 source to "check"', () => {
  const r = answer(q('leaver-bonus'), 'BE', NOW);
  assert.equal(r.sources[0].title, 'Payroll Manual v7');
  assert.equal(r.sources[0].score.total, 90);
  assert.equal(r.verdict, 'check');
  assert.ok(r.conflict);
  assert.equal(r.conflict.other.title, 'Teams: #payroll-help');
  assert.equal(r.answer, 'Pro rata by months worked');
  assert.match(r.expert, /Nadia Peeters/);
});

test('NL retro correction: clean agreement gives "rely" and no expert', () => {
  const r = answer(q('retro-correction'), 'NL', NOW);
  assert.equal(r.verdict, 'rely');
  assert.equal(r.conflict, null);
  assert.equal(r.expert, null);
});

test('DE leaver bonus: no applicable source is a gap', () => {
  const r = answer(q('leaver-bonus'), 'DE', NOW);
  assert.equal(r.verdict, 'hold');
  assert.equal(r.gap, true);
  assert.equal(r.basedOn, null);
  assert.match(r.expert, /No expert is mapped for DE/);
});

test('DE new hire: single unconfirmed source is "check" without conflict', () => {
  const r = answer(q('new-hire-deadline'), 'DE', NOW);
  assert.equal(r.verdict, 'check');
  assert.equal(r.conflict, null);
  assert.equal(r.basedOn.score, 70);
});

test('non-applicable sources are ranked but never used as the answer', () => {
  const r = answer(q('leaver-bonus'), 'BE', NOW);
  const wiki = r.sources.find(s => s.title === 'NL Wiki: Bonus rules');
  assert.equal(wiki.score.applies, 0);
  assert.notEqual(r.basedOn.title, wiki.title);
});

test('unknown country throws', () => {
  assert.throws(() => answer(q('leaver-bonus'), 'FR', NOW), /Unknown country/);
});
