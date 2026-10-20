'use strict';
// Data access layer. All SQL lives here and uses parameterised statements only.
const crypto = require('node:crypto');
const { resolve: resolveCountry } = require('./countries');
const { tokenize, generate, headingOf, titleFromName } = require('./metadata');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FILE_RE = /^[a-z0-9][a-z0-9-]{0,80}\.md$/;
const CLAIM_RE = /^[A-Za-z0-9_-]{1,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPE_RE = /^[\p{L}\p{N}][\p{L}\p{N} &/.-]{0,39}$/u;
const KEYWORD_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,39}$/u;
const bad = msg => { throw new HttpError(400, msg); };

const DOC_SELECT = `
  SELECT d.*, p.name AS owner_name, p.role AS owner_role, p.email AS owner_email,
    e.name AS editor_name, e.role AS editor_role, e.email AS editor_email,
    (SELECT group_concat(country, ',') FROM
       (SELECT country FROM document_countries c WHERE c.document_id = d.id ORDER BY country)) AS countries,
    (SELECT group_concat(keyword, ',') FROM
       (SELECT keyword FROM document_keywords k WHERE k.document_id = d.id ORDER BY weight DESC, keyword)) AS keywords
  FROM documents d
  LEFT JOIN people p ON p.id = d.owner_id
  LEFT JOIN people e ON e.id = d.editor_id`;

const label = (name, role) => (name ? (role ? `${name} (${role})` : name) : null);

function toDoc(r, withBody = false) {
  const doc = {
    file: r.file, title: r.title, type: r.type, date: r.doc_date,
    owner: label(r.owner_name, r.owner_role), ownerEmail: r.owner_email,
    lastEditedBy: label(r.editor_name, r.editor_role), lastEditedByEmail: r.editor_email,
    countries: r.countries ? r.countries.split(',') : [],
    topic: r.topic, claim: r.claim, says: r.answer,
    summary: r.summary, keywords: r.keywords ? r.keywords.split(',') : [],
    originalName: r.original_name, sizeBytes: r.size_bytes, contentHash: r.content_hash,
    source: r.source, metaSource: r.meta_source,
    version: r.version, createdAt: r.created_at, updatedAt: r.updated_at
  };
  if (withBody) doc.body = r.body;
  return doc;
}

const slugify = t => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normKeywords = list => [...new Set((Array.isArray(list) ? list : String(list ?? '').split(',')).map(k => String(k).trim().toLowerCase()))].filter(Boolean);

function checkEmail(e) {
  const v = typeof e === 'string' ? e.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(v) || v.length > 120) bad('A valid email address is required');
  return v;
}

function createRepo(db) {
  let depth = 0;
  const transaction = fn => { // re-entrant
    if (depth > 0) return fn();
    db.exec('BEGIN'); depth++;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { depth--; }
  };
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  // ---- settings / questions / people ---------------------------------------------------
  const getSetting = key => one('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  const setSetting = (key, value) => run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  const upsertQuestion = ({ id, text, expert }) =>
    run('INSERT INTO questions(id, text, expert) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, expert = excluded.expert', id, text, expert);
  const listQuestions = () => all('SELECT id, text FROM questions ORDER BY rowid').map(r => ({ id: r.id, text: r.text }));
  const countQuestions = () => one('SELECT COUNT(*) AS n FROM questions').n;

  function personId(text) { // "Name (Role)" strings, used by seed data and the API
    const m = /^(.*?)\s*\((.*)\)\s*$/.exec(text.trim());
    const name = (m ? m[1] : text).trim(), role = m ? m[2].trim() : '';
    run('INSERT OR IGNORE INTO people(name, role) VALUES(?, ?)', name, role);
    return one('SELECT id FROM people WHERE name = ? AND role = ?', name, role).id;
  }
  function emailPersonId(email) { // ownership is keyed on email
    const hit = one('SELECT id FROM people WHERE email = ?', email);
    if (hit) return hit.id;
    const [local, domain] = email.split('@');
    let name = local.split(/[._+-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || email;
    if (one('SELECT 1 AS x FROM people WHERE name = ? AND role = ?', name, domain)) name = email;
    run('INSERT INTO people(name, role, email) VALUES(?, ?, ?)', name, domain, email);
    return one('SELECT id FROM people WHERE email = ?', email).id;
  }
  const listCountries = () => all('SELECT code, name FROM countries ORDER BY rowid').map(r => ({ code: r.code, name: r.name }));
  const countryCodes = () => listCountries().map(c => c.code);
  // Adds a country only if it is a real one (ISO 3166-1). Accepts the English name or the two-letter code.
  function addCountry(input) {
    const c = resolveCountry(input);
    if (!c) throw new HttpError(400, `“${String(input ?? '').slice(0, 60)}” is not a recognised country. Use its English name or two-letter ISO code, for example France or FR.`);
    const added = !one('SELECT 1 AS x FROM countries WHERE code = ?', c.code);
    if (added) run('INSERT INTO countries(code, name) VALUES(?, ?)', c.code, c.name);
    return { code: c.code, name: c.name, added };
  }
  const listTypes = () => all('SELECT name FROM document_types ORDER BY name COLLATE NOCASE').map(r => r.name);
  const listKeywords = (limit = 40) => all(
    `SELECT k.keyword, COUNT(dk.document_id) AS uses FROM keywords k LEFT JOIN document_keywords dk ON dk.keyword = k.keyword
     GROUP BY k.keyword ORDER BY uses DESC, k.keyword LIMIT ?`, limit).map(r => ({ keyword: r.keyword, uses: r.uses }));
  const listPeople = () => all(
    `SELECT p.id, p.name, p.role, p.email, COUNT(d.id) AS owned FROM people p
     LEFT JOIN documents d ON d.owner_id = p.id GROUP BY p.id ORDER BY p.name`
  ).map(r => ({ id: r.id, name: r.name, role: r.role, email: r.email, owned: r.owned }));

  // ---- documents -----------------------------------------------------------------------
  const countDocuments = () => one('SELECT COUNT(*) AS n FROM documents').n;
  const listDocuments = () => all(`${DOC_SELECT} ORDER BY d.file`).map(r => toDoc(r));
  const getDocument = file => { const r = one(`${DOC_SELECT} WHERE d.file = ?`, file); return r ? toDoc(r, true) : null; };
  const getMeta = file => { const r = one(`${DOC_SELECT} WHERE d.file = ?`, file); return r ? toDoc(r) : null; };

  function getQuestionWithSources(id) {
    const q = one('SELECT id, text, expert FROM questions WHERE id = ?', id);
    if (!q) return null;
    const sources = all(`${DOC_SELECT} WHERE d.topic = ? ORDER BY d.file`, id).map(r => toDoc(r));
    return { id: q.id, text: q.text, expert: q.expert, sources };
  }

  function validate(m) {
    if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 200) bad('title is required (max 200 characters)');
    if (typeof m.type !== 'string' || !TYPE_RE.test(m.type.trim().replace(/\s+/g, ' '))) bad('type must be 1 to 40 characters (letters, digits, spaces, & / . -)');
    if (typeof m.date !== 'string' || !DATE_RE.test(m.date)) bad('date must be YYYY-MM');
    if (typeof m.body !== 'string' || !m.body.trim() || m.body.length > 200_000) bad('The document text is empty or too large (max 200,000 characters, about 200 KB)');
    let countries = m.countries;
    if (typeof countries === 'string') countries = countries.split(',');
    if (!Array.isArray(countries) || !countries.length) bad('Select at least one country the document applies to');
    countries = [...new Set(countries.map(c => String(c).trim().toUpperCase()))];
    for (const c of countries) if (!one('SELECT 1 AS x FROM countries WHERE code = ?', c)) bad(`Unknown country "${c}". Add it to the list first.`);
    const owner = m.owner == null || m.owner === '' ? null : m.owner;
    if (owner !== null && (typeof owner !== 'string' || owner.length > 120)) bad('owner must be a string (max 120 characters) or empty');
    const topic = m.topic == null || m.topic === '' ? null : m.topic;
    let claim = null, says = null;
    if (topic !== null) {
      if (typeof topic !== 'string' || !one('SELECT 1 AS x FROM questions WHERE id = ?', topic)) bad(`Unknown topic "${topic}"`);
      if (typeof m.claim !== 'string' || !CLAIM_RE.test(m.claim)) bad('claim is required with a topic (letters, digits, - or _, max 20)');
      if (typeof m.says !== 'string' || !m.says.trim() || m.says.length > 300) bad('Describe what the document says (required when it is linked to a question, max 300 characters)');
      claim = m.claim; says = m.says.trim();
    }
    let summary, keywords;
    if (m.summary !== undefined) {
      if (typeof m.summary !== 'string' || m.summary.length > 1000) bad('summary must be text (max 1000 characters)');
      summary = m.summary.trim();
    }
    if (m.keywords !== undefined) {
      if (!Array.isArray(m.keywords) && typeof m.keywords !== 'string') bad('keywords must be a list or comma-separated text');
      keywords = normKeywords(m.keywords);
      if (keywords.length > 20) bad('At most 20 keywords');
      if (!keywords.every(k => KEYWORD_RE.test(k))) bad('keywords may contain letters, digits, spaces and dashes (max 40 characters each)');
    }
    return { title: m.title.trim(), type: m.type.trim(), date: m.date, body: m.body, countries, owner, topic, claim, says, summary, keywords };
  }

  const pick = (input, base) => {
    const out = { ...base };
    for (const k of ['title', 'type', 'date', 'owner', 'countries', 'topic', 'claim', 'body', 'summary', 'keywords']) if (input[k] !== undefined) out[k] = input[k];
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
  // A document type is stored once (case-insensitive); an unknown one is added on first use.
  function ensureType(name) {
    const clean = name.trim().replace(/\s+/g, ' ');
    const hit = one('SELECT name FROM document_types WHERE name = ?', clean);
    if (hit) return hit.name;
    run('INSERT INTO document_types(name) VALUES(?)', clean);
    return clean;
  }
  // A keyword is stored once in the global keywords table, the first time anyone uses it.
  const ensureKeyword = k => run('INSERT OR IGNORE INTO keywords(keyword) VALUES(?)', k);

  // generated: [{keyword, weight}] replaced on every call. manual: list of strings, replaced only when given.
  function writeMeta(id, { summary, generated, manual, source }) {
    run('UPDATE documents SET summary = ?, meta_source = ? WHERE id = ?', summary, source, id);
    run('DELETE FROM document_keywords WHERE document_id = ? AND manual = 0', id);
    if (manual) {
      run('DELETE FROM document_keywords WHERE document_id = ? AND manual = 1', id);
      for (const k of manual) { ensureKeyword(k); run('INSERT OR REPLACE INTO document_keywords(document_id, keyword, weight, manual) VALUES(?,?,10,1)', id, k); }
    }
    for (const g of generated) { ensureKeyword(g.keyword); run('INSERT OR IGNORE INTO document_keywords(document_id, keyword, weight, manual) VALUES(?,?,?,0)', id, g.keyword, g.weight); }
  }
  const editorOf = editedBy => (EMAIL_RE.test(editedBy || '') ? emailPersonId(editedBy.toLowerCase()) : null);

  function createDocument(input, editedBy = 'api') {
    return transaction(() => {
      const m = validate(pick(input, {}));
      const source = input.source === undefined ? 'api' : input.source;
      if (!['api', 'upload', 'seed'].includes(source)) bad('Unknown source');
      let file = input.file;
      if (file !== undefined) {
        if (typeof file !== 'string' || !FILE_RE.test(file)) bad('file must look like "my-document.md" (lowercase letters, digits, dashes)');
        if (one('SELECT 1 AS x FROM documents WHERE file = ?', file)) throw new HttpError(409, `Document "${file}" already exists`);
      } else {
        const base = slugify(m.title);
        file = `${base}.md`;
        for (let n = 2; one('SELECT 1 AS x FROM documents WHERE file = ?', file); n++) file = `${base}-${n}.md`;
      }
      const hash = sha256(m.body);
      if (source === 'upload') {
        const dup = one('SELECT title FROM documents WHERE content_hash = ?', hash);
        if (dup) throw new HttpError(409, `This exact file is already stored as "${dup.title}". Use "Update" to replace it.`);
      }
      m.type = ensureType(m.type);
      const ownerId = input.ownerEmail ? emailPersonId(checkEmail(input.ownerEmail)) : (m.owner ? personId(m.owner) : null);
      const original = typeof input.originalName === 'string' ? input.originalName.slice(0, 200) : null;
      const { lastInsertRowid } = run(
        `INSERT INTO documents(file, title, type, doc_date, owner_id, editor_id, topic, claim, answer, body, size_bytes, content_hash, source, original_name)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        file, m.title, m.type, m.date, ownerId, editorOf(editedBy), m.topic, m.claim, m.says, m.body, Buffer.byteLength(m.body), hash, source, original);
      const id = Number(lastInsertRowid);
      setCountries(id, m.countries);
      const gen = generate(m.body, m.title);
      writeMeta(id, { summary: m.summary ?? gen.summary, generated: gen.keywords, manual: m.keywords, source: m.summary !== undefined ? 'manual' : 'heuristic' });
      snapshot(id, 1, m, ownerId, editedBy);
      return getDocument(file);
    });
  }

  // PUT semantics: provided fields are merged onto the current document.
  function updateDocument(file, input, editedBy = 'api') {
    return transaction(() => {
      const row = one('SELECT id, version, owner_id, meta_source FROM documents WHERE file = ?', file);
      if (!row) throw new HttpError(404, 'Document not found');
      const cur = getDocument(file);
      const m = validate(pick(input, { title: cur.title, type: cur.type, date: cur.date, owner: cur.owner, countries: cur.countries, topic: cur.topic, claim: cur.claim, says: cur.says, body: cur.body }));
      m.type = ensureType(m.type);
      const editorId = editorOf(editedBy);
      let ownerId = input.owner !== undefined ? (m.owner ? personId(m.owner) : null) : row.owner_id;
      if (ownerId == null && editorId != null) ownerId = editorId; // updating an ownerless document claims it
      const version = row.version + 1;
      run(`UPDATE documents SET title=?, type=?, doc_date=?, owner_id=?, editor_id=?, topic=?, claim=?, answer=?, body=?,
           size_bytes=?, content_hash=?, version=?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        m.title, m.type, m.date, ownerId, editorId, m.topic, m.claim, m.says, m.body, Buffer.byteLength(m.body), sha256(m.body), version, row.id);
      setCountries(row.id, m.countries);
      const gen = generate(m.body, m.title);
      const summary = m.summary !== undefined ? m.summary : row.meta_source === 'heuristic' ? gen.summary : cur.summary;
      writeMeta(row.id, { summary, generated: gen.keywords, manual: m.keywords, source: m.summary !== undefined ? 'manual' : row.meta_source });
      snapshot(row.id, version, m, ownerId, editedBy);
      return getDocument(file);
    });
  }

  function suggestClaim(topic, answerText) {
    const same = one('SELECT claim FROM documents WHERE topic = ? AND lower(answer) = lower(?) LIMIT 1', topic, answerText.trim());
    if (same) return same.claim;
    const used = all('SELECT DISTINCT claim FROM documents WHERE topic = ?', topic).map(r => r.claim);
    for (let i = 0; ; i++) {
      const c = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
      if (!used.includes(c)) return c;
    }
  }

  // One entry point for the UI: new upload, or replace an existing document with a new version.
  function saveUpload(b) {
    return transaction(() => {
      const email = checkEmail(b.email);
      if (typeof b.fileName !== 'string' || b.fileName.length > 200 || !/\.(md|markdown|txt)$/i.test(b.fileName)) bad('Only .md and .txt files are supported for now');
      if (typeof b.content !== 'string' || !b.content.trim()) bad('The file is empty');
      const now = getSetting('now');
      const text = v => (v === undefined || v === null || v === '' ? undefined : v);
      const topicIn = text(b.topic), answerIn = text(b.answer);
      const kwIn = text(b.keywords) === undefined ? [] : normKeywords(b.keywords);
      const typeIn = typeof b.type === 'string' ? b.type.trim().replace(/\s+/g, ' ') : '';
      const typeIsNew = !!typeIn && !one('SELECT 1 AS x FROM document_types WHERE name = ?', typeIn);
      const newKeywords = kwIn.filter(k => !one('SELECT 1 AS x FROM keywords WHERE keyword = ?', k));
      const added = () => ({ type: typeIsNew ? typeIn : null, keywords: newKeywords }); // what was new to the database
      const withKw = f => { if (kwIn.length) f.keywords = kwIn; return f; };

      if (b.replaces) {
        const cur = getDocument(b.replaces);
        if (!cur) throw new HttpError(404, 'The document to update was not found');
        const topic = topicIn ?? cur.topic;
        const fields = withKw({ body: b.content, date: text(b.date) ?? now });
        for (const k of ['title', 'type', 'countries']) if (text(b[k]) !== undefined) fields[k] = b[k];
        if (Array.isArray(fields.countries) && !fields.countries.length) delete fields.countries;
        if (topicIn !== undefined) fields.topic = topicIn;
        if (answerIn !== undefined) fields.answer = answerIn;
        const newAnswer = answerIn ?? cur.says;
        if (topic && newAnswer && text(b.claim) === undefined && (answerIn !== undefined || topicIn !== undefined)) fields.claim = suggestClaim(topic, newAnswer);
        if (text(b.claim) !== undefined) fields.claim = b.claim;
        const document = updateDocument(b.replaces, fields, email);
        return { action: 'updated', document, added: added() };
      }
      const fields = withKw({
        title: text(b.title) ?? headingOf(b.content) ?? titleFromName(b.fileName),
        type: typeIn || 'Document', date: text(b.date) ?? now, countries: b.countries,
        topic: topicIn ?? null, answer: answerIn, body: b.content,
        ownerEmail: email, source: 'upload', originalName: b.fileName
      });
      if (topicIn) fields.claim = text(b.claim) ?? (answerIn ? suggestClaim(topicIn, answerIn) : undefined);
      const document = createDocument(fields, email);
      return { action: 'created', document, added: added() };
    });
  }

  // Fills metadata for documents stored before metadata existed.
  function backfillMetadata() {
    for (const r of all("SELECT id, title, body FROM documents WHERE summary = ''")) {
      { const g = generate(r.body, r.title); writeMeta(r.id, { summary: g.summary, generated: g.keywords, source: 'heuristic' }); }
    }
  }

  // Simulated search: the LLM question routing will replace this. Matches question text and document keywords.
  function search(q) {
    const toks = [...new Set(tokenize(q))].slice(0, 12);
    if (!toks.length) return { query: q, questions: [], documents: [] };
    const ph = toks.map(() => '?').join(',');
    const byTopic = Object.fromEntries(all(
      `SELECT d.topic AS t, COUNT(DISTINCT k.keyword) AS n FROM document_keywords k JOIN documents d ON d.id = k.document_id
       WHERE d.topic IS NOT NULL AND k.keyword IN (${ph}) GROUP BY d.topic`, ...toks).map(r => [r.t, r.n]));
    const questions = all('SELECT id, text FROM questions ORDER BY rowid').map(x => {
      const qt = new Set(tokenize(x.text));
      return { id: x.id, text: x.text, score: toks.filter(t => qt.has(t)).length * 2 + (byTopic[x.id] || 0) };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    const documents = all(
      `SELECT d.file FROM document_keywords k JOIN documents d ON d.id = k.document_id WHERE k.keyword IN (${ph})
       GROUP BY d.id ORDER BY COUNT(DISTINCT k.keyword) DESC, SUM(k.weight) DESC, d.file LIMIT 8`, ...toks).map(r => getMeta(r.file));
    return { query: q, questions, documents };
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
      version: v.version, title: v.title, type: v.type, date: v.doc_date, owner: label(v.owner_name, v.owner_role),
      countries: v.countries.split(','), topic: v.topic, claim: v.claim, says: v.answer, body: v.body,
      editedBy: v.edited_by, editedAt: v.edited_at
    }));
  }

  // ---- answer log (knowledge gaps) -----------------------------------------------------
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
    saveUpload, suggestClaim, backfillMetadata, listCountries, countryCodes, addCountry, listTypes, listKeywords, search, documentVersions, logAnswer, gapReport
  };
}

module.exports = { createRepo, HttpError };
