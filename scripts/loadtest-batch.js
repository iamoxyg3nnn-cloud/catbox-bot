'use strict';

// Live verification of the multi-file batch queue. Uploads N files through the
// same resumable chunk API the browser uses, with a bounded number in flight.
// Fixture bytes are streamed from disk, so 100 × 20 MiB does not require 2 GiB
// of RAM. Usage: node scripts/loadtest-batch.js [count] [bytesPerFile]

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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), `${LABEL}-fixtures-`));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFile(i) {
  const name = `${LABEL}-${String(i).padStart(3, '0')}.bin`;
  const full = path.join(DIR, name);
  const handle = fs.openSync(full, 'w');
  try {
    const header = Buffer.alloc(32);
    header.write(`${LABEL}-file-${i}-`);
    fs.writeSync(handle, header);
    // Write deterministic filler in blocks instead of allocating the whole
    // fixture in memory. 1 MiB blocks keep the setup fast and bounded.
    const block = Buffer.alloc(Math.min(1024 * 1024, SIZE));
    for (let p = 0; p + 4 <= block.length; p += 4) {
      block.writeUInt32LE((Math.imul(i + 1, 1664525) + p) >>> 0, p);
    }
    let written = header.length;
    while (written < SIZE) {
      const take = Math.min(block.length, SIZE - written);
      fs.writeSync(handle, block, 0, take);
      written += take;
    }
  } finally {
    fs.closeSync(handle);
  }
  return { name, size: SIZE, path: full, bytes: null };
}

async function readChunk(file, start, end) {
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function httpError(step, response, body = '') {
  return new Error(`${step} ${response.status}: ${body.slice(0, 100)}`);
}

async function chunkedUpload(file, { signal, onProgress }) {
  const init = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalName: file.name, mime: 'application/octet-stream', size: file.size,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!init.ok) throw httpError('init', init, await init.text());
  const session = await init.json();
  if (session.url) return { url: session.url, name: session.url.split('/').pop() };
  let received = 0;
  while (received < session.size) {
    const end = Math.min(received + CHUNK, session.size);
    const body = await readChunk(file, received, end);
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
        if (!res.ok) throw httpError('chunk', res, await res.text());
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
  if (done.status !== 202) throw httpError('complete', done, await done.text());
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
    onUpdate: stats => {
      if (stats.uploading || stats.processing || stats.done) {
        process.stdout.write(`\r  done=${stats.done} uploading=${stats.uploading} processing=${stats.processing} failed=${stats.failed} pct=${stats.percent}%   `);
      }
    },
  });
  queue.add(files);
  const t0 = Date.now();
  const stats = await queue.run();
  process.stdout.write('\n');
  const bad = queue.items.filter(i => i.status === 'failed');
  console.log(`completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify({ ...stats, seconds: +((Date.now() - t0) / 1000).toFixed(1) }, null, 2));
  for (const item of bad.slice(0, 10)) console.log(`  FAIL ${item.label}: ${item.error}`);
  const resultPath = path.join(os.tmpdir(), `${LABEL}-result.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    stats, items: queue.items.map(i => ({ label: i.label, status: i.status, url: i.url, error: i.error })),
  }, null, 2));
  console.log(`result written to ${resultPath}`);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`fixtures removed from ${DIR}`);
  process.exitCode = bad.length ? 1 : 0;
})().catch(err => {
  console.error('FATAL', err);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
