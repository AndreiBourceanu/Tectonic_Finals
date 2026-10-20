'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { answer, MAX } = require('./trust');
const { ISO } = require('./countries');
const { openDb, driverName } = require('./db');
const { createRepo, HttpError } = require('./repo');
const { seedIfEmpty } = require('./seed');
const { createSteward } = require('./steward');
const ai = require('./ai');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function createServer({ now, db = openDb() } = {}) {
  const repo = createRepo(db);
  if (process.env.SEED_DEMO !== 'false') seedIfEmpty(repo); // demo data only when the DB is empty
  repo.backfillMetadata();
  const today = () => now || process.env.TRUST_NOW || repo.getSetting('now');
  const steward = createSteward(repo, { now: today, ai });
  const first = steward.sweep('on start');
  repo.logActivity('watch', `Started watching ${first.sources} sources across ${first.questions} questions. ${first.latentConflicts} latent conflict(s) found; nobody is disturbed until someone actually needs that answer.`);

  // Topics with the vocabulary of their sources, so routing understands more than the question text.
  const topics = () => repo.questionTexts().map(q => ({
    id: q.id, text: q.text,
    vocabulary: repo.getQuestionWithSources(q.id).sources.map(s => `${s.title} ${s.says}`).join(' ')
  }));
  // Answer + who really knows, learned from work signals (shown only when the answer is not green).
  function answerWithPeople(questionId, country) {
    const q = repo.getQuestionWithSources(questionId);
    const result = answer(q, country, today(), repo.countryCodes());
    result.experts = steward.expertsFor(questionId);
    result.ai = { enabled: ai.enabled(), model: ai.enabled() ? ai.MODEL : null };
    if (result.verdict !== 'rely') {
      repo.logAnswer({ questionId, country, verdict: result.verdict, gap: result.gap, conflict: !!result.conflict });
      steward.sweep('after an unreliable answer'); // the question was really needed: maybe worth a one-click check now
    }
    return result;
  }
  const fail = e => { if (e.status) throw new HttpError(e.status, e.message); throw e; };

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
        if (typeof questionId !== 'string' || !repo.getQuestionWithSources(questionId)) throw new HttpError(400, `Unknown questionId "${questionId}"`);
        if (!repo.countryCodes().includes(country)) throw new HttpError(400, `Unknown country "${country}"`);
        return send(res, 200, answerWithPeople(questionId, country));
      }
      // Free-text question, routed to a topic by Claude (or the keyword fallback).
      if (m === 'POST' && r1 === 'ask' && parts.length === 2) {
        const { text, country } = await readJson(req);
        if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new HttpError(400, 'text is required (max 500 characters)');
        const route = await ai.routeQuestion(text.trim(), topics());
        const c = route.country || country;
        if (!repo.countryCodes().includes(c)) throw new HttpError(400, `Unknown country "${c}"`);
        if (!route.questionId) {
          return send(res, 200, { matched: false, text, country: c, route,
            message: 'Nothing in the knowledge base covers this yet. Ask a colleague; if they answer in chat, Trust Lens can capture it.' });
        }
        return send(res, 200, { matched: true, route, ...answerWithPeople(route.questionId, c) });
      }
      if (r1 === 'documents') {
        if (m === 'GET' && parts.length === 2) return send(res, 200, repo.listDocuments());
        if (m === 'POST' && parts.length === 2) {
          const body = await readJson(req, 500_000);
          const doc = repo.createDocument(body, String(body.editedBy || 'api').slice(0, 80));
          steward.sweep('after a new document');
          return send(res, 201, doc);
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
          const doc = repo.updateDocument(file, body, String(body.editedBy || 'api').slice(0, 80));
          steward.sweep('after a document change');
          return send(res, 200, doc);
        }
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
        const result = repo.saveUpload(await readJson(req, 500_000));
        steward.sweep('after an upload');
        return send(res, result.action === 'created' ? 201 : 200, result);
      }
      if (m === 'GET' && r1 === 'people' && parts.length === 2) return send(res, 200, repo.listPeople());
      if (m === 'GET' && r1 === 'gaps' && parts.length === 2) return send(res, 200, repo.gapReport());

      // ---- keep it trusted ------------------------------------------------------------
      // A connector (Teams, mail, wiki...) pushes raw content; Claude classifies it. Nobody labels anything.
      if (m === 'POST' && r1 === 'ingest' && parts.length === 2) {
        const b = await readJson(req, 250_000);
        if (typeof b.title !== 'string' || typeof b.body !== 'string') throw new HttpError(400, 'title and body are required');
        const ts = topics();
        const cls = await ai.classify({ title: b.title, body: b.body }, ts);
        const countries = b.countries && b.countries.length ? b.countries : cls.countries.length ? cls.countries : repo.countryCodes();
        let claim = null;
        if (cls.topic && cls.answer) {
          const q = repo.getQuestionWithSources(cls.topic);
          claim = await ai.matchClaim(cls.answer, q.sources.filter(s => countries.some(c => s.countries.includes(c))), q.sources);
        }
        const doc = repo.createDocument({
          title: b.title, type: b.type || 'Note', date: b.date || today(), owner: b.owner || null, countries, body: b.body,
          ...(claim ? { topic: cls.topic, claim: claim.label, answer: cls.answer } : {})
        }, String(b.source || 'connector').slice(0, 80));
        repo.logActivity('ingest', `Read “${doc.title}” from ${b.source || 'a connector'} (${cls.via}): ${claim ? `answers “${cls.topic}” with “${cls.answer}”${claim.matched ? `, agrees with “${claim.matched}”` : ', a new statement'}` : 'not about a known question, kept as context'}.`);
        steward.sweep('after ingesting content');
        return send(res, 201, { document: doc, classification: { ...cls, claim } });
      }
      if (m === 'GET' && r1 === 'experts' && parts.length === 3) {
        if (!repo.getQuestionWithSources(file)) throw new HttpError(404, 'Unknown topic');
        return send(res, 200, steward.expertsFor(file));
      }
      if (r1 === 'verifications') {
        if (m === 'GET' && parts.length === 2) {
          return send(res, 200, repo.openVerifications().map(v => ({ ...v, document: (d => d && { title: d.title, says: d.says, type: d.type })(repo.getDocument(v.file)) })));
        }
        if (m === 'POST' && parts.length === 3) {
          const id = Number(file);
          if (!Number.isInteger(id)) throw new HttpError(400, 'Bad check id');
          const { response } = await readJson(req);
          return send(res, 200, await steward.respond(id, response).catch(fail));
        }
      }
      if (m === 'POST' && r1 === 'steward' && file === 'run' && parts.length === 3) return send(res, 200, steward.sweep('on request'));
      // HR system webhook (SD Worx knows when people change roles): no one has to remember to update ownership.
      if (m === 'POST' && r1 === 'events' && file === 'role-change' && parts.length === 3) {
        const { person, newRole } = await readJson(req);
        if (typeof person !== 'string' || !person.trim()) throw new HttpError(400, 'person is required');
        if (newRole != null && (typeof newRole !== 'string' || newRole.length > 80)) throw new HttpError(400, 'newRole must be a string');
        return send(res, 200, steward.roleChange(person.trim(), newRole ? newRole.trim() : null));
      }
      // An expert answered in chat: capture it as a draft source, published in one click.
      if (m === 'POST' && r1 === 'expert-replies' && parts.length === 2) {
        return send(res, 201, await steward.expertReply(await readJson(req)).catch(fail));
      }
      if (m === 'GET' && r1 === 'activity' && parts.length === 2) {
        const stats = repo.verificationStats();
        return send(res, 200, {
          watching: steward.lastSweep(), budgetPerPerson: steward.BUDGET,
          checks: { total: stats.total || 0, open: stats.open || 0, answered: stats.done || 0 },
          counts: repo.activityCounts(), items: repo.listActivity(40),
          ai: { enabled: ai.enabled(), model: ai.enabled() ? ai.MODEL : null }
        });
      }
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
