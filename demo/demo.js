'use strict';
// Scripted 3-minute demo: good case, conflict case, gap case. Starts its own server.
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
  server.closeAllConnections?.();
  server.close();
  server.db.close();
})();
