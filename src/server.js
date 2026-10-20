'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { answer, COUNTRIES, MAX } = require('./trust');
const { openDb, driverName } = require('./db');
const { createRepo, HttpError } = require('./repo');
const { seedIfEmpty } = require('./seed');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function createServer({ now, db = openDb(), adminToken = process.env.ADMIN_TOKEN } = {}) {
  const repo = createRepo(db);
  if (process.env.SEED_DEMO !== 'false') seedIfEmpty(repo); // demo data only when the DB is empty
  const today = () => now || process.env.TRUST_NOW || repo.getSetting('now');

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
  // Write routes need "Authorization: Bearer <ADMIN_TOKEN>" when ADMIN_TOKEN is set.
  const guard = req => {
    if (!adminToken) return;
    const given = Buffer.from(req.headers.authorization || '');
    const want = Buffer.from(`Bearer ${adminToken}`);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(401, 'Unauthorized');
  };

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
        return send(res, 200, { now: today(), countries: COUNTRIES, max: MAX, questions: repo.listQuestions() });
      }
      if (m === 'POST' && r1 === 'answer' && parts.length === 2) {
        const { questionId, country } = await readJson(req);
        const q = repo.getQuestionWithSources(questionId);
        if (!q) throw new HttpError(400, `Unknown questionId "${questionId}"`);
        if (!COUNTRIES.includes(country)) throw new HttpError(400, `Unknown country "${country}"`);
        const result = answer(q, country, today());
        if (result.verdict !== 'rely') {
          repo.logAnswer({ questionId, country, verdict: result.verdict, gap: result.gap, conflict: !!result.conflict });
        }
        return send(res, 200, result);
      }
      if (r1 === 'documents') {
        if (m === 'GET' && parts.length === 2) return send(res, 200, repo.listDocuments());
        if (m === 'POST' && parts.length === 2) {
          guard(req);
          const body = await readJson(req, 250_000);
          return send(res, 201, repo.createDocument(body, String(body.editedBy || 'api').slice(0, 80)));
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
          guard(req);
          const body = await readJson(req, 250_000);
          return send(res, 200, repo.updateDocument(file, body, String(body.editedBy || 'api').slice(0, 80)));
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
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log(`Trust Lens running on http://localhost:${port}`));
}

module.exports = { createServer };
