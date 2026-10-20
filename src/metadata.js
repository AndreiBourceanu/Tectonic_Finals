'use strict';
// Placeholder metadata generation (no LLM yet). generate() is the single function an LLM call will replace.
const STOP = new Set(('the and for with that this from are was were been have has had not but you your our their its can will should must may per into than then also any all each about over under after before when what which who how why where there here they them his her she one two new use used using via etc').split(/\s+/));
const norm = t => String(t).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

const tokenize = text => (norm(text).match(/[a-z][a-z0-9]{2,}/g) || []).filter(w => !STOP.has(w));

function keywords(text, title = '', max = 8) {
  const counts = new Map();
  for (const w of tokenize(text)) counts.set(w, (counts.get(w) || 0) + 1);
  for (const w of tokenize(title)) counts.set(w, (counts.get(w) || 0) + 3);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([keyword, weight]) => ({ keyword, weight }));
}

function summary(text, max = 280) {
  const lines = String(text).replace(/\r/g, '').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
    .map(l => l.trim()).filter(l => l && !/^(#|\||[-*_]{3,}$)/.test(l))
    .map(l => l.replace(/^\[[^\]]*\]\s*/, '').replace(/^(\d+\.|[-*])\s+/, '').replace(/[*_`>]/g, '').trim()).filter(Boolean);
  const flat = lines.join(' ');
  let out = '';
  for (const s of flat.split(/(?<=[.!?])\s+/)) {
    if ((out + ' ' + s).trim().length > max) break;
    out = (out + ' ' + s).trim();
  }
  return out || flat.slice(0, max).trim();
}

const headingOf = text => { const m = /^#\s+(.+)$/m.exec(String(text)); return m ? m[1].trim().slice(0, 200) : null; };
const titleFromName = name => {
  const t = String(name).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Untitled';
};

const generate = (body, title) => ({ summary: summary(body), keywords: keywords(body, title) });

module.exports = { tokenize, keywords, summary, headingOf, titleFromName, generate };
