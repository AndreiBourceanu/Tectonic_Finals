'use strict';
// Knowledge check, run after every upload or edit. Local rules always run (they need no model). The model adds the
// semantic problems (documents that contradict each other without a shared label) and suggests how to fix them.
// The model only proposes: its findings are validated (real documents, verbatim quotes, people from our table).
const { parseMonth } = require('./trust');

const STALE_MONTHS = 36;
const short = (s, n = 110) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Deterministic checks over the changed document and its neighbours.
function localFindings({ repo, doc, docs, now }) {
  const out = [];
  const contactsOf = files => repo.peopleOfDocuments(files).slice(0, 2).map(p => ({ personId: p.id, reason: 'owns or last edited a document involved' }));
  const who = d => d.owner || 'its owner';

  // 1. Same question, different claims, for a country both cover.
  const withTopic = docs.filter(d => d.topic && d.claim);
  for (let i = 0; i < withTopic.length; i++) for (let j = i + 1; j < withTopic.length; j++) {
    const a = withTopic[i], b = withTopic[j];
    if (a.topic !== b.topic || a.claim === b.claim) continue;
    const shared = a.countries.filter(c => b.countries.includes(c));
    if (!shared.length || (a.file !== doc.file && b.file !== doc.file)) continue;
    out.push({
      kind: 'conflict', confidence: 'high', source: 'local', key: shared.join(','),
      explanation: `“${a.title}” says “${short(a.says)}”, but “${b.title}” says “${short(b.says)}” for ${shared.join(', ')}.`,
      action: `Decide which is right and correct the other document. Start with ${who(a)} and ${who(b)}.`,
      files: [{ file: a.file, quote: short(a.says, 200) }, { file: b.file, quote: short(b.says, 200) }], contacts: contactsOf([a.file, b.file])
    });
  }

  // 2. A country that other documents cover but no source about this question covers.
  if (doc.topic) {
    const q = repo.getQuestion(doc.topic);
    const covered = new Set(docs.filter(d => d.topic === doc.topic).flatMap(d => d.countries));
    const missing = repo.countriesInUse().filter(c => !covered.has(c));
    if (q && missing.length) out.push({
      kind: 'gap', confidence: 'medium', source: 'local', key: missing.join(','),
      explanation: `No source about “${q.text}” covers ${missing.join(', ')}.`,
      action: `Ask ${doc.owner || q.expert || 'the owner'} whether the rule also applies there, and add a document for ${missing.join(', ')}.`,
      files: [{ file: doc.file, quote: '' }], contacts: contactsOf([doc.file])
    });
  }

  // 3. No named owner, or very old.
  for (const d of docs) {
    if (!d.owner) out.push({
      kind: 'ownership', confidence: 'medium', source: 'local',
      explanation: `“${d.title}” has no named owner, so nobody is accountable for keeping it correct.`,
      action: 'Assign an owner by uploading a new version with an email address.', files: [{ file: d.file, quote: '' }],
      contacts: contactsOf([d.file])
    });
    const age = parseMonth(now) - parseMonth(d.date);
    if (age > STALE_MONTHS) out.push({
      kind: 'outdated', confidence: 'medium', source: 'local',
      explanation: `“${d.title}” was last updated ${age} months ago.`,
      action: `Ask ${who(d)} to confirm it is still valid, or retire it.`, files: [{ file: d.file, quote: '' }], contacts: contactsOf([d.file])
    });
  }
  return out;
}

async function diagnose({ repo, llm, file, now }) {
  const doc = repo.getDocument(file);
  if (!doc) return null;
  const resolved = repo.resolveStaleFindings(file); // what earlier findings said about the old version is settled by this edit
  const near = repo.neighbours(file, 4);
  const docs = [doc, ...near];
  const info = { used: false, model: null, error: null };

  const findings = localFindings({ repo, doc, docs, now });

  if (llm && llm.enabled() && typeof llm.diagnose === 'function' && near.length) {
    const people = repo.listPeople().slice(0, 200).map(p => ({ name: p.name, role: p.role }));
    const numbered = docs.map((d, i) => ({ n: i + 1, file: d.file, title: d.title, type: d.type, date: d.date, owner: d.owner, countries: d.countries, body: d.body }));
    const r = await llm.diagnose({ docs: numbered, people, today: now });
    if (r.ok) {
      info.used = true; info.model = r.model;
      for (const f of r.findings) {
        const files = f.docs.map(n => ({ file: numbered[n - 1].file, quote: f.quotes.find(q => q.n === n)?.quote || '' }));
        const contacts = f.contacts.map(c => { const p = repo.personByName(c.name); return p ? { personId: p.id, reason: c.reason } : null; }).filter(Boolean);
        if (!contacts.length) for (const p of repo.peopleOfDocuments(files.map(x => x.file)).slice(0, 2)) contacts.push({ personId: p.id, reason: 'owns or last edited a document involved' });
        const sig = x => `${x.kind}|${[...new Set(x.files.map(y => y.file))].sort().join(',')}`;
        const twin = findings.find(x => x.source === 'local' && sig(x) === sig({ kind: f.kind, files }));
        if (twin) Object.assign(twin, { source: 'llm', explanation: f.explanation, action: f.action || twin.action, files: files.map(x => ({ file: x.file, quote: x.quote || twin.files.find(y => y.file === x.file)?.quote || '' })), contacts: contacts.length ? contacts : twin.contacts }); // same problem the local rules found: keep one finding, with the model's wording
        else findings.push({ kind: f.kind, confidence: f.confidence, source: 'llm', explanation: f.explanation, action: f.action, files, contacts });
      }
    } else info.error = r.error;
  } else if (llm && llm.enabled()) info.error = 'nothing-to-compare';

  const raised = new Set(repo.saveFindings(file, findings));
  return {
    file, title: doc.title, version: doc.version, resolved, llm: info,
    compared: near.map(d => ({ file: d.file, title: d.title })),
    findings: repo.listFindings({ status: 'open' }).filter(f => raised.has(f.id) || f.documents.some(d => d.file === file)) // what this check raised, plus anything open about this document
  };
}

module.exports = { diagnose, localFindings };
