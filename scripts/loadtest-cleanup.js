'use strict';

// Cleanup harness: deletes every file uploaded by the load-test runs using the
// public deletefiles API (which removes the Discord message + metadata row).
// Usage: node catbox-cleanup.js [labelPrefix]
// Default prefixes: load20, base5, fixed20, small20, scale40, scale80, scale150.

const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.env.CATBOX_BASE || 'https://api.mew-pocket.de5.net';
const LABELS = (process.argv[2] ? [process.argv[2]] : ['load20', 'base5', 'fixed20', 'small20', 'scale40', 'scale80', 'scale150']);

async function deleteFiles(userhash, names) {
  const f = new FormData();
  f.append('reqtype', 'deletefiles');
  f.append('userhash', userhash || '');
  for (const n of names) f.append('files', n);
  const res = await fetch(`${BASE}/user/api.php`, { method: 'POST', body: f, signal: AbortSignal.timeout(120000) });
  return { status: res.status, body: (await res.text()).trim().slice(0, 200) };
}

(async () => {
  const files = fs.readdirSync(os.tmpdir())
    .filter(name => name.endsWith('-result.json') && LABELS.some(p => name.startsWith(p + '-')))
    .sort();
  console.log(`found ${files.length} load-test result files`);
  let totalDeleted = 0;
  let totalFailed = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), file), 'utf8'));
    const byOwner = new Map();
    for (const r of (data.results || [])) {
      if (!r.name) continue;
      const account = (data.accounts || []).find(a => a.i === r.i);
      const key = account?.userhash || '';
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push(r.name);
    }
    let ok = 0, bad = 0;
    for (const [userhash, names] of byOwner) {
      try {
        const result = await deleteFiles(userhash, names);
        if (result.status === 200) ok += names.length;
        else { bad += names.length; console.log(`  delete failed hash=${!!userhash} status=${result.status} body=${result.body}`); }
      } catch (err) {
        bad += names.length;
        console.log(`  delete error hash=${!!userhash} ${err.message}`);
      }
    }
    totalDeleted += ok; totalFailed += bad;
    console.log(`${file}: deleted=${ok} failed=${bad}`);
  }
  console.log(`TOTAL deleted=${totalDeleted} failed=${totalFailed}`);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
