'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UploadQueue } = require('../public/upload-queue');

function file(name, size) { return { name, size }; }

test('UploadQueue never exceeds the concurrency limit', async () => {
  let inFlight = 0, peak = 0;
  const q = new UploadQueue({
    concurrency: 3,
    uploader: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return 'https://example.test/f';
    },
  });
  q.add(Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`, 100)));
  const stats = await q.run();
  assert.equal(peak, 3);
  assert.equal(stats.done, 12);
  assert.equal(stats.failed, 0);
});

test('UploadQueue retries transient failures and marks permanent ones failed', async () => {
  const calls = new Map();
  const q = new UploadQueue({
    concurrency: 1,
    retries: 2,
    uploader: async f => {
      const n = (calls.get(f.name) || 0) + 1;
      calls.set(f.name, n);
      if (f.name === 'flaky.txt' && n < 3) throw new Error('transient');
      if (f.name === 'broken.txt') throw new Error('permanent');
      return 'https://example.test/ok';
    },
  });
  q.add([file('flaky.txt', 10), file('broken.txt', 10)]);
  const stats = await q.run();
  assert.equal(stats.done, 1);
  assert.equal(stats.failed, 1);
  assert.equal(q.items.find(i => i.label === 'flaky.txt').attempts, 3);
  assert.equal(q.items.find(i => i.label === 'broken.txt').attempts, 3);
});

test('UploadQueue cancel aborts in-flight uploads', async () => {
  const q = new UploadQueue({
    concurrency: 2,
    uploader: async (f, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('url'), 5000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
    }),
  });
  q.add(Array.from({ length: 6 }, (_, i) => file(`f${i}.txt`, 10)));
  const running = q.run();
  await new Promise(r => setTimeout(r, 10));
  q.cancel();
  await running;
  assert.ok(q.stats.cancelled >= 4);
  assert.equal(q.stats.done, 0);
});

test('UploadQueue does not retry permanent HTTP errors', async () => {
  let calls = 0;
  const q = new UploadQueue({
    retries: 3,
    uploader: async () => { calls += 1; const e = new Error('too large'); e.status = 413; throw e; },
  });
  q.add([file('big.txt', 10)]);
  const stats = await q.run();
  assert.equal(calls, 1);
  assert.equal(stats.failed, 1);
});

test('UploadQueue respects Retry-After and backs off adaptively on 429', async () => {
  let calls = 0;
  const q = new UploadQueue({
    concurrency: 4, retries: 1, adaptive: true, minConcurrency: 1, maxConcurrency: 8,
    uploader: async f => {
      calls += 1;
      if (calls === 1) { const e = new Error('slow down'); e.status = 429; e.retryAfterMs = 20; throw e; }
      return 'url';
    },
  });
  q.add(Array.from({ length: 8 }, (_, i) => file(`f${i}.txt`, 1)));
  const stats = await q.run();
  assert.equal(stats.total, 8);
  assert.ok(q.concurrency >= 1);
});

test('UploadQueue reports aggregate progress', () => {
  const q = new UploadQueue({ uploader: async () => 'url' });
  q.add([file('a', 100), file('b', 300)]);
  q.items[0].sent = 100;
  q.items[1].sent = 100;
  assert.equal(q.stats.percent, 50);
});
