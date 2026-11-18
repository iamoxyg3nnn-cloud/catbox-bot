'use strict';

// Background upload job runner.
//
// The browser can opt into async uploads with `X-Catbox-Async: 1`. The request
// body is staged locally (on the node this would be D:\catbox_staging), a job
// row is written, and this runner performs the Discord upload out of band.
// Staged bytes are removed by commitUpload() only after Discord has confirmed.
//
// Every DB call is awaited so the runner works with both the synchronous
// SQLite adapter and the asynchronous Supabase/PostgREST adapter.

const fs = require('fs');
const crypto = require('crypto');
const db = require('./dbAdapter');
const { config } = require('./config');

const STALE_AFTER_MS = 5 * 60 * 1000;
const CONCURRENCY = Math.max(1, parseInt(process.env.UPLOAD_JOB_CONCURRENCY || '4', 10));

const JOURNAL_SWEEP_MS = 60 * 1000;
const JOURNAL_AFTER_MS = 60 * 1000;

let started = false;
let active = 0;
let pumping = false;
let pollTimer = null;
let journalTimer = null;

async function enqueue(details) {
  const jobId = crypto.randomBytes(12).toString('hex');
  await db.createJob({
    jobId,
    nodeId: process.env.NODE_ID || 'local',
    stagedPath: details.stagedPath,
    ownerHash: details.ownerHash || null,
    originalName: details.originalName,
    mime: details.mime,
    size: details.size,
    expiresAt: details.expiresAt || null,
  });
  kick();
  return jobId;
}

function publicJob(row, req) {
  if (!row) return null;
  const origin = config.baseUrl || (req ? `${req.protocol}://${req.get('host')}` : '');
  const job = {
    job_id: row.job_id,
    status: row.status,
    attempts: row.attempts,
    created_at: row.created_at,
  };
  if (row.status === 'ready' && row.file_name) {
    job.status = 'ready';
    job.url = `${origin.replace(/\/$/, '')}/files/${row.file_name}`;
  }
  if (row.status === 'failed') job.error = row.last_error || 'Upload failed.';
  job.status_url = `/api/jobs/${row.job_id}`;
  return job;
}

async function processJob(job) {
  try {
    if (!fs.existsSync(job.staged_path)) {
      throw new Error('Staged upload is missing; it may have been cleaned up.');
    }
    // Lazy require avoids a cycle: api.js requires jobs.js only when accepting
    // an async request, by which time this module is fully loaded.
    const { commitUpload } = require('./api');
    const name = await commitUpload(
      { ownerHash: job.owner_hash },
      job.staged_path,
      job.original_name,
      job.mime,
      job.size,
      job.expires_at
    );
    const file = await db.getFile(name);
    await db.finishJob(job.job_id, {
      name,
      botId: file && file.bot_id,
      channelId: file && file.channel_id,
    });
  } catch (err) {
    console.error(`job ${job.job_id} failed:`, err.message);
    const updated = await db.finishJob(job.job_id, { error: err.message });
    if (updated && updated.status === 'failed') {
      await fs.promises.unlink(job.staged_path).catch(() => {});
    }
  } finally {
    active -= 1;
  }
}

function kick() {
  if (!started || pollTimer) return;
  pollTimer = setInterval(() => pump().catch(err => {
    console.error('job pump failed:', err);
  }), 250);
  pollTimer.unref();
  pump().catch(err => console.error('job pump failed:', err));
}

// Claim one job at a time and start work until the concurrency cap is reached.
// The `pumping` guard prevents a slow async claim from overlapping the timer.
async function pump() {
  if (!started || pumping) return;
  pumping = true;
  try {
    while (active < CONCURRENCY) {
      const job = await db.claimJob();
      if (!job) break;
      active += 1;
      processJob(job).catch(err => {
        active -= 1;
        console.error('unexpected job runner error:', err);
      });
    }
  } finally {
    pumping = false;
  }
}

// Replay journaled metadata for writes that reached Discord but failed to be
// recorded. recordFile() is idempotent, so replay is safe.
async function reconcileJournal({ force = false } = {}) {
  let rows;
  try {
    rows = await db.unresolvedJournal(force ? 0 : JOURNAL_AFTER_MS);
  } catch (err) {
    console.error('journal sweep failed to read:', err.message);
    return;
  }
  for (const row of rows) {
    if (!row.metadata) continue; // nothing to replay; needs manual Discord cleanup
    try {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      await db.recordFile(meta);
      await db.resolveJournal(row.id);
    } catch (err) {
      console.error(`journal ${row.id} replay failed:`, err.message);
    }
  }
}

async function start() {
  if (started) return;
  started = true;
  // Recover jobs abandoned by a previous process.
  const stale = await db.staleJobs(STALE_AFTER_MS);
  for (const job of stale) await db.requeueJob(job.job_id);
  kick();
  reconcileJournal().catch(err => console.error('initial journal sweep failed:', err));
  journalTimer = setInterval(() => {
    reconcileJournal().catch(err => console.error('journal sweep failed:', err));
  }, JOURNAL_SWEEP_MS);
  journalTimer.unref();
}

function stop() {
  started = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (journalTimer) clearInterval(journalTimer);
  journalTimer = null;
}

module.exports = { enqueue, publicJob, start, stop, reconcileJournal };
