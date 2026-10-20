'use strict';
// Who really knows this? Pure logic, no I/O.
// Expertise is not declared by anyone: it is learned from traces of everyday work
// (owning or editing a document, answering in chat, closing tickets, verifying a source...).
// Every trace fades with time (half-life of 6 months), so when someone changes topic or role
// their expertise fades out on its own and nobody has to update a skills matrix.
const { parseMonth } = require('./trust');

const HALF_LIFE = 6; // months
const WEIGHT = {
  owner: 3,          // currently accountable for a live document on the topic
  edit: 2,           // edited a document on the topic
  verified: 2,       // confirmed a source in one click
  chat_answer: 2,    // answered colleagues in a chat channel
  ticket: 2,         // resolved a support ticket about it
  expert_reply: 3,   // was asked as the expert and answered
  commit: 1,
  meeting: 1
};
const LABEL = {
  owner: n => `owns ${n} live source${n > 1 ? 's' : ''} on this`,
  edit: n => `edited sources on this ${n}×`,
  verified: n => `verified sources on this ${n}×`,
  chat_answer: n => `answered ${n} similar question${n > 1 ? 's' : ''} in chat`,
  ticket: n => `resolved ${n} ticket${n > 1 ? 's' : ''} on this`,
  expert_reply: n => `was asked as the expert ${n}×`,
  commit: n => `${n} related change${n > 1 ? 's' : ''}`,
  meeting: n => `ran ${n} meeting${n > 1 ? 's' : ''} on it`
};

// inverse of parseMonth (year * 12 + month, month 1..12)
const toMonth = n => `${Math.floor((n - 1) / 12)}-${String(((n - 1) % 12) + 1).padStart(2, '0')}`;
const decay = (months) => Math.pow(0.5, Math.max(0, months) / HALF_LIFE);

/**
 * @param signals [{person, kind, month:'YYYY-MM', detail?}]
 * @param people  [{name, role, active}]  role and active state (several rows per name are possible)
 * @param now     'YYYY-MM'
 * @param opts    { exclude: [names], limit }
 * @returns ranked [{name, role, score, lastSeen, why:[...]}], inactive people left out
 */
function rankExperts(signals, people, now, { exclude = [], limit = 3 } = {}) {
  const nowM = parseMonth(now);
  const byName = new Map();
  for (const s of signals) {
    if (!WEIGHT[s.kind] || exclude.includes(s.person)) continue;
    const e = byName.get(s.person) || { name: s.person, score: 0, last: -Infinity, kinds: {} };
    const m = parseMonth(s.month);
    e.score += WEIGHT[s.kind] * decay(nowM - m);
    e.last = Math.max(e.last, m);
    e.kinds[s.kind] = (e.kinds[s.kind] || 0) + 1;
    byName.set(s.person, e);
  }
  const roleOf = name => {
    const rows = people.filter(p => p.name === name);
    if (!rows.length) return { known: false, role: '', active: true };
    const live = rows.find(p => p.active);
    return { known: true, role: (live || rows[0]).role, active: !!live };
  };
  return [...byName.values()]
    .map(e => ({ ...e, ...roleOf(e.name) }))
    .filter(e => e.active && e.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(e => {
      const ago = nowM - e.last;
      const why = Object.entries(e.kinds)
        .sort((a, b) => WEIGHT[b[0]] * b[1] - WEIGHT[a[0]] * a[1])
        .slice(0, 2).map(([k, n]) => LABEL[k](n));
      why.push(ago <= 0 ? 'active this month' : `last active ${ago} month${ago > 1 ? 's' : ''} ago`);
      return { name: e.name, role: e.role, score: Math.round(e.score * 10) / 10, lastSeen: toMonth(e.last), why };
    });
}

module.exports = { rankExperts, WEIGHT, HALF_LIFE, decay, toMonth };
