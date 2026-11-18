'use strict';

// Synthetic load test for the async upload queue — no Discord tokens needed.
// Starts the API with the mock transport (or targets an already-running one)
// and pushes N small uploads with X-Catbox-Async: 1, then polls every job to
// completion and reports throughput + failures.
//
// Usage:
//   API_BASE=http://localhost:3000 COUNT=1000 CONCURRENCY=50 node scripts/loadgen.js
//
// This exercises intake, the job runner, metadata writes and status polling.
// It does NOT exercise Discord itself — run live verification separately.

const BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const COUNT = Math.max(1, parseInt(process.env.COUNT || '1000', 10));
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '50', 10));
const TIMEOUT_MS = 5 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function submit(index) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([`load-test-${index}-${'x'.repeat(512)}`], { type: 'text/plain' }), `load-${index}.txt`);
  const res = await fetch(`${BASE}/user/api.php`, {
    method: 'POST', body: form, headers: { 'X-Catbox-Async': '1' },
  });
  if (res.status !== 202) throw new Error(`submit ${index}: HTTP ${res.status}`);
  return res.json();
}

async function waitForJob(job) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}${job.status_url}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`status ${job.job_id}: HTTP ${res.status}`);
    const state = await res.json();
    if (state.status === 'ready') return state;
    if (state.status === 'failed') throw new Error(`job ${job.job_id}: ${state.error}`);
    await sleep(100);
  }
  throw new Error(`job ${job.job_id}: timed out`);
}

async function main() {
  console.log(`Load test: ${COUNT} uploads, concurrency ${CONCURRENCY}, target ${BASE}`);
  const started = Date.now();
  const jobs = [];
  let next = 0;
  const submitters = Array.from({ length: Math.min(CONCURRENCY, COUNT) }, async () => {
    while (next < COUNT) {
      const index = next++;
      try { jobs.push(await submit(index)); } catch (err) { console.error(err.message); }
    }
  });
  await Promise.all(submitters);
  console.log(`Submitted ${jobs.length}/${COUNT} in ${Date.now() - started}ms`);

  const ready = [];
  const failed = [];
  let cursor = 0;
  const pollers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try { ready.push(await waitForJob(job)); } catch (err) { failed.push(err.message); }
    }
  });
  await Promise.all(pollers);

  const elapsed = Date.now() - started;
  const metrics = await fetch(`${BASE}/api/metrics`).then(r => r.json()).catch(() => ({}));
  console.log(JSON.stringify({
    submitted: jobs.length, ready: ready.length, failed: failed.length,
    elapsedMs: elapsed, uploadsPerSecond: +(jobs.length / (elapsed / 1000)).toFixed(2),
    queue: metrics.jobs || null, journal: metrics.journal || null,
  }, null, 2));
  if (failed.length) {
    console.error('First failures:', failed.slice(0, 10));
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
