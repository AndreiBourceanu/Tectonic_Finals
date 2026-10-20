'use strict';
// Data access layer. All SQL lives here and uses parameterised statements only.
const { COUNTRIES } = require('./trust');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FILE_RE = /^[a-z0-9][a-z0-9-]{0,80}\.md$/;
const CLAIM_RE = /^[A-Za-z0-9_-]{1,20}$/;
const bad = msg => { throw new HttpError(400, msg); };

const DOC_SELECT = `
  SELECT d.*, p.name AS owner_name, p.role AS owner_role,
    (SELECT group_concat(country, ',') FROM
       (SELECT country FROM document_countries c WHERE c.document_id = d.id ORDER BY country)) AS countries
  FROM documents d LEFT JOIN people p ON p.id = d.owner_id`;

const ownerLabel = (name, role) => (name ? (role ? `${name} (${role})` : name) : null);

function toDoc(r, withBody = false) {
  const doc = {
    file: r.file, title: r.title, type: r.type, date: r.doc_date,
    owner: ownerLabel(r.owner_name, r.owner_role),
    countries: r.countries ? r.countries.split(',') : [],
    topic: r.topic, claim: r.claim, says: r.answer,
    version: r.version, createdAt: r.created_at, updatedAt: r.updated_at
  };
  if (withBody) doc.body = r.body;
  return doc;
}

const slugify = t => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

function createRepo(db) {
  let depth = 0;
  // Re-entrant transaction helper.
  const transaction = fn => {
    if (depth > 0) return fn();
    db.exec('BEGIN'); depth++;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { depth--; }
  };

  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  // ---- settings / questions / people -------------------------------------------------
  const getSetting = key => one('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  const setSetting = (key, value) => run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

  const upsertQuestion = ({ id, text, expert }) =>
    run('INSERT INTO questions(id, text, expert) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, expert = excluded.expert', id, text, expert);
  const listQuestions = () => all('SELECT id, text FROM questions ORDER BY rowid').map(r => ({ id: r.id, text: r.text }));
  const countQuestions = () => one('SELECT COUNT(*) AS n FROM questions').n;

  function personId(label) {
    const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label.trim());
    const name = (m ? m[1] : label).trim(), role = m ? m[2].trim() : '';
    run('INSERT OR IGNORE INTO people(name, role) VALUES(?, ?)', name, role);
    return one('SELECT id FROM people WHERE name = ? AND role = ?', name, role).id;
  }
  const listPeople = () => all(
    `SELECT p.id, p.name, p.role, COUNT(d.id) AS owned FROM people p
     LEFT JOIN documents d ON d.owner_id = p.id GROUP BY p.id ORDER BY p.name`
  ).map(r => ({ id: r.id, name: r.name, role: r.role, owned: r.owned }));

  // ---- documents ---------------------------------------------------------------------
  const countDocuments = () => one('SELECT COUNT(*) AS n FROM documents').n;
  const listDocuments = () => all(`${DOC_SELECT} ORDER BY d.file`).map(r => toDoc(r));
  const getDocument = file => { const r = one(`${DOC_SELECT} WHERE d.file = ?`, file); return r ? toDoc(r, true) : null; };

  function getQuestionWithSources(id) {
    const q = one('SELECT id, text, expert FROM questions WHERE id = ?', id);
    if (!q) return null;
    const sources = all(`${DOC_SELECT} WHERE d.topic = ? ORDER BY d.file`, id).map(r => toDoc(r));
    return { id: q.id, text: q.text, expert: q.expert, sources };
  }

  function validate(m) {
    if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 200) bad('title is required (max 200 characters)');
    if (typeof m.type !== 'string' || !m.type.trim() || m.type.length > 40) bad('type is required (max 40 characters)');
    if (typeof m.date !== 'string' || !DATE_RE.test(m.date)) bad('date must be YYYY-MM');
    if (typeof m.body !== 'string' || !m.body.trim() || m.body.length > 200_000) bad('body is required (max 200000 characters)');
    let countries = m.countries;
    if (typeof countries === 'string') countries = countries.split(',');
    if (!Array.isArray(countries) || !countries.length) bad('countries must be a non-empty list');
    countries = [...new Set(countries.map(c => String(c).trim().toUpperCase()))];
    for (const c of countries) if (!COUNTRIES.includes(c)) bad(`Unknown country "${c}"`);
    const owner = m.owner == null || m.owner === '' ? null : m.owner;
    if (owner !== null && (typeof owner !== 'string' || owner.length > 120)) bad('owner must be a string (max 120 characters) or empty');
    const topic = m.topic == null || m.topic === '' ? null : m.topic;
    let claim = null, says = null;
    if (topic !== null) {
      if (typeof topic !== 'string' || !one('SELECT 1 AS x FROM questions WHERE id = ?', topic)) bad(`Unknown topic "${topic}"`);
      if (typeof m.claim !== 'string' || !CLAIM_RE.test(m.claim)) bad('claim is required with a topic (letters, digits, - or _, max 20)');
      if (typeof m.says !== 'string' || !m.says.trim() || m.says.length > 300) bad('answer is required with a topic (max 300 characters)');
      claim = m.claim; says = m.says.trim();
    }
    return { title: m.title.trim(), type: m.type.trim(), date: m.date, body: m.body, countries, owner, topic, claim, says };
  }

  const pick = (input, base) => {
    const out = { ...base };
    for (const k of ['title', 'type', 'date', 'owner', 'countries', 'topic', 'claim', 'body']) if (input[k] !== undefined) out[k] = input[k];
    if (input.answer !== undefined) out.says = input.answer;
    else if (input.says !== undefined) out.says = input.says;
    return out;
  };

  function snapshot(id, version, m, ownerId, editedBy) {
    run(`INSERT INTO document_versions(document_id, version, title, type, doc_date, owner_id, topic, claim, answer, countries, body, edited_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, version, m.title, m.type, m.date, ownerId, m.topic, m.claim, m.says, m.countries.join(','), m.body, editedBy);
  }

  function setCountries(id, countries) {
    run('DELETE FROM document_countries WHERE document_id = ?', id);
    for (const c of countries) run('INSERT INTO document_countries(document_id, country) VALUES(?, ?)', id, c);
  }

  function createDocument(input, editedBy = 'api') {
    return transaction(() => {
      const m = validate(pick(input, {}));
      let file = input.file;
      if (file !== undefined) {
        if (typeof file !== 'string' || !FILE_RE.test(file)) bad('file must look like "my-document.md" (lowercase letters, digits, dashes)');
        if (one('SELECT 1 AS x FROM documents WHERE file = ?', file)) throw new HttpError(409, `Document "${file}" already exists`);
      } else {
        const base = slugify(m.title);
        file = `${base}.md`;
        for (let n = 2; one('SELECT 1 AS x FROM documents WHERE file = ?', file); n++) file = `${base}-${n}.md`;
      }
      const ownerId = m.owner ? personId(m.owner) : null;
      const { lastInsertRowid } = run(
        `INSERT INTO documents(file, title, type, doc_date, owner_id, topic, claim, answer, body) VALUES(?,?,?,?,?,?,?,?,?)`,
        file, m.title, m.type, m.date, ownerId, m.topic, m.claim, m.says, m.body);
      const id = Number(lastInsertRowid);
      setCountries(id, m.countries);
      snapshot(id, 1, m, ownerId, editedBy);
      return getDocument(file);
    });
  }

  // PUT semantics: the provided fields are merged onto the current document.
  function updateDocument(file, input, editedBy = 'api') {
    return transaction(() => {
      const row = one('SELECT id, version FROM documents WHERE file = ?', file);
      if (!row) throw new HttpError(404, 'Document not found');
      const cur = getDocument(file);
      const m = validate(pick(input, { title: cur.title, type: cur.type, date: cur.date, owner: cur.owner, countries: cur.countries, topic: cur.topic, claim: cur.claim, says: cur.says, body: cur.body }));
      const ownerId = m.owner ? personId(m.owner) : null;
      const version = row.version + 1;
      run(`UPDATE documents SET title=?, type=?, doc_date=?, owner_id=?, topic=?, claim=?, answer=?, body=?, version=?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        m.title, m.type, m.date, ownerId, m.topic, m.claim, m.says, m.body, version, row.id);
      setCountries(row.id, m.countries);
      snapshot(row.id, version, m, ownerId, editedBy);
      return getDocument(file);
    });
  }

  function documentVersions(file) {
    const row = one('SELECT id FROM documents WHERE file = ?', file);
    if (!row) return null;
    return all(
      `SELECT v.version, v.title, v.type, v.doc_date, v.topic, v.claim, v.answer, v.countries, v.body, v.edited_by, v.edited_at,
              p.name AS owner_name, p.role AS owner_role
       FROM document_versions v LEFT JOIN people p ON p.id = v.owner_id
       WHERE v.document_id = ? ORDER BY v.version DESC`, row.id
    ).map(v => ({
      version: v.version, title: v.title, type: v.type, date: v.doc_date, owner: ownerLabel(v.owner_name, v.owner_role),
      countries: v.countries.split(','), topic: v.topic, claim: v.claim, says: v.answer, body: v.body,
      editedBy: v.edited_by, editedAt: v.edited_at
    }));
  }

  // ---- answer log (knowledge gaps) ---------------------------------------------------
  const logAnswer = ({ questionId, country, verdict, gap, conflict }) =>
    run('INSERT INTO answer_log(question_id, country, verdict, gap, conflict) VALUES(?,?,?,?,?)', questionId, country, verdict, gap ? 1 : 0, conflict ? 1 : 0);

  function gapReport() {
    const ranked = all(
      `SELECT question_id, country, COUNT(*) AS asked, SUM(gap) AS gaps, SUM(conflict) AS conflicts
       FROM answer_log GROUP BY question_id, country ORDER BY asked DESC, question_id, country`
    ).map(r => ({ questionId: r.question_id, country: r.country, asked: r.asked, gaps: r.gaps, conflicts: r.conflicts }));
    const recent = all('SELECT at, question_id, country, verdict, gap, conflict FROM answer_log ORDER BY id DESC LIMIT 20')
      .map(r => ({ at: r.at, questionId: r.question_id, country: r.country, verdict: r.verdict, gap: !!r.gap, conflict: !!r.conflict }));
    return { total: one('SELECT COUNT(*) AS n FROM answer_log').n, ranked, recent };
  }

  return {
    transaction, getSetting, setSetting, upsertQuestion, listQuestions, countQuestions, listPeople,
    countDocuments, listDocuments, getDocument, getQuestionWithSources, createDocument, updateDocument,
    documentVersions, logAnswer, gapReport
  };
}

module.exports = { createRepo, HttpError };
