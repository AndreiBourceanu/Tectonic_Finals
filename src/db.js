'use strict';
// SQLite via Node's built-in node:sqlite (Node >= 22.13, no dependencies).
// Schema changes are append-only migrations tracked with PRAGMA user_version.
// Two interchangeable SQLite drivers with the same API surface (prepare/get/all/run/exec/close):
//   1. node:sqlite (built into Node >= 22.13, no install), preferred when available
//   2. better-sqlite3 (optional npm package), used on older Node such as 18/20
// Force one with TRUST_SQLITE_DRIVER=node:sqlite|better-sqlite3.
function loadDriver() {
  const forced = process.env.TRUST_SQLITE_DRIVER;
  if (!forced || forced === 'node:sqlite') {
    const original = process.emitWarning; // hide Node's "SQLite is experimental" notice
    process.emitWarning = (w, ...rest) => (/sqlite/i.test(String((w && w.message) || w)) ? undefined : original.call(process, w, ...rest));
    try { return { name: 'node:sqlite', Database: require('node:sqlite').DatabaseSync }; }
    catch { if (forced) throw new Error('node:sqlite is not available in this Node version'); }
    finally { process.emitWarning = original; }
  }
  try { return { name: 'better-sqlite3', Database: require('better-sqlite3') }; }
  catch {
    throw new Error(`No SQLite driver available on Node ${process.version}. Either install Node 22.13 or newer (https://nodejs.org, or: nvm install 22), or run: npm install`);
  }
}
const driver = loadDriver();
const Database = driver.Database;
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DB = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'trustlens.db');

const MIGRATIONS = [
  // v1: core schema
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE people (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    UNIQUE (name, role)
  );

  CREATE TABLE questions (
    id     TEXT PRIMARY KEY,
    text   TEXT NOT NULL,
    expert TEXT NOT NULL
  );

  CREATE TABLE documents (
    id         INTEGER PRIMARY KEY,
    file       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    type       TEXT NOT NULL,
    doc_date   TEXT NOT NULL CHECK (doc_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
    owner_id   INTEGER REFERENCES people(id),
    topic      TEXT REFERENCES questions(id),
    claim      TEXT,
    answer     TEXT,
    body       TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (topic IS NULL OR (claim IS NOT NULL AND answer IS NOT NULL))
  );
  CREATE INDEX idx_documents_topic ON documents(topic);

  CREATE TABLE document_countries (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    country     TEXT NOT NULL CHECK (length(country) = 2),
    PRIMARY KEY (document_id, country)
  );

  CREATE TABLE document_versions (
    id          INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    type        TEXT NOT NULL,
    doc_date    TEXT NOT NULL,
    owner_id    INTEGER REFERENCES people(id),
    topic       TEXT,
    claim       TEXT,
    answer      TEXT,
    countries   TEXT NOT NULL,
    body        TEXT NOT NULL,
    edited_by   TEXT NOT NULL,
    edited_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (document_id, version)
  );

  CREATE TABLE answer_log (
    id          INTEGER PRIMARY KEY,
    at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    question_id TEXT NOT NULL REFERENCES questions(id),
    country     TEXT NOT NULL,
    verdict     TEXT NOT NULL CHECK (verdict IN ('rely','check','hold')),
    gap         INTEGER NOT NULL CHECK (gap IN (0,1)),
    conflict    INTEGER NOT NULL CHECK (conflict IN (0,1))
  );
  CREATE INDEX idx_answer_log_qc ON answer_log(question_id, country);
  `,
  // v2: upload metadata, email-based ownership, searchable keywords
  `
  ALTER TABLE people ADD COLUMN email TEXT;
  CREATE UNIQUE INDEX idx_people_email ON people(email) WHERE email IS NOT NULL;

  ALTER TABLE documents ADD COLUMN summary       TEXT NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN editor_id     INTEGER REFERENCES people(id);
  ALTER TABLE documents ADD COLUMN original_name TEXT;
  ALTER TABLE documents ADD COLUMN size_bytes    INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN content_hash  TEXT;
  ALTER TABLE documents ADD COLUMN source        TEXT NOT NULL DEFAULT 'api';
  ALTER TABLE documents ADD COLUMN meta_source   TEXT NOT NULL DEFAULT 'manual';
  CREATE INDEX idx_documents_hash ON documents(content_hash);

  CREATE TABLE document_keywords (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    keyword     TEXT NOT NULL,
    weight      INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (document_id, keyword)
  );
  CREATE INDEX idx_keywords_keyword ON document_keywords(keyword);
  `,
  // v3: keywords become a global table (a new keyword is added the first time it is used)
  `
  CREATE TABLE keywords (
    keyword    TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT OR IGNORE INTO keywords(keyword) SELECT DISTINCT keyword FROM document_keywords;

  DROP INDEX idx_keywords_keyword;
  ALTER TABLE document_keywords RENAME TO document_keywords_old;
  CREATE TABLE document_keywords (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    keyword     TEXT NOT NULL REFERENCES keywords(keyword),
    weight      INTEGER NOT NULL DEFAULT 1,
    manual      INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0,1)),
    PRIMARY KEY (document_id, keyword)
  );
  INSERT INTO document_keywords(document_id, keyword, weight) SELECT document_id, keyword, weight FROM document_keywords_old;
  DROP TABLE document_keywords_old;
  CREATE INDEX idx_keywords_keyword ON document_keywords(keyword);
  `,
  // v4: document types become a table (a new type is added the first time it is used)
  `
  CREATE TABLE document_types (name TEXT PRIMARY KEY COLLATE NOCASE);
  INSERT OR IGNORE INTO document_types(name) VALUES ('Policy'),('Wiki'),('Chat'),('Email'),('Contract'),('Document');
  INSERT OR IGNORE INTO document_types(name) SELECT DISTINCT type FROM documents;
  `,
  // v5: countries become a table (validated against ISO 3166-1 before a new one is added)
  `
  CREATE TABLE countries (
    code TEXT PRIMARY KEY CHECK (length(code) = 2),
    name TEXT NOT NULL
  );
  INSERT INTO countries(code, name) VALUES ('BE','Belgium'),('NL','Netherlands'),('DE','Germany');
  `,
  // v6: keep it trusted without extra work
  //  - documents can be verified in one click (verified_on resets freshness) and have a lifecycle
  //  - people can leave a role (active = 0), which makes their documents ownerless
  //  - signals: traces of everyday work (chat answers, tickets, commits) that reveal who knows what
  //  - verifications: the few targeted one-click checks the steward decides are worth a human's time
  //  - activity: a transparent log of everything that happened in the background
  `
  ALTER TABLE documents ADD COLUMN verified_on TEXT;
  ALTER TABLE documents ADD COLUMN verified_by TEXT;
  ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
  ALTER TABLE people ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE signals (
    id     INTEGER PRIMARY KEY,
    person TEXT NOT NULL,
    topic  TEXT NOT NULL REFERENCES questions(id),
    kind   TEXT NOT NULL CHECK (kind IN ('chat_answer','ticket','commit','meeting','expert_reply')),
    month  TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_signals_topic ON signals(topic);

  CREATE TABLE verifications (
    id          INTEGER PRIMARY KEY,
    file        TEXT NOT NULL,
    person      TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('conflict','confirm','handover','draft')),
    reason      TEXT NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 0,
    payload     TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
    response    TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    answered_at TEXT
  );
  CREATE INDEX idx_verifications_open ON verifications(status, person);

  CREATE TABLE activity (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    kind    TEXT NOT NULL,
    message TEXT NOT NULL
  );
  `
];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function openDb(file = DEFAULT_DB) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

module.exports = { openDb, migrate, Database, MIGRATIONS, DEFAULT_DB, driverName: driver.name };
