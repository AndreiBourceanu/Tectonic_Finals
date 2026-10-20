'use strict';
// The AI layer: Claude does the background reading so nobody has to label documents by hand.
//
//  routeQuestion()   free-text question -> the known topic it is about (+ country if mentioned)
//  classify()        new document -> topic, short answer, countries
//  matchClaim()      does this statement say the same thing as an existing source? (semantic agreement)
//  summarize()       long chat answer -> one short answer line
//
// With ANTHROPIC_API_KEY set, Claude is used. Without it (or if the call fails or times out),
// a transparent keyword fallback answers instead, so the demo never depends on the network.
// Every result says which one produced it (`via`), so the UI can show it.
const { COUNTRIES } = require('./trust');

const MODEL = process.env.TRUST_AI_MODEL || 'claude-haiku-5-5';
const TIMEOUT_MS = 12_000;
const enabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.TRUST_AI !== 'off';

async function claudeJson(system, prompt, maxTokens = 300) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system + '\nReply with one JSON object only, no prose.', messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Claude API returned ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return JSON');
  return JSON.parse(m[0]);
}

// Try Claude, fall back to the local heuristic. Never throws.
async function withFallback(viaClaude, fallback) {
  if (enabled()) {
    try { return { ...(await viaClaude()), via: 'Claude' }; }
    catch (e) { console.warn(`[ai] Claude unavailable (${e.message}), using the keyword fallback`); }
  }
  return { ...fallback(), via: 'keyword fallback' };
}

// ---- local heuristics -----------------------------------------------------------------
const STOP = new Set('a an and are as at be by can do does for from has have here how i if in is it its me my of on or our so that the this to us was we what when where which who why will with work works you your should about really know knows done before'.split(' '));
const COUNTRY_WORDS = { BE: ['belgium', 'belgian', 'be'], NL: ['netherlands', 'dutch', 'holland', 'nl'], DE: ['germany', 'german', 'deutschland', 'de'] };
const tokens = t => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.slice(0, 6));

function detectCountries(text) {
  const words = new Set(String(text).toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/));
  const upper = new Set(String(text).match(/\b[A-Z]{2}\b/g) || []);
  return COUNTRIES.filter(c => upper.has(c) || COUNTRY_WORDS[c].some(w => w.length > 2 && words.has(w)));
}

function keywordRoute(text, topics) {
  const q = new Set(tokens(text));
  let best = null;
  for (const t of topics) {
    const vocab = new Set(tokens(t.text + ' ' + (t.vocabulary || '')));
    const core = new Set(tokens(t.text));
    let score = 0;
    for (const w of q) if (core.has(w)) score += 2; else if (vocab.has(w)) score += 1;
    if (!best || score > best.score) best = { id: t.id, score };
  }
  return best && best.score >= 2 ? { questionId: best.id, confidence: Math.min(1, best.score / 6) } : { questionId: null, confidence: 0 };
}

const jaccard = (a, b) => {
  const x = new Set(tokens(a)), y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0; for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
};

const nextLabel = used => {
  for (let i = 0; i < 26; i++) { const l = String.fromCharCode(65 + i); if (!used.includes(l)) return l; }
  return 'N' + used.length;
};

function firstStatement(body) {
  // first line that states something: skip headings' markup, questions and "Q:" lines, drop "A:" prefixes
  const lines = String(body).split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).filter(l => l.length > 3);
  const line = lines.map(l => l.replace(/^(a|answer)\s*:\s*/i, '')).find(l => !/^(q|question)\s*:/i.test(l) && !/\?\s*$/.test(l)) || lines[0] || String(body).trim();
  const sentence = line.split(/(?<=[.!?])\s/)[0];
  return sentence.replace(/[.!]$/, '').slice(0, 200);
}

// ---- public API -----------------------------------------------------------------------
async function routeQuestion(text, topics) {
  const r = await withFallback(
    () => claudeJson(
      'You route employee questions to the topic they are about, for an HR/payroll knowledge base. Only pick a topic if the question is really about it.',
      `Topics:\n${topics.map(t => `- ${t.id}: ${t.text}`).join('\n')}\n\nQuestion: ${text}\n\nReturn {"questionId": "<topic id or null>", "confidence": <0..1>, "country": "<BE|NL|DE or null if not mentioned>"}`),
    () => ({ ...keywordRoute(text, topics), country: detectCountries(text)[0] || null })
  );
  if (r.questionId && !topics.some(t => t.id === r.questionId)) r.questionId = null;
  if (r.country && !COUNTRIES.includes(r.country)) r.country = null;
  return r;
}

async function summarize(text, question) {
  return withFallback(
    () => claudeJson('You condense an expert answer into one short, factual answer line (max 120 characters), in the language of the answer.',
      `Question: ${question}\nExpert answer: ${text}\n\nReturn {"text": "<short answer>"}`),
    () => ({ text: firstStatement(text) })
  ).then(r => ({ ...r, text: String(r.text || firstStatement(text)).slice(0, 300) }));
}

// sources: [{claim, says, title}] on the same topic. Returns {label, matched: title|null}.
async function matchClaim(statement, applicable, allOnTopic = applicable) {
  const claims = [...new Map(allOnTopic.filter(s => s.claim).map(s => [s.claim, s])).values()];
  const used = claims.map(s => s.claim);
  const r = await withFallback(
    () => claudeJson('You decide whether a new statement means the same thing as one of the existing statements (same rule, maybe different words). Different rules must not match.',
      `Existing statements:\n${claims.map(s => `- ${s.claim}: ${s.says}`).join('\n') || '(none)'}\n\nNew statement: ${statement}\n\nReturn {"label": "<matching label, or null if it says something different>"}`),
    () => {
      let best = null;
      for (const s of claims) { const j = jaccard(statement, s.says); if (j >= 0.5 && (!best || j > best.j)) best = { label: s.claim, j }; }
      return { label: best ? best.label : null };
    }
  );
  const hit = r.label && claims.find(s => s.claim === r.label);
  return hit ? { label: hit.claim, matched: hit.title, via: r.via } : { label: nextLabel(used), matched: null, via: r.via };
}

// doc: {title, body}. topics: [{id, text, vocabulary}]. Returns {topic, answer, countries, via}.
async function classify(doc, topics) {
  const r = await withFallback(
    () => claudeJson('You read a company document for an HR/payroll knowledge base and extract what it states.',
      `Topics:\n${topics.map(t => `- ${t.id}: ${t.text}`).join('\n')}\n\nDocument title: ${doc.title}\nDocument:\n${String(doc.body).slice(0, 6000)}\n\n` +
      'Return {"topic": "<topic id this document answers, or null>", "answer": "<the answer it gives to that topic question, max 120 characters, or null>", "countries": ["<BE|NL|DE it applies to, empty if not stated>"]}', 400),
    () => {
      const route = keywordRoute(doc.title + ' ' + doc.body, topics);
      return { topic: route.questionId, answer: route.questionId ? firstStatement(doc.body.replace(/^#.*$/m, '')) : null, countries: detectCountries(doc.title + ' ' + doc.body) };
    }
  );
  return {
    topic: topics.some(t => t.id === r.topic) ? r.topic : null,
    answer: r.answer ? String(r.answer).slice(0, 300) : null,
    countries: (Array.isArray(r.countries) ? r.countries : []).map(c => String(c).toUpperCase()).filter(c => COUNTRIES.includes(c)),
    via: r.via
  };
}

module.exports = { enabled, routeQuestion, summarize, matchClaim, classify, detectCountries, keywordRoute, jaccard, MODEL };
