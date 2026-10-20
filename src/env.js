'use strict';
// Tiny .env loader (no dependency, works on Node 18). Reads ".env" and any "*.env" file in the project root.
// Accepted: KEY=value or KEY: value lines, a file containing only the raw key, or any text that contains a
// Google-style key (AIza...). UTF-8 and UTF-16 files (Windows editors and PowerShell) both work.
// Existing environment variables always win. A key is never printed or returned by inspect().
const fs = require('node:fs');
const path = require('node:path');

const ALIAS = { GEMENI_API_KEY: 'GEMINI_API_KEY' }; // common misspelling
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{30,}/;
const NAMED_KEY = /^(?:export\s+)?(?:GEM[IE]NI[_ -]?API[_ -]?KEY|API[_ -]?KEY|KEY)\s*[=:\s]\s*["']?(\S{20,}?)["']?$/i;

function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'UTF-16 LE' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))); b.swap16();
    return { text: b.toString('utf16le'), encoding: 'UTF-16 BE' };
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return { text: buf.toString('utf16le'), encoding: 'UTF-16 LE' };
  return { text: buf.toString('utf8'), encoding: 'UTF-8' };
}

const clean = v => { v = v.trim(); return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1).trim() : v; };
const lineOf = l => /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(l);

function parse(text) {
  const out = {};
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length === 1 && !/\s/.test(lines[0]) && !lines[0].includes('=') && lines[0].length >= 20) { out.GEMINI_API_KEY = lines[0]; return out; } // just the key
  for (const l of lines) {
    const m = lineOf(l);
    if (!m) continue;
    const v = clean(m[2]);
    if (v) out[ALIAS[m[1]] || m[1]] = v;
  }
  if (!out.GEMINI_API_KEY) { // "GEMINI_API_KEY AIza...", "API key: AIza..." and similar layouts
    for (const l of lines) { const m = NAMED_KEY.exec(l); if (m) { out.GEMINI_API_KEY = clean(m[1]); break; } }
  }
  if (!out.GEMINI_API_KEY) { const g = GOOGLE_KEY.exec(String(text)); if (g) out.GEMINI_API_KEY = g[0]; } // key pasted with other text around it
  return out;
}

const envFiles = dir => { try { return fs.readdirSync(dir).filter(f => f === '.env' || f.endsWith('.env')).sort(); } catch { return []; } };

function load(dir = path.join(__dirname, '..'), env = process.env) {
  const loaded = [];
  for (const f of envFiles(dir)) {
    try {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile() || fs.statSync(full).size > 10_000) continue;
      for (const [k, v] of Object.entries(parse(decode(fs.readFileSync(full)).text))) if (env[k] === undefined) env[k] = v;
      loaded.push(f);
    } catch { /* unreadable file: skip */ }
  }
  return loaded; // file names only
}

// Describes what is in each env file without revealing any value (for `npm run llm:check`).
function inspectFiles(dir = path.join(__dirname, '..')) {
  return envFiles(dir).map(file => {
    const buf = fs.readFileSync(path.join(dir, file));
    const { text, encoding } = decode(buf);
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const names = lines.map(lineOf).filter(Boolean).map(m => `${m[1]}${clean(m[2]) ? '' : ' (empty)'}`);
    const parsed = parse(text);
    // structure only: letters become a/A, digits 9, punctuation stays. Safe to share, the key itself is not recoverable.
    const shape = lines.slice(0, 3).map(l => l.slice(0, 80).replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A').replace(/[0-9]/g, '9'));
    return { file, shape, startsLikeGoogleKey: /AIza/.test(text), bytes: buf.length, encoding, lines: lines.length, names, keyDetected: !!parsed.GEMINI_API_KEY, keyLength: parsed.GEMINI_API_KEY ? parsed.GEMINI_API_KEY.length : 0 };
  });
}

module.exports = { parse, load, inspectFiles, decode };
