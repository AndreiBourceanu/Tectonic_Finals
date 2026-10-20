'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { answer, MAX } = require('./trust');
const { ISO } = require('./countries');
const { createLlm } = require('./llm');
const { load: loadEnv } = require('./env');
const { openDb, driverName } = require('./db');
const { createRepo, HttpError } = require('./repo');
const { seedIfEmpty } = require('./seed');
const { ask, draft } = require('./ask');
const { diagnose } = require('./diagnose');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

// llm: a client from createLlm(). Off by default, so tests and demos never call an external API.
function createServer({ now, db = openDb(), llm = null } = {}) {
  const repo = createRepo(db);
  if (process.env.SEED_DEMO !== 'false') seedIfEmpty(repo); // demo data only when the DB is empty
  repo.backfillMetadata();
  const today = () => now || process.env.TRUST_NOW || repo.getSetting('now');

  // Knowledge check after every upload or edit. It runs in the background so the upload answers at once; the page
  // asks for the result (POST /api/diagnose) and gets the same run. A failure never affects the upload.
  const checks = new Map();
  const startCheck = file => {
    const p = diagnose({ repo, llm, file, now: today() })
      .catch(e => { if (!/not open|closed/i.test(e.message)) console.warn(`Knowledge check failed for ${file}: ${e.message}`); return null; })
      .finally(() => { if (checks.get(file) === p) checks.delete(file); });
    checks.set(file, p);
    return p;
  };

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const readJson = (req, limit = 10_000) => new Promise((resolve, reject) => {
    let raw = '', over = false;
    req.on('data', c => { if (over) return; raw += c; if (raw.length > limit) { over = true; reject(new HttpError(413, 'Body too large')); } });
    req.on('end', () => {
      if (over) return;
      try {
        const v = raw ? JSON.parse(raw) : {};
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'Body must be a JSON object'));
        resolve(v);
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const m = req.method;

      if (m === 'GET' && parts.length === 0) return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html');
      if (parts[0] !== 'api') throw new HttpError(404, 'Not found');
      const [, r1, file, sub] = parts;

      if (m === 'GET' && r1 === 'health' && parts.length === 2) {
        return send(res, 200, { ok: true, now: today(), documents: repo.countDocuments(), driver: driverName });
      }
      if (m === 'GET' && r1 === 'questions' && parts.length === 2) {
        return send(res, 200, { now: today(), countries: repo.countryCodes(), countryList: repo.listCountries(), max: MAX, questions: repo.listQuestions() });
      }
      if (m === 'POST' && r1 === 'answer' && parts.length === 2) {
        const { questionId, country } = await readJson(req);
        const q = repo.getQuestionWithSources(questionId);
        if (!q) throw new HttpError(400, `Unknown questionId "${questionId}"`);
        const codes = repo.countryCodes();
        if (!codes.includes(country)) throw new HttpError(400, `Unknown country "${country}"`);
        const result = answer(q, country, today(), codes);
        if (result.verdict !== 'rely') {
          repo.logAnswer({ questionId, country, verdict: result.verdict, gap: result.gap, conflict: !!result.conflict });
        }
        return send(res, 200, result);
      }
      if (r1 === 'documents') {
        if (m === 'GET' && parts.length === 2) return send(res, 200, repo.listDocuments());
        if (m === 'POST' && parts.length === 2) {
          const body = await readJson(req, 500_000);
          const created = repo.createDocument(body, String(body.editedBy || 'api').slice(0, 80));
          startCheck(created.file);
          return send(res, 201, created);
        }
        if (m === 'GET' && parts.length === 3) {
          const doc = repo.getDocument(file);
          if (!doc) throw new HttpError(404, 'Document not found');
          return send(res, 200, doc);
        }
        if (m === 'GET' && parts.length === 4 && sub === 'versions') {
          const v = repo.documentVersions(file);
          if (!v) throw new HttpError(404, 'Document not found');
          return send(res, 200, v);
        }
        if (m === 'PUT' && parts.length === 3) {
          const body = await readJson(req, 500_000);
          const updated = repo.updateDocument(file, body, String(body.editedBy || 'api').slice(0, 80));
          startCheck(updated.file);
          return send(res, 200, updated);
        }
      }
      if (m === 'POST' && r1 === 'ask' && parts.length === 2) { // the search bar: { query, country, useLlm }
        const body = await readJson(req);
        const codes = repo.countryCodes();
        return send(res, 200, await ask({ repo, llm, query: body.query, country: String(body.country || '').toUpperCase(), useLlm: body.useLlm === true, now: today(), codes }));
      }
      if (m === 'POST' && r1 === 'draft' && parts.length === 2) { // second model call: short answer from the strongest sources
        const body = await readJson(req);
        return send(res, 200, await draft({ repo, llm, query: body.query, country: String(body.country || '').toUpperCase(), now: today(), codes: repo.countryCodes() }));
      }
      if (m === 'GET' && r1 === 'search' && parts.length === 2) return send(res, 200, repo.search(url.searchParams.get('q') || ''));
      if (r1 === 'countries') {
        if (m === 'GET' && parts.length === 2) return send(res, 200, repo.listCountries());
        if (m === 'GET' && parts.length === 3 && file === 'iso') return send(res, 200, ISO); // every real country, for suggestions
        if (m === 'POST' && parts.length === 2) {
          const r = repo.addCountry((await readJson(req)).country);
          return send(res, r.added ? 201 : 200, r);
        }
      }
      if (m === 'GET' && r1 === 'types' && parts.length === 2) return send(res, 200, repo.listTypes());
      if (m === 'GET' && r1 === 'keywords' && parts.length === 2) return send(res, 200, repo.listKeywords(Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 40))));
      if (m === 'POST' && r1 === 'upload' && parts.length === 2) {
        const body = await readJson(req, 500_000);
        repo.checkUpload(body);                       // validate first: invalid uploads never reach the LLM
        let ai = null, llmError = null;
        if (llm && llm.enabled()) {                   // network call happens outside any database transaction
          const r = await llm.analyzeDocument({ title: body.title, fileName: body.fileName, text: body.content, types: repo.listTypes() });
          if (r.ok) ai = r.ai; else { llmError = r.error; console.warn(`LLM unavailable, using the built-in fallback: ${r.detail || r.error}`); }
        }
        const result = repo.saveUpload(body, { ai });
        startCheck(result.document.file);
        return send(res, result.action === 'created' ? 201 : 200, { ...result, llm: { used: !!ai, model: ai ? llm.model : null, error: llmError } });
      }
      if (m === 'POST' && r1 === 'diagnose' && parts.length === 2) { // result of the knowledge check for one document
        const body = await readJson(req);
        const f = typeof body.file === 'string' ? body.file : '';
        if (!repo.getDocument(f)) throw new HttpError(404, 'Document not found');
        const result = await (checks.get(f) || startCheck(f));
        return send(res, 200, result || { file: f, findings: repo.listFindings({ status: 'open', file: f }), llm: { used: false, model: null, error: 'failed' }, compared: [] });
      }
      if (r1 === 'findings') {
        if (m === 'GET' && parts.length === 2) {
          const st = url.searchParams.get('status') || 'open';
          if (st !== 'all' && !['open', 'resolved', 'dismissed'].includes(st)) throw new HttpError(400, 'status must be open, resolved, dismissed or all');
          return send(res, 200, repo.listFindings({ status: st === 'all' ? null : st, file: url.searchParams.get('file') || null }));
        }
        if (m === 'POST' && parts.length === 4 && parts[3] === 'status' && /^\d{1,9}$/.test(parts[2])) {
          const body = await readJson(req);
          return send(res, 200, repo.setFindingStatus(Number(parts[2]), body.status));
        }
      }
      if (m === 'GET' && r1 === 'people' && parts.length === 2) return send(res, 200, repo.listPeople());
      if (m === 'GET' && r1 === 'gaps' && parts.length === 2) return send(res, 200, repo.gapReport());
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof URIError) return send(res, 400, { error: 'Bad request' });
      console.error(e);
      send(res, 500, { error: 'Internal error' });
    }
  });
  server.db = db; // exposed so callers (tests, demo) can close it
  return server;
}

if (require.main === module) {
  loadEnv(); // reads .env / *.env from the project folder (never printed)
  const port = process.env.PORT || 3000;
  const llm = createLlm();
  createServer({ llm }).listen(port, () => {
    console.log(`Trust Lens running on http://localhost:${port}`);
    console.log(llm.enabled() ? `LLM: Gemini (${llm.model})` : 'LLM: off (no GEMINI_API_KEY found), using the built-in fallback');
  });
}

module.exports = { createServer };
