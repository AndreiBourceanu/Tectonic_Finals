'use strict';
// SQLite via Node's built-in node:sqlite (Node >= 22.13, no dependencies).
// Schema changes are append-only migrations tracked with PRAGMA user_version.
const { DatabaseSync } = require('node:sqlite');
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
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

module.exports = { openDb, migrate, MIGRATIONS, DEFAULT_DB };
