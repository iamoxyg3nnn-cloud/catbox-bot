'use strict';

// Short, resumable browser uploads.
//
// The legacy /user/api.php endpoint receives the whole multipart body in one
// request. On a slow link that request can outlive Cloudflare's 125 s read
// timeout, and a dropped connection forces the user to start over. This
// module keeps each HTTP request small (4 MiB), verifies a signed capability
// token on every request, and lets the client resume from the byte count the
// server reports. No database table is needed: the signed token carries the
// upload's identity, and staged bytes remain transient local scratch space.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { config, publicUrl } = require('./config');
const db = require('./dbAdapter');
const { sanitizeOriginalName, isBlockedUpload } = require('./util');

const CHUNK_SIZE = 4 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;

// Never sign capabilities with an empty key. Production always supplies
// NODE_UPLOAD_SECRET; local runs get an ephemeral key so tokens cannot be
// forged by anyone who knows the source.
const SESSION_SECRET = process.env.NODE_UPLOAD_SECRET
  ? Buffer.from(process.env.NODE_UPLOAD_SECRET)
  : crypto.randomBytes(32);

function stagePath(id) {
  return path.join(config.tmpDir, `session_${id}`);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET)
    .update(body).digest('base64url');
  return `${body}.${mac}`;
}

// HMAC verification is shared by single-file sessions and batch status tokens;
// only the payload shape differs.
function unpack(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET)
    .update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function verify(token) {
  const payload = unpack(token);
  if (!payload) return null;
  if (!/^[a-f0-9]{32}$/.test(payload.id)) return null;
  if (!Number.isFinite(payload.s) || payload.s <= 0) return null;
  return payload;
}

function verifyBatch(token) {
  const payload = unpack(token);
  if (!payload || !/^[a-zA-Z0-9_-]{1,64}$/.test(String(payload.b || ''))) return null;
  if (!Array.isArray(payload.f) || payload.f.length > config.batching.maxFiles) return null;
  return payload;
}

// Only hashes computed by the server from bytes it actually stored are eligible
// for dedupe. The client hash is just a lookup key; a wrong hash uploads as
// normal, and the owner scope keeps other accounts' files private.
async function dedupeUrl(sha256, ownerHash, req, size, expiresAt) {
  if (!/^[a-f0-9]{64}$/.test(String(sha256 || ''))) return null;
  let file = null;
  try { file = await db.findFileBySha256(sha256, ownerHash); } catch { return null; }
  if (!file || !file.name) return null;
  // A hash hint is not enough: the stored bytes must match the declared size,
  // and a permanent request must never be answered with a temporary file that
  // could expire underneath the returned link.
  if (Number(file.size) !== Number(size)) return null;
  if (!expiresAt && file.expires_at) return null;
  if (expiresAt && file.expires_at && Number(file.expires_at) < expiresAt) return null;
  return { url: publicUrl(req, `/files/${file.name}`), name: file.name };
}

function problemStatus(problem) {
  if (String(problem).includes('large')) return 413;
  if (String(problem).includes('allowed')) return 403;
  return 400;
}

async function receivedBytes(id) {
  try {
    return (await fs.promises.stat(stagePath(id))).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

function register(app, { enqueue }) {
  const jsonBody = express.json({ limit: '8kb' });
  const rawChunk = express.raw({ type: () => true, limit: CHUNK_SIZE + 1024 });

  function ownerOf(body, req) {
    if (req.user && req.user.userhash) return req.user.userhash;
    return typeof body.userhash === 'string' && body.userhash
      ? body.userhash.slice(0, 200)
      : null;
  }

  function expiresAtFrom(time) {
    const key = String(time || '');
    return config.litterboxTimes[key] ? Date.now() + config.litterboxTimes[key] : null;
  }

  function newSession(body, req, extras = {}) {
    return {
      id: crypto.randomBytes(16).toString('hex'),
      n: sanitizeOriginalName(String(body.originalName || '')),
      m: String(body.mime || 'application/octet-stream').slice(0, 120),
      s: Number(body.size),
      o: ownerOf(body, req),
      x: expiresAtFrom(body.time),
      h: /^[a-f0-9]{64}$/.test(String(body.sha256 || '')) ? body.sha256 : null,
      exp: Date.now() + SESSION_TTL_MS,
      ...extras,
    };
  }

  function validateFile(payload) {
    if (!payload.n) return 'A file name is required.';
    if (!Number.isFinite(payload.s) || payload.s <= 0) return 'That file is empty.';
    if (payload.s > config.maxFileSize) return 'That file is too large.';
    if (isBlockedUpload(payload.n, payload.m)) return "That file type isn't allowed here.";
    return null;
  }

  // Single-file session. A known content hash can short-circuit the whole
  // upload: the 201 response then carries `url` and no chunks are needed.
  app.post('/api/uploads', jsonBody, asyncRoute(async (req, res) => {
    const payload = newSession(req.body || {}, req);
    const problem = validateFile(payload);
    if (problem) return res.status(problemStatus(problem)).type('text/plain').send(problem);
    const hit = await dedupeUrl(payload.h, payload.o, req, payload.s, payload.x);
    res.status(201).json({
      uploadId: payload.id,
      token: sign(payload),
      chunkSize: CHUNK_SIZE,
      size: payload.s,
      ...(hit ? { url: hit.url } : {}),
    });
  }));

  /* ---------------------- multi-file batch sessions ---------------------- */
  // Non-browser clients create up to 100 signed sessions in one request and
  // receive a single aggregate status URL. Each file still uses the ordinary
  // PUT /api/uploads/:id + /complete flow, so no new storage path is involved.
  app.post('/api/uploads/batch', express.json({ limit: '64kb' }), asyncRoute(async (req, res) => {
    const body = req.body || {};
    const list = Array.isArray(body.files) ? body.files : null;
    if (!list || !list.length) return res.status(400).type('text/plain').send('A non-empty files array is required.');
    if (list.length > config.batching.maxFiles) {
      return res.status(413).type('text/plain').send(`At most ${config.batching.maxFiles} files per batch.`);
    }
    const batchId = crypto.randomBytes(12).toString('hex');
    const files = [];
    const ids = [];
    for (let i = 0; i < list.length; i++) {
      const payload = newSession(list[i] || {}, req, { b: batchId, i });
      const problem = validateFile(payload);
      if (problem) return res.status(problemStatus(problem)).type('text/plain').send(`File ${i + 1}: ${problem}`);
      const hit = await dedupeUrl(payload.h, payload.o, req, payload.s, payload.x);
      ids.push(payload.id);
      files.push({
        index: i,
        originalName: payload.n,
        size: payload.s,
        uploadId: payload.id,
        token: sign(payload),
        ...(hit ? { url: hit.url } : {}),
      });
    }
    const token = sign({ b: batchId, f: ids, e: ids.length, exp: Date.now() + SESSION_TTL_MS });
    res.status(201).json({
      batchId,
      statusUrl: `/api/uploads/batch/${batchId}?token=${encodeURIComponent(token)}`,
      chunkSize: CHUNK_SIZE,
      files,
    });
  }));

  app.get('/api/uploads/batch/:id', asyncRoute(async (req, res) => {
    const payload = verifyBatch(req.query.token);
    if (!payload || payload.b !== req.params.id) {
      return res.status(401).type('text/plain').send('This batch status link is invalid or has expired.');
    }
    const rows = await db.jobsByBatch(payload.b);
    const byId = new Map(rows.map(row => [String(row.job_id), row]));
    const items = payload.f.map((uploadId, index) => {
      const row = byId.get(String(uploadId).slice(0, 24));
      const origin = config.baseUrl || `${req.protocol}://${req.get('host')}`;
      return {
        index,
        uploadId,
        status: row ? row.status : 'uploading',
        ...(row && row.status === 'ready' && row.file_name
          ? { url: `${origin.replace(/\/$/, '')}/files/${row.file_name}` } : {}),
        ...(row && row.status === 'failed' ? { error: row.last_error || 'Upload failed.' } : {}),
      };
    });
    const done = items.filter(i => i.status === 'ready');
    const failed = items.filter(i => i.status === 'failed');
    res.json({
      batchId: payload.b,
      total: items.length,
      ready: done.length,
      failed: failed.length,
      complete: done.length + failed.length === items.length,
      urls: done.map(i => i.url),
      items,
    });
  }));

  function authorize(req, res) {
    const payload = verify(req.get('X-Upload-Token'));
    if (!payload || payload.id !== req.params.id) {
      res.status(401).type('text/plain').send('This upload session is invalid or has expired.');
      return null;
    }
    return payload;
  }

  app.get('/api/uploads/:id', asyncRoute(async (req, res) => {
    const payload = authorize(req, res);
    if (!payload) return;
    const received = await receivedBytes(payload.id);
    res.json({ uploadId: payload.id, received, size: payload.s, complete: received >= payload.s });
  }));

  app.put('/api/uploads/:id', rawChunk, asyncRoute(async (req, res) => {
    const payload = authorize(req, res);
    if (!payload) return;
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!chunk.length) return res.status(400).type('text/plain').send('No chunk was supplied.');
    const offset = Number(req.get('X-Upload-Offset'));
    const current = await receivedBytes(payload.id);
    if (!Number.isInteger(offset) || offset !== current) {
      // The client re-queries and resumes at this byte instead of guessing.
      return res.status(409).json({ received: current, size: payload.s });
    }
    if (offset + chunk.length > payload.s) {
      return res.status(413).type('text/plain').send('This upload is larger than the session allows.');
    }
    const handle = await fs.promises.open(stagePath(payload.id), 'a');
    try {
      await handle.write(chunk);
    } finally {
      await handle.close();
    }
    const next = offset + chunk.length;
    res.json({ uploadId: payload.id, received: next, size: payload.s, complete: next >= payload.s });
  }));

  app.post('/api/uploads/:id/complete', asyncRoute(async (req, res) => {
    const payload = authorize(req, res);
    if (!payload) return;
    // Return the same job if the client retries the final acknowledgement.
    // This must precede the byte-count check: the job worker may already have
    // consumed and deleted the staged bytes, so a fast retry would otherwise
    // see zero bytes and get a 409 instead of the already-queued job.
    let job;
    try {
      job = JSON.parse(await fs.promises.readFile(`${stagePath(payload.id)}.done`, 'utf8'));
      return res.status(202).json(job);
    } catch { /* first completion */ }
    const received = await receivedBytes(payload.id);
    if (received !== payload.s) {
      return res.status(409).json({ received, size: payload.s });
    }
    const jobId = await enqueue({
      jobId: payload.id.slice(0, 24),
      stagedPath: stagePath(payload.id),
      ownerHash: payload.o || null,
      originalName: payload.n,
      mime: payload.m,
      size: payload.s,
      expiresAt: payload.x || null,
      sha256: payload.h || null,
      batchId: payload.b || null,
      batchItemIndex: payload.i,
    });
    job = { job_id: jobId, status: 'queued', status_url: `/api/jobs/${jobId}` };
    await fs.promises.writeFile(`${stagePath(payload.id)}.done`, JSON.stringify(job));
    res.status(202).json(job);
  }));

  app.delete('/api/uploads/:id', asyncRoute(async (req, res) => {
    const payload = authorize(req, res);
    if (!payload) return;
    await Promise.all([
      fs.promises.unlink(stagePath(payload.id)).catch(() => {}),
      fs.promises.unlink(`${stagePath(payload.id)}.done`).catch(() => {}),
    ]);
    res.status(204).end();
  }));
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { register, stagePath, CHUNK_SIZE, sign, verify, verifyBatch };
