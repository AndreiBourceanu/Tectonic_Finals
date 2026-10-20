'use strict';
// The steward: everything that keeps Trust Lens trusted without becoming another task.
//
//  sweep()        runs in the background (on start, after every unreliable answer, after every
//                 document or HR change). It watches every question in every country and decides
//                 which few human checks are worth someone's time.
//  respond()      applies a one-click answer to one of those checks.
//  roleChange()   reacts to an HR event (someone changes role or leaves).
//  expertReply()  turns an answer an expert gave in chat into a draft source, published in one click.
//
// Rules for asking a human (the "attention budget"):
//  - a conflict is only raised once someone has actually asked that question (no value otherwise)
//  - a stale source is only re-confirmed when it is the source answers rely on
//  - an ownerless source gets one handover proposal, to the person the work signals point to
//  - nobody has more than BUDGET open checks at any time; the rest waits, ranked by impact
//  - a check that was answered is never asked again until the document changes
const { answer } = require('./trust');
const { rankExperts } = require('./expertise');

const BUDGET = 2;           // open checks per person
const STALE_MONTHS = 12;    // a relied-on source not touched for this long gets a "still correct?"
const BASE = { draft: 90, conflict: 50, handover: 40, confirm: 20 };

function createSteward(repo, { now, ai } = {}) {
  const today = () => now();
  let last = { at: null, questions: 0, sources: 0, latentConflicts: 0, created: 0, waiting: 0 };

  const expertsFor = (topic, exclude = []) =>
    rankExperts(repo.signalsForTopic(topic), repo.peopleRaw(), today(), { exclude });

  function sweep(reason = 'background') {
    const n = today();
    const wanted = new Map(); // file|kind -> candidate
    const want = c => {
      const key = `${c.file}|${c.kind}`;
      const prev = wanted.get(key);
      if (!prev || prev.priority < c.priority) wanted.set(key, { ...c, countries: [...new Set([...(prev?.countries || []), c.country])] });
      else prev.countries = [...new Set([...prev.countries, c.country])];
    };
    let latent = 0;
    const files = new Set();
    const questions = repo.questionTexts();
    for (const q of questions) {
      const qs = repo.getQuestionWithSources(q.id);
      qs.sources.forEach(s => files.add(s.file));
      const codes = repo.countryCodes();
      for (const country of codes) {
        const r = answer(qs, country, n, codes);
        const asked = repo.askedCount(q.id, country);
        const top = r.basedOn ? repo.getDocument(r.basedOn.file) : null;
        if (!top) continue;
        const topScore = r.sources.find(s => s.file === top.file).score;
        if (r.conflict) {
          if (asked === 0) latent++;
          else if (top.ownerActive && top.ownerName) {
            want({ file: top.file, kind: 'conflict', person: top.ownerName, country, priority: BASE.conflict + asked * 10,
              reason: `People asked “${q.text}” (${country}) ${asked}× and got a warning: “${r.conflict.other.title}” contradicts your “${top.title}”.`,
              payload: { questionId: q.id, best: r.conflict.best, other: r.conflict.other } });
          }
        }
        // Any source answers rely on whose owner left: propose one handover, to whoever the work signals point to.
        for (const src of r.sources.filter(x => x.score.applies > 0)) {
          const d = repo.getDocument(src.file);
          if (!d.ownerName || d.ownerActive) continue;
          const next = expertsFor(q.id, [d.ownerName])[0];
          if (next) want({ file: d.file, kind: 'handover', person: next.name, country, priority: BASE.handover + asked * 10,
            reason: `“${d.title}” lost its owner: ${d.ownerName} changed role. Answers about “${q.text}” use it. Your work suggests you know this topic: ${next.why.join(', ')}.`,
            payload: { questionId: q.id, previousOwner: d.ownerName, why: next.why } });
        }
        if (top.ownerActive && top.ownerName && topScore.age > STALE_MONTHS) {
          want({ file: top.file, kind: 'confirm', person: top.ownerName, country, priority: BASE.confirm + asked * 10,
            reason: `Answers about “${q.text}” rely on your “${top.title}”, untouched for ${topScore.age} months. Is it still correct?`,
            payload: { questionId: q.id } });
        }
      }
    }
    let created = 0, waiting = 0;
    for (const c of [...wanted.values()].sort((a, b) => b.priority - a.priority)) {
      if (repo.hasVerification(c.file, c.kind)) continue;               // already asked, or answered since the last change
      if (repo.openCountFor(c.person) >= BUDGET) { waiting++; continue; } // attention budget
      repo.createVerification({ ...c, payload: { ...c.payload, countries: c.countries } });
      repo.logActivity('check_sent', `Asked ${c.person} for one click on “${repo.getDocument(c.file).title}” (${c.kind}). ${c.reason.split('.')[0]}.`);
      created++;
    }
    last = { at: new Date().toISOString(), reason, questions: questions.length, sources: files.size, latentConflicts: latent, created, waiting };
    return last;
  }

  // One-click answers. Every outcome is logged so the background work stays transparent.
  async function respond(id, response) {
    const v = repo.getVerification(id);
    if (!v) throw Object.assign(new Error('Check not found'), { status: 404 });
    if (v.status !== 'open') throw Object.assign(new Error('This check was already answered'), { status: 409 });
    const allowed = { conflict: ['keep', 'other'], confirm: ['yes', 'no'], handover: ['accept', 'decline'], draft: ['publish', 'discard'] }[v.kind];
    if (!allowed.includes(response)) throw Object.assign(new Error(`response must be one of: ${allowed.join(', ')}`), { status: 400 });
    const n = today();
    const doc = repo.getDocument(v.file);
    repo.transaction(() => {
      if (v.kind === 'conflict') {
        const { best, other } = v.payload;
        const otherDoc = repo.getDocument(other.file);
        if (response === 'other') {
          repo.updateDocument(doc.file, { claim: otherDoc.claim, answer: otherDoc.says }, v.person);
          repo.logActivity('corrected', `${v.person} corrected “${doc.title}”: the right answer is “${otherDoc.says}”.`);
        } else {
          repo.logActivity('verified', `${v.person} confirmed “${doc.title}”: “${best.says}”.`);
        }
        repo.setVerified(doc.file, v.person, n);
        if (!otherDoc.ownerActive || !otherDoc.ownerName) {
          repo.setStatus(otherDoc.file, 'retired');
          repo.logActivity('retired', `Retired ownerless “${otherDoc.title}” ${response === 'other' ? '(its answer now lives in ' + doc.title + ')' : '(contradicted by its accountable owner)'}. It no longer shows up in answers.`);
        } else {
          repo.createVerification({ file: otherDoc.file, person: otherDoc.ownerName, kind: 'confirm', priority: BASE.conflict,
            reason: `${v.person} says “${response === 'other' ? otherDoc.says : best.says}” is right, which ${response === 'other' ? 'agrees with' : 'contradicts'} your “${otherDoc.title}”. Is yours still correct?`,
            payload: { questionId: v.payload.questionId } });
        }
      } else if (v.kind === 'confirm') {
        if (response === 'yes') {
          repo.setVerified(doc.file, v.person, n);
          repo.logActivity('verified', `${v.person} confirmed “${doc.title}” is still correct. Freshness reset, nothing to rewrite.`);
        } else {
          repo.setStatus(doc.file, 'retired');
          repo.logActivity('retired', `${v.person} said “${doc.title}” is outdated. It no longer shows up in answers; the gap is now visible.`);
        }
      } else if (v.kind === 'handover') {
        if (response === 'accept') {
          repo.updateDocument(doc.file, { owner: repo.personLabel(v.person) }, v.person);
          repo.setVerified(doc.file, v.person, n);
          repo.logActivity('handover', `${v.person} took over “${doc.title}” from ${v.payload.previousOwner}. Answers are accountable again.`);
        } else {
          const exclude = [v.payload.previousOwner, v.person, ...(v.payload.declined || [])];
          const next = expertsFor(v.payload.questionId, exclude)[0];
          repo.logActivity('handover', `${v.person} declined “${doc.title}”.${next ? ` Proposed to ${next.name} instead.` : ' No other candidate: flagged as a gap.'}`);
          if (next) repo.createVerification({ file: doc.file, person: next.name, kind: 'handover', priority: v.priority,
            reason: `“${doc.title}” needs an owner after ${v.payload.previousOwner} changed role. Your work suggests you know this topic: ${next.why.join(', ')}.`,
            payload: { ...v.payload, why: next.why, declined: [...(v.payload.declined || []), v.person] } });
        }
      } else if (v.kind === 'draft') {
        if (response === 'publish') {
          repo.setStatus(doc.file, 'live');
          repo.setVerified(doc.file, v.person, n);
          repo.logActivity('published', `${v.person} published their chat answer as “${doc.title}”. Next time nobody has to ask.`);
        } else {
          repo.setStatus(doc.file, 'retired');
          repo.logActivity('retired', `${v.person} discarded the draft “${doc.title}”.`);
        }
      }
      repo.closeVerification(v.id, response);
    });
    return { check: repo.getVerification(id), sweep: sweep('after a one-click answer') };
  }

  function roleChange(name, newRole) {
    const r = repo.changeRole(name, newRole);
    repo.logActivity('hr_event', `HR system: ${name} moved from ${r.oldRoles.filter(Boolean).join(', ') || 'their role'}${newRole ? ' to ' + newRole : ''}. ${r.orphaned.length} source(s) lost their accountable owner. Their expertise on old topics will fade on its own.`);
    return { ...r, sweep: sweep('after an HR event') };
  }

  // An expert answered someone's question in chat. Capture it instead of losing it.
  async function expertReply({ questionId, country, person, text }) {
    const q = repo.getQuestionWithSources(questionId);
    if (!q) throw Object.assign(new Error(`Unknown questionId "${questionId}"`), { status: 400 });
    if (!repo.countryCodes().includes(country)) throw Object.assign(new Error(`Unknown country "${country}"`), { status: 400 });
    if (typeof person !== 'string' || !person.trim() || person.length > 120) throw Object.assign(new Error('person is required'), { status: 400 });
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) throw Object.assign(new Error('text is required (max 5000 characters)'), { status: 400 });
    const name = person.trim();
    const says = await ai.summarize(text, q.text);
    const claim = await ai.matchClaim(says.text, q.sources.filter(s => s.countries.includes(country)), q.sources);
    const doc = repo.transaction(() => {
      const d = repo.createDocument({
        title: `${q.text.replace(/\?$/, '')} (${country}): answer by ${name}`.slice(0, 200), type: 'Expert answer', date: today(),
        owner: repo.personLabel(name), countries: [country], topic: q.id, claim: claim.label, answer: says.text,
        body: `# ${q.text} (${country})\n\n> Answered by ${name} in Teams, captured by Trust Lens.\n\n${text.trim()}`
      }, name);
      repo.setStatus(d.file, 'draft');
      repo.addSignal({ person: name, topic: q.id, kind: 'expert_reply', month: today(), detail: `answered “${q.text}” for ${country}` });
      repo.createVerification({ file: d.file, person: name, kind: 'draft', priority: BASE.draft,
        reason: `You just answered “${q.text}” (${country}) in chat. Publish it so the next person gets it straight away? (summary: “${says.text}”)`,
        payload: { questionId: q.id, countries: [country] } });
      repo.logActivity('draft', `Captured ${name}'s chat answer on “${q.text}” (${country}) as a draft (${says.via}${claim.matched ? `, agrees with “${claim.matched}”` : ''}). One click to publish.`);
      return repo.getDocument(d.file);
    });
    return { document: doc, summary: says, claim };
  }

  return { sweep, respond, roleChange, expertReply, expertsFor, lastSweep: () => last, BUDGET };
}

module.exports = { createSteward, BUDGET, STALE_MONTHS };
