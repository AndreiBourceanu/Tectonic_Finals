'use strict';
// Demo data for an empty database (data/seed.json). Everything goes through the repository,
// so seed rows are validated exactly like rows created through the API.
//   node src/seed.js           seed the default DB if it is empty
//   node src/seed.js --reset   delete the default DB file first, then seed
const fs = require('node:fs');
const path = require('node:path');
const { openDb, DEFAULT_DB } = require('./db');
const { createRepo } = require('./repo');

const SEED_FILE = path.join(__dirname, '..', 'data', 'seed.json');

function seedIfEmpty(repo, seedFile = SEED_FILE) {
  if (repo.countQuestions() > 0 || repo.countDocuments() > 0) return false;
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  repo.transaction(() => {
    repo.setSetting('now', seed.now);
    for (const q of seed.questions) repo.upsertQuestion(q);
    for (const d of seed.documents) repo.createDocument(d, 'seed');
  });
  return true;
}

if (require.main === module) {
  if (process.argv.includes('--reset')) for (const s of ['', '-wal', '-shm']) fs.rmSync(DEFAULT_DB + s, { force: true });
  const db = openDb();
  const repo = createRepo(db);
  const seeded = seedIfEmpty(repo);
  console.log(`${seeded ? 'Seeded' : 'Database already has data:'} ${repo.countDocuments()} documents, ${repo.countQuestions()} questions (${DEFAULT_DB})`);
  db.close();
}

module.exports = { seedIfEmpty, SEED_FILE };
