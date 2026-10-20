'use strict';
// Search bar logic. The LLM only interprets the question (it picks keywords, people and a stored question from
// OUR tables). Documents are then fetched locally and scored by the deterministic trust algorithm in trust.js,
// so a trust score is never the model's opinion.
const { answer } = require('./trust');
const { HttpError } = require('./repo');

const MAX_ANSWERS = 3;
const cache = new Map(); // normalised query + vocabulary size -> interpretation (the model is slow, repeat queries should not be)

async function interpret(repo, llm, query) {
  const keywords = repo.listKeywords(400).map(k => k.keyword);
  const people = repo.listPeople().slice(0, 200).map(p => ({ name: p.name, role: p.role }));
  const questions = repo.listQuestions();
  const key = `${query.toLowerCase()}|${keywords.length}|${people.length}|${questions.length}`;
  if (cache.has(key)) return { ...cache.get(key), cached: true };
  const r = await llm.interpretQuery({ query, keywords, people, questions });
  if (r.ok) { if (cache.size >= 50) cache.delete(cache.keys().next().value); cache.set(key, r); }
  return r;
}

// Documents about a stored question are scored together (that is how agreement and conflicts are found).
// A document that belongs to no question stands alone: nothing to compare it with, so "agreed" stays at zero.
function groupAnswers(repo, docs, country, now, codes) {
  const topics = new Map(), solos = [];
  for (const d of docs) {
    if (d.topic) { if (!topics.has(d.topic)) topics.set(d.topic, []); topics.get(d.topic).push(d.file); }
    else solos.push(d);
  }
  const rank = new Map(docs.map((d, i) => [d.file, i])); // retrieve() already ordered the documents by relevance
  const best = files => Math.min(...files.map(f => rank.get(f)));
  const power = new Map(docs.map(d => [d.file, d.strength || 0]));
  const strength = files => Math.max(...files.map(f => power.get(f)));
  const out = [];
  for (const [topic, files] of topics) {
    const q = repo.getQuestionWithSources(topic);
    if (!q) continue;
    out.push({ ...answer(q, country, now, codes), kind: 'question', matched: files, rank: best(files), strength: strength(files) });
  }
  for (const d of solos) {
    const q = {
      id: `doc:${d.file}`, text: d.title,
      expert: d.owner ? `Ask ${d.owner}.` : 'No named owner. Ask the team that maintains this document.',
      sources: [{ file: d.file, title: d.title, type: d.type, date: d.date, owner: d.owner, countries: d.countries, says: d.says || d.summary || d.title, claim: `~${d.file}` }]
    };
    const r = answer(q, country, now, codes);
    if (r.gap) r.expert = `This document does not cover ${country}. Ask ${d.owner || 'the team that maintains it'} whether anything applies.`;
    out.push({ ...r, kind: 'document', matched: [d.file], rank: best([d.file]), strength: strength([d.file]) });
  }
  // Most relevant first (how strongly its documents matched); trust only breaks ties. Otherwise a loosely related but trusted answer would win.
  out.sort((a, b) => b.strength - a.strength || a.rank - b.rank || (b.basedOn?.score ?? -1) - (a.basedOn?.score ?? -1));
  // Keep only answers about as relevant as the best one. A single shared word is not enough to show an unrelated question.
  const top = out[0]?.strength || 0;
  return out.filter(x => x.strength * 2 > top).slice(0, MAX_ANSWERS);
}

async function ask({ repo, llm, query, country, useLlm, now, codes }) {
  const q = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
  if (!q) throw new HttpError(400, 'Type a question first');
  if (q.length > 300) throw new HttpError(400, 'The question is too long (max 300 characters)');
  if (!codes.includes(country)) throw new HttpError(400, `Unknown country "${country}"`);

  const info = { used: false, model: null, error: null, cached: false, keywords: [], people: [], question: null };
  let ai = null;
  if (useLlm && llm && llm.enabled()) {
    const r = await interpret(repo, llm, q);
    if (r.ok) {
      ai = r.ai; info.used = true; info.model = r.model; info.cached = !!r.cached;
      info.keywords = ai.keywords; info.people = ai.people;
      info.question = ai.questionId ? repo.getQuestion(ai.questionId)?.text || null : null;
    } else info.error = r.error;
  }
  const docs = repo.retrieve(q, ai);
  const answers = groupAnswers(repo, docs, country, now, codes);
  if (!useLlm && answers[0]?.kind === 'question' && answers[0].verdict !== 'rely') { // feeds the knowledge-gap report
    repo.logAnswer({ questionId: answers[0].questionId, country, verdict: answers[0].verdict, gap: answers[0].gap, conflict: !!answers[0].conflict });
  }
  return { query: q, country, answers, found: docs.length, llmAvailable: !!(llm && llm.enabled()), llm: info };
}

// Drafts a short answer from the strongest sources that apply to the country. Sources are scored by trust.js, the
// model only writes the text. Never throws for model problems: the page keeps showing the scored sources.
const MAX_DRAFT_DOCS = 4;
const draftCache = new Map();

async function draft({ repo, llm, query, country, now, codes }) {
  if (!llm || !llm.enabled()) return { draft: null, reason: 'disabled' };
  const r = await ask({ repo, llm, query, country, useLlm: true, now, codes }); // the interpretation is cached, so no second model call
  const picked = [], seen = new Set();
  r.answers.forEach((a, gi) => {
    let taken = 0;
    for (const src of a.sources) { // already sorted by trust; a source that does not apply to the country cannot support the answer
      if (!src.score.applies || seen.has(src.file) || picked.length >= MAX_DRAFT_DOCS || taken >= (gi === 0 ? 3 : 1)) continue;
      seen.add(src.file); taken++; picked.push(src);
    }
  });
  if (!picked.length) return { draft: null, reason: 'no-source', query: r.query };

  const docs = picked.map((src, i) => {
    const d = repo.getDocument(src.file);
    return { n: i + 1, file: src.file, title: src.title, type: src.type, date: src.date, owner: src.owner, countries: src.countries, trust: src.score.total, body: d.body, version: d.version };
  });
  const key = `${r.query.toLowerCase()}|${country}|${docs.map(d => `${d.file}@${d.version}`).join(',')}`;
  let res = draftCache.get(key), cached = !!res;
  if (!res) {
    res = await llm.draftAnswer({ query: r.query, country, docs });
    if (res.ok) { if (draftCache.size >= 50) draftCache.delete(draftCache.keys().next().value); draftCache.set(key, res); }
  }
  if (!res.ok) return { draft: null, reason: 'error', error: res.error, query: r.query };
  return {
    query: r.query,
    draft: { answer: res.draft.answer, covered: res.draft.covered, model: res.model, cached,
             sources: res.draft.sources.filter(n => docs[n - 1]).map(n => ({ n, file: docs[n - 1].file, title: docs[n - 1].title, trust: docs[n - 1].trust })) },
    used: docs.map(d => ({ n: d.n, file: d.file, title: d.title, trust: d.trust }))
  };
}

module.exports = { ask, draft, groupAnswers };
