'use strict';

// Integration coverage for the batch/dedupe/caching/admission improvements.
// Runs its own server so the per-IP throttle can be configured tightly without
// disturbing the long-running api.test.js suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'catbox-improvements-'));
const PROJECT = path.join(__dirname, '..');
let server;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status === 410) return;
    } catch { /* not up yet */ }
    await wait(100);
  }
  throw new Error('server did not start');
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR, DISCORD_TRANSPORT: 'mock',
      NODE_UPLOAD_SECRET: 'test-secret', ADMIN_TOKEN: 'test-admin-token',
      UPLOAD_MAX_PER_MIN: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  await waitForServer();
});

test.after(async () => {
  if (server) {
    server.kill();
    for (let i = 0; i < 50; i++) {
      if (server.exitCode !== null || server.signalCode) break;
      await wait(100);
    }
  }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows WAL */ }
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function startSession(fields) {
  const res = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body);
}

async function sendChunks(session, contents) {
  let received = 0;
  while (received < session.size) {
    const end = Math.min(received + session.chunkSize, session.size);
    const res = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': session.token,
        'X-Upload-Offset': String(received),
      },
      body: contents.slice(received, end),
    });
    const putBody = await res.text();
    assert.equal(res.status, 200, putBody);
    received = JSON.parse(putBody).received;
  }
  const done = await fetch(`${BASE}/api/uploads/${session.uploadId}/complete`, {
    method: 'POST', headers: { 'X-Upload-Token': session.token },
  });
  const doneBody = await done.text();
  assert.equal(done.status, 202, doneBody);
  return JSON.parse(doneBody);
}

async function waitForJob(statusUrl) {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${BASE}${statusUrl}`);
    if (!res.ok) { await wait(50); continue; }
    const job = await res.json();
    if (job.status === 'ready' && job.url) return job;
    if (job.status === 'failed') throw new Error(job.error || 'job failed');
    await wait(50);
  }
  throw new Error('job did not become ready');
}

test('throttle responses advertise limits and Retry-After', async () => {
  const statuses = [];
  let last;
  for (let i = 0; i < 3; i++) {
    last = await fetch(`${BASE}/user/api.php`, {
      method: 'POST', body: new URLSearchParams({ reqtype: 'unknown' }),
    });
    statuses.push(last.status);
  }
  assert.deepEqual(statuses.slice(0, 2), [412, 412]);
  assert.equal(statuses[2], 429);
  assert.match(last.headers.get('retry-after') || '', /^\d+$/);
  assert.equal(last.headers.get('x-ratelimit-limit'), '2');
  assert.equal(last.headers.get('x-ratelimit-remaining'), '0');
  assert.ok(Number(last.headers.get('x-ratelimit-reset')) > 0);
});

test('public config exposes batch queue hints', async () => {
  const cfg = await fetch(`${BASE}/api/config`).then(res => res.json());
  assert.ok(Number(cfg.batchConcurrency) >= 1);
  assert.ok(Number(cfg.batchMaxConcurrency) >= cfg.batchConcurrency);
  assert.equal(typeof cfg.adaptiveBatches, 'boolean');
  assert.ok(Number(cfg.maxBatchFiles) >= 1);
});

test('immutable cache for permanent files, expiry-bounded for temporary ones', async () => {
  const permanent = await startSession({ originalName: 'cache.txt', mime: 'text/plain', size: 4, userhash: 'cache-owner' });
  const pJob = await sendChunks(permanent, Buffer.from('cache'));
  const pReady = await waitForJob(pJob.status_url);
  const pRes = await fetch(pReady.url);
  assert.equal(pRes.status, 200);
  assert.match(pRes.headers.get('cache-control') || '', /max-age=31536000/);
  assert.match(pRes.headers.get('cache-control') || '', /immutable/);

  const temporary = await startSession({ originalName: 'temp.txt', mime: 'text/plain', size: 4, time: '1h', userhash: 'cache-owner' });
  const tJob = await sendChunks(temporary, Buffer.from('temp!'));
  const tReady = await waitForJob(tJob.status_url);
  const tRes = await fetch(tReady.url);
  assert.equal(tRes.status, 200);
  const cache = tRes.headers.get('cache-control') || '';
  const maxAge = Number(/max-age=(\d+)/.exec(cache)?.[1]);
  assert.ok(maxAge > 0 && maxAge <= 3600, `unexpected temporary cache header: ${cache}`);
});

test('batch manifest creates many sessions behind one status URL', async () => {
  const res = await fetch(`${BASE}/api/uploads/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userhash: 'batch-owner',
      files: [
        { originalName: 'one.txt', mime: 'text/plain', size: 3 },
        { originalName: 'two.txt', mime: 'text/plain', size: 3 },
      ],
    }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  const batch = JSON.parse(body);
  assert.equal(batch.files.length, 2);
  assert.match(batch.statusUrl, /^\/api\/uploads\/batch\/[a-f0-9]+\?token=/);

  for (const [index, entry] of batch.files.entries()) {
    const put = await fetch(`${BASE}/api/uploads/${entry.uploadId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Token': entry.token,
        'X-Upload-Offset': '0',
      },
      body: Buffer.from(`b${index}b`),
    });
    assert.equal(put.status, 200, await put.text());
    await fetch(`${BASE}/api/uploads/${entry.uploadId}/complete`, {
      method: 'POST', headers: { 'X-Upload-Token': entry.token },
    });
  }

  let summary;
  for (let i = 0; i < 100; i++) {
    summary = await fetch(`${BASE}${batch.statusUrl}`).then(r => r.json());
    if (summary.complete) break;
    await wait(50);
  }
  assert.equal(summary.total, 2);
  assert.equal(summary.ready, 2);
  assert.equal(summary.urls.length, 2);
  assert.equal(summary.items.length, 2);
});

test('known content hash skips the second upload', async () => {
  const content = 'deduplicate these exact bytes';
  const hash = sha256(content);
  const first = await startSession({
    originalName: 'dedupe.txt', mime: 'text/plain', size: Buffer.byteLength(content),
    userhash: 'dedupe-owner', sha256: hash,
  });
  assert.equal(first.url, undefined);
  const job = await sendChunks(first, Buffer.from(content));
  const ready = await waitForJob(job.status_url);

  const second = await startSession({
    originalName: 'dedupe-again.txt', mime: 'text/plain', size: Buffer.byteLength(content),
    userhash: 'dedupe-owner', sha256: hash,
  });
  assert.equal(second.url, ready.url);

  const otherOwner = await startSession({
    originalName: 'not-yours.txt', mime: 'text/plain', size: Buffer.byteLength(content),
    userhash: 'someone-else', sha256: hash,
  });
  assert.equal(otherOwner.url, undefined);
});

test('dedupe checks declared size and blocked types keep their 403 status', async () => {
  const content = 'size guard';
  const hash = sha256(content);
  const first = await startSession({
    originalName: 'guard.txt', mime: 'text/plain', size: Buffer.byteLength(content),
    userhash: 'guard-owner', sha256: hash,
  });
  assert.equal(first.url, undefined);
  const guardJob = await sendChunks(first, Buffer.from(content));
  const ready = await waitForJob(guardJob.status_url);

  const wrongSize = await startSession({
    originalName: 'guard-wrong.txt', mime: 'text/plain', size: Buffer.byteLength(content) + 1,
    userhash: 'guard-owner', sha256: hash,
  });
  assert.equal(wrongSize.url, undefined);

  const block = await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalName: 'unsafe.exe', mime: 'application/octet-stream', size: 4 }),
  });
  assert.equal(block.status, 403);
  assert.equal(ready.url.includes('/files/'), true);
});

test('admin jobs endpoint aggregates queue health', async () => {
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test-admin-token' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()
    .find(value => value.startsWith('__Host-catadmin=')).split(';')[0];
  const status = await fetch(`${BASE}/api/admin/status`, { headers: { cookie } }).then(r => r.json());
  const res = await fetch(`${BASE}/api/admin/jobs`, {
    headers: { cookie, 'X-CSRF-Token': status.csrf },
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const data = JSON.parse(body);
  assert.equal(data.ok, true);
  assert.ok(data.stats.total >= 4);
  assert.ok(Array.isArray(data.recent));
  assert.ok(Array.isArray(data.batches));
});
