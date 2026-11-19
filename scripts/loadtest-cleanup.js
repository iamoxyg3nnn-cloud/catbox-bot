'use strict';

// Cleanup harness for load-test artifacts:
//   1. delete files through the public deletefiles API, which removes both the
//      Discord message (durable bytes) and the metadata row;
//   2. delete the throwaway user rows through the Supabase service role.
// Usage: node scripts/loadtest-cleanup.js [labelPrefix]
// Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env in cwd.

const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.env.CATBOX_BASE || 'https://api.mew-pocket.de5.net';
const PREFIXES = process.argv[2]
  ? [process.argv[2]]
  : ['load20', 'base5', 'fixed20', 'small20', 'scale40', 'scale80', 'scale150', 'scale150b', 'scale150small', 'channelprobe'];

function readEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function deleteFiles(userhash, names) {
  const f = new FormData();
  f.append('reqtype', 'deletefiles');
  f.append('userhash', userhash || '');
  for (const n of names) f.append('files', n);
  const res = await fetch(`${BASE}/user/api.php`, { method: 'POST', body: f, signal: AbortSignal.timeout(120000) });
  return { status: res.status, body: (await res.text()).trim().slice(0, 200) };
}

async function deleteUsers(env, usernames) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY || !usernames.length) return 0;
  let deleted = 0;
  for (let i = 0; i < usernames.length; i += 100) {
    const chunk = usernames.slice(i, i + 100);
    const filter = chunk.map(u => `"${u}"`).join(',');
    const res = await fetch(`${url}/rest/v1/users?username=in.(${filter})`, {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) console.log(`  user delete failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    else deleted += chunk.length;
  }
  return deleted;
}

(async () => {
  const env = readEnv();
  const files = fs.readdirSync(os.tmpdir())
    .filter(name => name.endsWith('-result.json') && PREFIXES.some(p => name.startsWith(p + '-')))
    .sort();
  console.log(`found ${files.length} load-test result files`);
  let totalDeleted = 0, totalFailed = 0;
  const usernames = new Set();
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), file), 'utf8'));
    const byOwner = new Map();
    const accounts = new Map((data.accounts || []).map(a => [a.i, a]));
    for (const r of (data.results || [])) {
      const account = accounts.get(r.i);
      if (account?.username) usernames.add(account.username);
      if (!r.name) continue;
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
  const removedUsers = await deleteUsers(env, Array.from(usernames));
  console.log(`TOTAL files deleted=${totalDeleted} failed=${totalFailed}`);
  console.log(`TOTAL users deleted=${removedUsers} (candidates=${usernames.size})`);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
