'use strict';

// Load test harness for the Catbox hub-and-spoke fleet.
// Usage: node scripts/loadtest-concurrent.js <users> <sizeBytes> [label]
// Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env in cwd.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const BASE = process.env.CATBOX_BASE || 'https://api.mew-pocket.de5.net';
const USERS = parseInt(process.argv[2] || '20', 10);
const SIZE = parseInt(process.argv[3] || String(20 * 1024 * 1024), 10);
const LABEL = process.argv[4] || 'load';
const RUN = `${LABEL}-${Date.now()}`;

function readEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// One shared payload blob is reused by every upload. Each request still gets a
// unique server-generated name and a distinct userhash, so metadata checks work,
// but memory stays flat (~2x file size) even at 150+ concurrent uploads.
function makeSharedBlob() {
  const buf = Buffer.alloc(SIZE);
  const header = Buffer.from(`${RUN}:shared:`);
  header.copy(buf, 0);
  let seed = crypto.createHash('sha256').update(header).digest().readUInt32LE(0);
  for (let i = header.length; i + 4 <= SIZE; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    buf.writeUInt32LE(seed, i);
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

function cookieValue(cookies, name) {
  for (const c of cookies) {
    const first = c.split(';')[0];
    if (first.startsWith(name + '=')) return decodeURIComponent(first.slice(name.length + 1));
  }
  return null;
}

async function register(i) {
  const username = `L${Date.now().toString(36)}u${String(i).padStart(3, '0')}`.slice(0, 25);
  const password = `Load_${crypto.randomBytes(8).toString('hex')}!`;
  const body = new URLSearchParams({ username, email: `${username}@example.com`, password });
  const t0 = performance.now();
  const res = await fetch(`${BASE}/user/doregister.php`, {
    method: 'POST', body, signal: AbortSignal.timeout(60000),
  });
  const userhash = cookieValue(res.headers.getSetCookie?.() || [], 'userhash');
  return { i, username, password, userhash, status: res.status, ms: performance.now() - t0 };
}

async function upload(account, blob, tag) {
  const f = new FormData();
  f.append('reqtype', 'fileupload');
  f.append('userhash', account.userhash || '');
  f.append('fileToUpload', blob, `load-${tag}.bin`);
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/user/api.php`, {
      method: 'POST', body: f, signal: AbortSignal.timeout(600000),
    });
    const text = (await res.text()).trim();
    return {
      i: account.i, status: res.status, ms: performance.now() - t0,
      name: /^https?:\/\//.test(text) ? text.split('/').pop() : null,
      body: /^https?:\/\//.test(text) ? '' : text.slice(0, 200),
    };
  } catch (err) {
    return { i: account.i, status: 'ERR', ms: performance.now() - t0, name: null, body: err.message };
  }
}

async function supabase(env, table, query) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function stats(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 'n/a';
  const pct = p => nums[Math.min(nums.length - 1, Math.floor(nums.length * p))];
  return `min=${nums[0].toFixed(0)}ms p50=${pct(0.5).toFixed(0)}ms p95=${pct(0.95).toFixed(0)}ms max=${nums.at(-1).toFixed(0)}ms`;
}

(async () => {
  const env = readEnv();
  const blob = makeSharedBlob();
  console.log(`RUN=${RUN} users=${USERS} size=${SIZE} (${(SIZE / 1048576).toFixed(1)} MiB) base=${BASE}`);

  console.log('\n[1/5] registering accounts...');
  const regStart = performance.now();
  const accounts = [];
  for (let i = 1; i <= USERS; i++) {
    const r = await register(i);
    accounts.push(r);
    if (r.status !== 201 || !r.userhash) console.log(`  REG FAIL #${i}: status=${r.status} hash=${!!r.userhash}`);
  }
  console.log(`  registered ${accounts.filter(a => a.status === 201 && a.userhash).length}/${USERS} in ${(performance.now() - regStart).toFixed(0)}ms`);

  let monitorTimer = null;
  const monitor = async () => {
    try {
      const r = await fetch(`${BASE}/api/nodes`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      const line = (j.nodes || []).map(n => `${n.id}:${n.status}/a${n.active}/s${n.stagedBytes || 0}`).join(' ');
      console.log(`  [monitor ${new Date().toISOString().slice(11, 19)}] ${line}`);
    } catch (e) { console.log(`  [monitor] ${e.message}`); }
  };

  console.log('\n[2/5] concurrent uploads...');
  await monitor();
  monitorTimer = setInterval(monitor, 5000);
  const upStart = performance.now();
  const results = await Promise.all(accounts.map((a, i) => upload(a, blob, i)));
  clearInterval(monitorTimer);
  await monitor();
  const upMs = performance.now() - upStart;

  const ok = results.filter(r => r.status === 200 && r.name);
  const bad = results.filter(r => !(r.status === 200 && r.name));
  console.log(`  completed ${results.length} in ${(upMs / 1000).toFixed(1)}s`);
  console.log(`  successful=${ok.length} failed=${bad.length}`);
  console.log(`  latency ${stats(results.map(r => r.ms))}`);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`  status counts: ${JSON.stringify(byStatus)}`);
  for (const r of bad.slice(0, 20)) console.log(`  FAIL #${r.i}: status=${r.status} ${r.body}`);

  console.log('\n[3/5] verifying metadata in Supabase...');
  const names = ok.map(r => r.name);
  let rows = [];
  if (names.length) {
    // Chunk to keep the URL under practical limits.
    for (let i = 0; i < names.length; i += 100) {
      const chunk = names.slice(i, i + 100);
      const inFilter = chunk.map(n => `"${n}"`).join(',');
      rows = rows.concat(await supabase(env, 'files', `select=name,bot_id,status,size,owner_hash&name=in.(${inFilter})`));
    }
  }
  const ready = rows.filter(r => r.status === 'ready');
  const bots = {};
  for (const r of rows) bots[r.bot_id] = (bots[r.bot_id] || 0) + 1;
  console.log(`  rows found=${rows.length} ready=${ready.length} expected=${ok.length}`);
  console.log(`  bot distribution: ${JSON.stringify(bots)}`);
  const sizes = rows.map(r => Number(r.size)).filter(Number.isFinite);
  if (sizes.length) console.log(`  stored sizes: min=${Math.min(...sizes)} max=${Math.max(...sizes)} expected=${SIZE}`);

  console.log('\n[4/5] summary');
  const summary = {
    run: RUN, users: USERS, size: SIZE,
    registered: accounts.filter(a => a.status === 201 && a.userhash).length,
    uploaded: ok.length, failed: bad.length,
    metadataReady: ready.length,
    distinctBots: Object.keys(bots).length,
    totalSeconds: +(upMs / 1000).toFixed(1),
  };
  console.log(JSON.stringify(summary, null, 2));

  fs.writeFileSync(path.join(os.tmpdir(), `${RUN}-result.json`),
    JSON.stringify({ summary, accounts, results, rows }, null, 2));
  console.log(`\nresult written to ${os.tmpdir()}\\${RUN}-result.json`);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
