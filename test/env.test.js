'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse, load } = require('../src/env');

test('parses KEY=value, quotes, comments and the GEMENI misspelling', () => {
  assert.deepEqual(parse('# comment\nGEMENI_API_KEY="abc123"\nGEMINI_MODEL = m1\nexport X=\'y\'\n'), { GEMINI_API_KEY: 'abc123', GEMINI_MODEL: 'm1', X: 'y' });
  assert.deepEqual(parse('GEMINI_API_KEY=\r\n'), {});          // empty value ignored
});

test('a file that contains only the raw key is accepted', () => {
  assert.deepEqual(parse('﻿AIzaSyA1234567890abcdefghijklmnopqrstu\n'), { GEMINI_API_KEY: 'AIzaSyA1234567890abcdefghijklmnopqrstu' });
  assert.deepEqual(parse('hello world'), {});
});

test('load reads .env and *.env files, never overrides existing variables, returns only file names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-env-'));
  fs.writeFileSync(path.join(dir, 'GEMENI_API_KEY.env'), 'AIzaSyA1234567890abcdefghijklmnopqrstu');
  fs.writeFileSync(path.join(dir, '.env'), 'OTHER=1\nKEEP=fromfile');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'GEMINI_API_KEY=nope');
  const env = { KEEP: 'fromshell' };
  const files = load(dir, env);
  assert.deepEqual(files, ['.env', 'GEMENI_API_KEY.env']);
  assert.equal(env.GEMINI_API_KEY, 'AIzaSyA1234567890abcdefghijklmnopqrstu');
  assert.equal(env.OTHER, '1');
  assert.equal(env.KEEP, 'fromshell');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tolerates UTF-16 files, KEY: value lines, and a key pasted among other text', () => {
  const { decode } = require('../src/env');
  const key = 'AIzaSyA1234567890abcdefghijklmnopqrstu';
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`GEMINI_API_KEY=${key}\r\n`, 'utf16le')]);
  assert.equal(parse(decode(utf16le).text).GEMINI_API_KEY, key);
  assert.equal(decode(utf16le).encoding, 'UTF-16 LE');
  const be = Buffer.from(`GEMINI_API_KEY=${key}`, 'utf16le'); be.swap16();
  assert.equal(parse(decode(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text).GEMINI_API_KEY, key);
  assert.equal(parse(`GEMINI_API_KEY: ${key}`).GEMINI_API_KEY, key);
  assert.equal(parse(`my gemini key is ${key} (do not share)`).GEMINI_API_KEY, key);
  assert.equal(parse(`# key\n${key}\n`).GEMINI_API_KEY, key);
});

test('inspectFiles describes a file without revealing the key', () => {
  const { inspectFiles } = require('../src/env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-insp-'));
  const key = 'AIzaSyA1234567890abcdefghijklmnopqrstu';
  fs.writeFileSync(path.join(dir, 'GEMINI_API_KEY.env'), `GEMINI_API_KEY=${key}\nGEMINI_MODEL=\n`);
  fs.writeFileSync(path.join(dir, 'empty.env'), '');
  const r = inspectFiles(dir);
  assert.equal(r.length, 2);
  const f = r.find(x => x.file === 'GEMINI_API_KEY.env');
  assert.equal(f.keyDetected, true);
  assert.equal(f.keyLength, key.length);
  assert.deepEqual(f.names, ['GEMINI_API_KEY', 'GEMINI_MODEL (empty)']);
  assert.ok(!JSON.stringify(r).includes(key));
  assert.equal(r.find(x => x.file === 'empty.env').bytes, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts "NAME value" and other layouts, and a raw key with unusual characters', () => {
  const key = 'AIzaSyA1234567890abcdefghijklmnopqrstu';
  assert.equal(parse(`GEMINI_API_KEY ${key}`).GEMINI_API_KEY, key);
  assert.equal(parse(`Gemini API key: "${key}"`).GEMINI_API_KEY, key);
  assert.equal(parse(`API_KEY=${key}`).API_KEY, key);               // normal KEY=value still parsed as before
  assert.equal(parse('AQ.Ab8RN6Jabcdefghijklmnopqrstuvwxyz0123456789').GEMINI_API_KEY, 'AQ.Ab8RN6Jabcdefghijklmnopqrstuvwxyz0123456789');
  assert.deepEqual(parse('two words here'), {});
  assert.deepEqual(parse('short'), {});
});

test('inspectFiles shape masks letters and digits', () => {
  const { inspectFiles } = require('../src/env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-shape-'));
  fs.writeFileSync(path.join(dir, 'k.env'), 'GEMINI_API_KEY AIzaSyA1234567890abcdefghijklmnopqrstu');
  const f = inspectFiles(dir)[0];
  assert.equal(f.keyDetected, true);
  assert.equal(f.startsLikeGoogleKey, true);
  assert.match(f.shape[0], /^AAAAAA_AAA_AAA AAaaAaA9+a+$/);
  assert.ok(!f.shape[0].includes('abcdef') && !f.shape[0].includes('1234') && !f.shape[0].includes('Sy'));
  fs.rmSync(dir, { recursive: true, force: true });
});
