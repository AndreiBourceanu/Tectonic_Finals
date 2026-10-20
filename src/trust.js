'use strict';
// Pure trust-scoring logic. No I/O, so it is easy to test.
const COUNTRIES = ['BE', 'NL', 'DE'];
const MAX = { fresh: 30, owner: 20, applies: 30, agreed: 20 };

function parseMonth(str) {
  const m = /^(\d{4})-(\d{2})$/.exec(str || '');
  if (!m) throw new Error(`Invalid month "${str}", expected YYYY-MM`);
  return +m[1] * 12 + +m[2];
}

// Freshness counts from the latest of "written" and "confirmed by a human in one click":
// an old document that its owner just confirmed is as fresh as a new one.
const lastTouched = s => (s.verifiedOn && parseMonth(s.verifiedOn) > parseMonth(s.date) ? s.verifiedOn : s.date);
// An owner who has left the role is accountable for nothing.
const hasOwner = s => !!s.owner && s.ownerActive !== false;

function scoreSource(s, country, all, now) {
  const touched = lastTouched(s);
  const age = parseMonth(now) - parseMonth(touched);
  const fresh = age <= 6 ? 30 : age <= 18 ? 20 : age <= 36 ? 10 : 0;
  const owner = hasOwner(s) ? 20 : 0;
  const applies = s.countries.includes(country) ? 30 : 0;
  const supporters = all.filter(z => z !== s && z.claim === s.claim && z.countries.includes(country)).length;
  const agreed = applies ? Math.min(20, supporters * 10) : 0;
  return { fresh, owner, applies, agreed, age, verified: touched !== s.date, total: fresh + owner + applies + agreed };
}

function explain(s, r, country) {
  return {
    fresh: `${r.verified ? `Confirmed still correct by ${s.verifiedBy || 'its owner'}` : 'Updated'} ${r.age < 1 ? 'this month' : r.age + ' months ago'}. ${r.fresh === 30 ? 'Fresh.' : r.fresh >= 20 ? 'Fairly recent.' : 'Getting old.'}`,
    owner: hasOwner(s) ? `Owned by ${s.owner}.`
      : s.owner ? `${s.owner} has left this role. Nobody is accountable for it right now.`
      : 'No named owner. Nobody is accountable for this.',
    applies: r.applies ? `Applies to ${country}.` : `Does not apply to ${country} (covers ${s.countries.join(', ')}).`,
    agreed: r.agreed ? `${r.agreed / 10} other applicable source(s) say the same.` : 'No other applicable source confirms this.'
  };
}

function answer(question, country, now, validCountries = COUNTRIES) {
  if (!validCountries.includes(country)) throw new Error(`Unknown country "${country}"`);
  const sources = question.sources
    .map(s => {
      const score = scoreSource(s, country, question.sources, now);
      return { file: s.file, title: s.title, type: s.type, date: s.date, owner: s.owner, ownerActive: s.ownerActive !== false,
               verifiedOn: s.verifiedOn || null, verifiedBy: s.verifiedBy || null, countries: s.countries,
               says: s.says, claim: s.claim, score, why: explain(s, score, country) };
    })
    .sort((a, b) => b.score.total - a.score.total);

  const applicable = sources.filter(x => x.score.applies > 0);
  const top = applicable[0] || null;
  const conflict = new Set(applicable.map(x => x.claim)).size > 1;
  const alt = conflict ? applicable.find(x => x.claim !== top.claim) : null;

  let verdict = 'hold', label = 'Don’t act on this yet';
  let text = 'No source covers this country. This is a gap in the knowledge base.';
  if (top) {
    text = top.says;
    if (top.score.total >= 75 && !conflict) { verdict = 'rely'; label = 'You can rely on it'; }
    else if (top.score.total >= 50) { verdict = 'check'; label = 'Check before you act'; }
  }
  const expert = verdict === 'rely' ? null
    : top ? question.expert
    : `No expert is mapped for ${country}. Escalate to the payroll desk and ask them to document the answer.`;

  return {
    questionId: question.id, question: question.text, country, verdict, label, answer: text,
    basedOn: top ? { file: top.file, title: top.title, score: top.score.total } : null,
    gap: !top,
    conflict: alt ? { best: { file: top.file, title: top.title, says: top.says }, other: { file: alt.file, title: alt.title, says: alt.says } } : null,
    expert, sources
  };
}

module.exports = { COUNTRIES, MAX, parseMonth, scoreSource, answer, lastTouched, hasOwner };
