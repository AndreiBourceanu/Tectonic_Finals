'use strict';
// Run once with your key:  npm run llm:check
// 1) finds the key, 2) tests the network and key by listing models, 3) asks Gemini to describe a sample document.
// Never prints the key.
const env = require('../src/env');
const files = env.load();
for (const f of env.inspectFiles()) {
  console.log(`${f.file}: ${f.bytes} bytes, ${f.encoding}, ${f.lines} line(s), variable names: ${f.names.length ? f.names.join(', ') : '(none)'}, key detected: ${f.keyDetected ? `yes (${f.keyLength} characters)` : 'NO'}`);
  if (!f.keyDetected) console.log(`  shape of the first line(s), letters masked: ${f.shape.map(x => JSON.stringify(x)).join(' ')}`);
  if (f.bytes === 0) console.log('  -> the file is empty. Paste the key and save the file.');
}
const { createLlm } = require('../src/llm');
const key = process.env.GEMINI_API_KEY || '';
const base = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const llm = createLlm({ timeoutMs: 60_000 });
console.log(`env files read: ${files.length ? files.join(', ') : '(none)'}`);
console.log(`GEMINI_API_KEY: ${key ? `found (${key.length} characters)` : 'NOT FOUND'}`);
console.log(`model: ${llm.model}`);
console.log(`node: ${process.version}`);
if (!llm.enabled()) { console.log('LLM is disabled. Put GEMINI_API_KEY=your-key in a .env file in the project folder.'); process.exit(1); }

const scrub = s => String(s || '').split(key).join('[key]');
async function step1() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => ({}));
    console.log(`\n1) Network and key: HTTP ${res.status} in ${Date.now() - t0} ms`);
    if (!res.ok) { console.log(`   Google says: ${scrub(data.error?.message || '(no message)')}`); return false; }
    const names = (data.models || []).map(m => String(m.name).replace(/^models\//, ''));
    const ok = names.includes(llm.model);
    console.log(`   ${names.length} models available. Configured model "${llm.model}": ${ok ? 'available' : 'NOT in the list'}`);
    console.log(`   text models you could use: ${names.filter(n => /^gemini-.*(flash|pro)/.test(n) && !/image|tts|audio|live|embed|vision/.test(n)).slice(0, 12).join(', ') || '(none matched)'}`);
    if (!ok) console.log('   -> set GEMINI_MODEL=<one of the names above> in your env file (a line GEMINI_MODEL=name).');
    return true;
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'no answer within 20 s' : `${e.name}: ${scrub(e.message)}`;
    console.log(`\n1) Network and key: FAILED after ${Date.now() - t0} ms (${why}${e.cause ? `; cause: ${e.cause.code || scrub(e.cause.message)}` : ''})`);
    console.log('   Your computer could not reach generativelanguage.googleapis.com. Things to try:');
    console.log('   - switch network (phone hotspot): event or school Wi-Fi and VPNs often block or slow this');
    console.log('   - run with IPv4 first:  NODE_OPTIONS=--dns-result-order=ipv4first npm run llm:check');
    console.log('   - Node ignores HTTPS_PROXY settings, so a required corporate proxy will block it');
    return false;
  }
}

(async () => {
  const reachable = await step1();
  if (!reachable) { process.exitCode = 1; return; }
  const t0 = Date.now();
  const r = await llm.analyzeDocument({
    title: 'Holiday carry-over', fileName: 'holiday.md', types: ['Policy', 'Wiki', 'Chat', 'Email', 'Contract', 'Document'],
    text: '# Holiday carry-over\nUnused holiday days can be carried over until 31 March. After that date they expire unless the manager approves an extension.'
  });
  console.log(`\n2) Document analysis: ${r.ok ? 'OK' : 'FAILED'} in ${Date.now() - t0} ms`);
  if (r.ok) console.log(JSON.stringify(r.ai, null, 2));
  else { console.log(`   ${r.error}: ${r.detail}`); process.exitCode = 1; }
})();
