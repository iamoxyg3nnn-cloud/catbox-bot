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
const { config } = require('./config');
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

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET)
    .update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!/^[a-f0-9]{32}$/.test(payload.id)) return null;
    if (!Number.isFinite(payload.s) || payload.s <= 0) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
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

  app.post('/api/uploads', jsonBody, (req, res) => {
    const body = req.body || {};
    const originalName = sanitizeOriginalName(String(body.originalName || ''));
    const mime = String(body.mime || 'application/octet-stream').slice(0, 120);
    const size = Number(body.size);
    const userhash = body.userhash ? String(body.userhash).slice(0, 200) : null;
    const litterboxTime = String(body.time || '');
    const expiresAt = config.litterboxTimes[litterboxTime]
      ? Date.now() + config.litterboxTimes[litterboxTime]
      : null;

    if (!originalName) return res.status(400).type('text/plain').send('A file name is required.');
    if (!Number.isFinite(size) || size <= 0) return res.status(400).type('text/plain').send('That file is empty.');
    if (size > config.maxFileSize) return res.status(413).type('text/plain').send('That file is too large.');
    if (isBlockedUpload(originalName, mime)) return res.status(403).type('text/plain').send("That file type isn't allowed here.");

    const payload = {
      id: crypto.randomBytes(16).toString('hex'),
      n: originalName,
      m: mime,
      s: size,
      o: req.user && req.user.userhash ? req.user.userhash : userhash,
      x: expiresAt,
      exp: Date.now() + SESSION_TTL_MS,
    };
    res.status(201).json({
      uploadId: payload.id,
      token: sign(payload),
      chunkSize: CHUNK_SIZE,
      size,
    });
  });

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
    const received = await receivedBytes(payload.id);
    if (received !== payload.s) {
      return res.status(409).json({ received, size: payload.s });
    }
    // Return the same job if the client retries the final acknowledgement.
    let job;
    try {
      job = JSON.parse(await fs.promises.readFile(`${stagePath(payload.id)}.done`, 'utf8'));
      return res.status(202).json(job);
    } catch { /* first completion */ }
    const jobId = await enqueue({
      jobId: payload.id.slice(0, 24),
      stagedPath: stagePath(payload.id),
      ownerHash: payload.o || null,
      originalName: payload.n,
      mime: payload.m,
      size: payload.s,
      expiresAt: payload.x || null,
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

module.exports = { register, stagePath, CHUNK_SIZE };
