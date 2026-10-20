'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, MIGRATIONS } = require('../src/db');
const { createRepo } = require('../src/repo');
const { seedIfEmpty } = require('../src/seed');
const { answer } = require('../src/trust');

function seeded() {
  const db = openDb(':memory:');
  const repo = createRepo(db);
  seedIfEmpty(repo);
  return { db, repo };
}

test('migrations run once and set the schema version', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['documents', 'people', 'questions', 'document_countries', 'document_versions', 'answer_log', 'settings', 'countries', 'document_types', 'keywords', 'document_keywords']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.close();
});

test('seeding loads the corpus and is idempotent', () => {
  const { db, repo } = seeded();
  assert.equal(repo.countDocuments(), 11);
  assert.equal(repo.countQuestions(), 3);
  assert.equal(repo.getSetting('now'), '2026-09');
  assert.equal(seedIfEmpty(repo), false);
  assert.equal(repo.countDocuments(), 11);
  assert.equal(repo.listPeople().length, 6);
  db.close();
});

test('data persists across closing and reopening a database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustlens-'));
  const file = path.join(dir, 'test.db');
  let db = openDb(file);
  let repo = createRepo(db);
  seedIfEmpty(repo);
  repo.createDocument({ title: 'Persisted doc', type: 'Wiki', date: '2026-09', countries: ['BE'], body: 'hello' });
  db.close();

  db = openDb(file);
  repo = createRepo(db);
  assert.equal(seedIfEmpty(repo), false);
  assert.equal(repo.countDocuments(), 12);
  assert.equal(repo.getDocument('persisted-doc.md').body, 'hello');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repository output feeds the scoring engine unchanged', () => {
  const { db, repo } = seeded();
  const r = answer(repo.getQuestionWithSources('leaver-bonus'), 'BE', '2026-09');
  assert.equal(r.sources[0].title, 'Payroll Manual v7');
  assert.equal(r.sources[0].score.total, 90);
  assert.equal(r.verdict, 'check');
  assert.match(r.sources[0].owner, /Nadia Peeters \(Payroll BE\)/);
  db.close();
});

test('database constraints reject invalid rows', () => {
  const { db } = seeded();
  const ins = (date, topic, claim, answerText) => db.prepare(
    'INSERT INTO documents(file,title,type,doc_date,topic,claim,answer,body) VALUES(?,?,?,?,?,?,?,?)'
  ).run(`f${Math.random()}.md`, 't', 'Wiki', date, topic, claim, answerText, 'b');
  assert.throws(() => ins('not-a-date', null, null, null), /CHECK/);
  assert.throws(() => ins('2026-09', 'leaver-bonus', null, null), /CHECK/);      // topic needs claim+answer
  assert.throws(() => ins('2026-09', 'no-such-topic', 'A', 'x'), /FOREIGN KEY/);  // unknown topic
  assert.throws(() => db.prepare("DELETE FROM questions WHERE id = 'leaver-bonus'").run(), /FOREIGN KEY/);
  db.close();
});

test('answer log persists and aggregates gaps and conflicts', () => {
  const { db, repo } = seeded();
  repo.logAnswer({ questionId: 'leaver-bonus', country: 'DE', verdict: 'hold', gap: true, conflict: false });
  repo.logAnswer({ questionId: 'leaver-bonus', country: 'DE', verdict: 'hold', gap: true, conflict: false });
  repo.logAnswer({ questionId: 'leaver-bonus', country: 'BE', verdict: 'check', gap: false, conflict: true });
  const g = repo.gapReport();
  assert.equal(g.total, 3);
  assert.deepEqual(g.ranked[0], { questionId: 'leaver-bonus', country: 'DE', asked: 2, gaps: 2, conflicts: 0 });
  assert.equal(g.ranked[1].conflicts, 1);
  assert.equal(g.recent.length, 3);
  db.close();
});

test('a failed write rolls back completely', () => {
  const { db, repo } = seeded();
  assert.throws(() => repo.createDocument({ title: 'Bad', type: 'Wiki', date: '2026-09', countries: ['BE'], body: 'x', topic: 'nope', claim: 'A', answer: 'y' }), /Unknown topic/);
  assert.equal(repo.countDocuments(), 11);
  db.close();
});

test('ownerless sources are the chats, wikis and the forwarded email', () => {
  const { db, repo } = seeded();
  const types = repo.listDocuments().filter(d => !d.owner).map(d => d.type).sort();
  assert.deepEqual(types, ['Chat', 'Chat', 'Email', 'Wiki', 'Wiki']);
  assert.ok(!repo.getQuestionWithSources('leaver-bonus').sources.some(s => s.file === 'holiday-policy.md'));
  db.close();
});

test('an empty database stays empty when seeding is declined, and seeds when allowed', () => {
  const db = openDb(':memory:');
  const repo = createRepo(db);
  assert.equal(repo.countDocuments(), 0);
  assert.equal(seedIfEmpty(repo), true);
  assert.equal(repo.countDocuments(), 11);
  db.close();
});
