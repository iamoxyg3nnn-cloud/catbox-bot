'use strict';

// Live verification of the multi-file batch queue. Uploads N files through the
// same resumable chunk API the browser uses, with a bounded number in flight.
// Usage: node scripts/loadtest-batch.js [count] [bytesPerFile]

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { UploadQueue } = require('../public/upload-queue');

const BASE = process.env.CATBOX_BASE || 'https://api.mew-pocket.de5.net';
const COUNT = parseInt(process.argv[2] || '100', 10);
const SIZE = parseInt(process.argv[3] || String(1024 * 1024), 10);
const CHUNK = 4 * 1024 * 1024;
const LABEL = `batch-${Date.now()}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFile(i) {
  const buf = Buffer.alloc(SIZE);
  buf.write(`${LABEL}-file-${i}-`);
  for (let p = 16; p + 4 <= SIZE; p += 4) buf.writeUInt32LE((Math.imul(i + 1, 1664525) + p) >>> 0, p);
  return { name: `${LABEL}-${String(i).padStart(3, '0')}.bin`, size: SIZE, bytes: buf };
}

async function chunkedUpload(file, { signal, onProgress }) {
  const init = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalName: file.name, mime: 'application/octet-stream', size: file.size }),
    signal: AbortSignal.timeout(15000),
  });
  if (!init.ok) throw new Error(`init ${init.status}: ${(await init.text()).slice(0, 100)}`);
  const session = await init.json();
  let received = 0;
  while (received < session.size) {
    const probe = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
      headers: { 'X-Upload-Token': session.token }, signal: AbortSignal.timeout(15000),
    });
    if (!probe.ok) throw new Error('session expired');
    received = (await probe.json()).received;
    if (received >= session.size) break;
    const end = Math.min(received + CHUNK, session.size);
    const body = file.bytes.subarray(received, end);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Token': session.token,
            'X-Upload-Offset': String(received),
          },
          body,
          signal: AbortSignal.timeout(60000),
        });
        if (res.status === 409) { received = (await res.json()).received; break; }
        if (!res.ok) throw new Error(`chunk ${res.status}: ${(await res.text()).slice(0, 100)}`);
        received = (await res.json()).received;
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await sleep(400 * 2 ** attempt);
      }
    }
    onProgress?.(received, session.size);
  }
  const done = await fetch(`${BASE}/api/uploads/${session.uploadId}/complete`, {
    method: 'POST', headers: { 'X-Upload-Token': session.token }, signal: AbortSignal.timeout(15000),
  });
  if (done.status !== 202) throw new Error(`complete ${done.status}: ${(await done.text()).slice(0, 100)}`);
  const job = await done.json();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(700);
    const status = await fetch(`${BASE}${job.status_url}`, { signal: AbortSignal.timeout(15000) });
    if (!status.ok) continue;
    const j = await status.json();
    if (j.status === 'ready' && j.url) return { url: j.url, name: j.url.split('/').pop() };
    if (j.status === 'failed') throw new Error(j.error || 'job failed');
  }
  throw new Error('job timed out');
}

(async () => {
  console.log(`RUN=${LABEL} files=${COUNT} size=${SIZE} concurrency=5 base=${BASE}`);
  const files = Array.from({ length: COUNT }, (_, i) => makeFile(i));
  const queue = new UploadQueue({
    concurrency: 5,
    retries: 2,
    uploader: async (file, ctx) => (await chunkedUpload(file, ctx)).url,
    onUpdate: (stats) => {
      if (stats.uploading || stats.processing || stats.done) {
        process.stdout.write(`\r  done=${stats.done} uploading=${stats.uploading} processing=${stats.processing} failed=${stats.failed} pct=${stats.percent}%   `);
      }
    },
  });
  queue.add(files);
  const t0 = Date.now();
  const stats = await queue.run();
  process.stdout.write('\n');
  const ok = queue.items.filter(i => i.status === 'done');
  const bad = queue.items.filter(i => i.status === 'failed');
  console.log(`completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify({ ...stats, seconds: +((Date.now() - t0) / 1000).toFixed(1) }, null, 2));
  for (const item of bad.slice(0, 10)) console.log(`  FAIL ${item.label}: ${item.error}`);
  fs.writeFileSync(path.join(os.tmpdir(), `${LABEL}-result.json`), JSON.stringify({
    stats, items: queue.items.map(i => ({ label: i.label, status: i.status, url: i.url, error: i.error })),
  }, null, 2));
  console.log(`result written to ${path.join(os.tmpdir(), `${LABEL}-result.json`)}`);
  process.exitCode = bad.length ? 1 : 0;
})().catch(err => { console.error('FATAL', err); process.exit(1); });
