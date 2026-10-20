'use strict';
// Scripted demo: good / conflict / gap cases, then the finals story (targeted checks, HR event,
// expert answer captured, free text, connector). Starts its own in-memory server.
const { createServer } = require('../src/server');
const { openDb } = require('../src/db');

const SCENES = [
  ['GOOD CASE: clean agreement', 'retro-correction', 'NL'],
  ['CONFLICT CASE: sources disagree', 'leaver-bonus', 'BE'],
  ['GAP CASE: nothing covers this country', 'leaver-bonus', 'DE']
];
const ICON = { rely: '🟢', check: '🟡', hold: '🔴' };

(async () => {
  const server = createServer({ db: openDb(':memory:') }); // fresh in-memory DB, seeded from data/corpus
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (questionId, country) => (await fetch(base + '/api/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId, country })
  })).json();
  const show = (title, r, country) => {
    console.log(`\n=== ${title} ===`);
    console.log(`Q: ${r.question}  [${country}]`);
    console.log(`${ICON[r.verdict]} ${r.label}: ${r.answer}`);
    if (r.basedOn) console.log(`   Based on ${r.basedOn.title} (${r.basedOn.score}/100)`);
    if (r.conflict) console.log(`   ⚠ Conflict: "${r.conflict.best.says}" vs "${r.conflict.other.says}" (${r.conflict.other.title})`);
    if (r.expert) console.log(`   → Ask: ${r.expert}`);
    for (const s of r.sources) {
      const x = s.score;
      console.log(`   - ${s.title.padEnd(24)} ${String(x.total).padStart(3)}/100  fresh ${x.fresh} owner ${x.owner} applies ${x.applies} agreed ${x.agreed}`);
    }
  };
  for (const [title, questionId, country] of SCENES) show(title, await ask(questionId, country), country);

  // Live database: add the missing German policy through the API, then ask again. No restart.
  const created = await fetch(base + '/api/documents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Leaver bonus rule (Germany)', type: 'Policy', date: '2026-09', owner: 'Jan Weber (Compliance DE)',
      countries: ['DE'], topic: 'leaver-bonus', claim: 'A', answer: 'Pro rata by months worked',
      body: '# Leaver bonus - Germany\nPro rata by months worked.', editedBy: 'Jan Weber'
    })
  });
  console.log(`\n>>> Jan Weber adds a German policy through the API (HTTP ${created.status})`);
  show('GAP CLOSED: same question, no restart', await ask('leaver-bonus', 'DE'), 'DE');
  const gaps = await (await fetch(base + '/api/gaps')).json();
  console.log('\n=== KNOWLEDGE GAPS LOGGED ===');
  console.log(gaps.ranked.map(g => `${g.questionId} (${g.country}) asked ${g.asked}x, gaps ${g.gaps}, conflicts ${g.conflicts}`).join('\n'));

  // ---- Finals: keep it trusted without becoming another task ---------------------------
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const get = async p => (await fetch(base + p)).json();
  const checks = async () => {
    const list = await get('/api/verifications');
    console.log(list.length ? list.map(v => `   📨 one click for ${v.person} [${v.kind}]: ${v.reason}`).join('\n') : '   (no check needed: nobody is disturbed)');
    return list;
  };
  console.log('\n=== WHO REALLY KNOWS (learned from chat answers, tickets, edits; nobody filled in a profile) ===');
  for (const e of await get('/api/experts/leaver-bonus')) console.log(`   ${e.name} (${e.role}): ${e.why.join(', ')}`);

  console.log('\n=== TARGETED CHECKS: the conflict was asked about, so its owner gets exactly one click ===');
  let list = await checks();
  const c = list.find(v => v.kind === 'conflict' && v.person === 'Nadia Peeters');
  await post('/api/verifications/' + c.id, { response: 'keep' });
  console.log('>>> Nadia clicks "Mine is right"');
  show('CONFLICT RESOLVED: same question', await ask('leaver-bonus', 'BE'), 'BE');

  console.log('\n=== HR EVENT: Nadia Peeters moves to Finance Ops (from the HR system, nobody updates anything) ===');
  await post('/api/events/role-change', { person: 'Nadia Peeters', newRole: 'Finance Ops' });
  list = await checks();
  const h = list.find(v => v.kind === 'handover');
  await post('/api/verifications/' + h.id, { response: 'accept' });
  console.log(`>>> ${h.person} clicks "I'll own it"`);

  console.log('\n=== EXPERT ANSWER CAPTURED: an answer given in Teams becomes reusable knowledge ===');
  const r = await post('/api/expert-replies', { questionId: 'new-hire-deadline', country: 'NL', person: 'Ines Mertens',
    text: 'For the Netherlands we report a new hire before the first working day, same as Belgium.' });
  console.log(`   Draft: "${r.document.title}" (${r.summary.via}; agrees with ${r.claim.matched || 'nothing yet'})`);
  list = await checks();
  await post('/api/verifications/' + list.find(v => v.kind === 'draft').id, { response: 'publish' });
  show('GAP CLOSED BY A CHAT ANSWER', await ask('new-hire-deadline', 'NL'), 'NL');

  console.log('\n=== FREE TEXT + CONNECTOR: nobody labels anything ===');
  const free = await post('/api/ask', { text: 'Who approves a retroactive correction of a payslip in the Netherlands?', country: 'BE' });
  console.log(`   "${free.route && free.question}" routed by ${free.route.via} -> ${ICON[free.verdict]} ${free.answer} (${free.country})`);
  const ing = await post('/api/ingest', { title: 'Teams: #payroll-help (NL)', source: 'Teams', body: 'Q: leaver bonus for Dutch employees?\nA: In the Netherlands the leaver bonus is pro rata by days worked.' });
  console.log(`   Ingested "${ing.document.title}": topic ${ing.document.topic}, agrees with ${ing.classification.claim.matched || 'nothing'} (${ing.classification.via})`);

  const act = await get('/api/activity');
  console.log(`\n=== BEHIND THE SCENES: ${act.watching.sources} sources watched, ${act.checks.total} one-click checks sent, ${act.checks.answered} answered, ${act.watching.latentConflicts} latent conflicts left alone ===`);
  act.items.slice().reverse().forEach(i => console.log(`   · ${i.message}`));
  server.closeAllConnections?.();
  server.close();
  server.db.close();
})();
