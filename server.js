'use strict';

// File host API and file serving. Browser pages and static UI assets are not included.

require('./bootstrap');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const express = require('express');
const multer = require('multer');

const { config, publicUrl } = require('./src/config');
const { getStorage } = require('./src/storage');
const jobs = require('./src/jobs');
const uploadSessions = require('./src/uploadSessions');
const db = require('./src/dbAdapter');
const util = require('./src/util');
const api = require('./src/api');
const auth = require('./src/auth');
const adminAuth = require('./src/adminAuth');
const bruteForce = require('./src/bruteForce');
const runtimeFlags = require('./src/runtimeFlags');
const adminApi = require('./src/adminApi');
const metadataMirror = require('./src/metadataMirror');
const nodeRouting = require('./src/nodeRouting');

const app = express();
app.disable('x-powered-by');

// Wrap async route handlers so a rejected promise reaches Express's error
// handler instead of hanging the request (Express 4 does not await handlers).
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Behind a reverse proxy, honour X-Forwarded-* so publicUrl builds correctly.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', true);

/* ------------------------------ middleware ------------------------------ */

app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Coarse per-IP throttle for the upload endpoints.
const uploadHits = new Map();
function uploadThrottle(req, res, next) {
  if (req.method !== 'POST') return next();
  const now = Date.now();
  const ip = req.ip || 'unknown';
  let entry = uploadHits.get(ip);
  if (!entry || now - entry.start > config.rateLimit.windowMs) {
    entry = { start: now, count: 0 };
    uploadHits.set(ip, entry);
  }
  entry.count++;
  const resetAt = entry.start + config.rateLimit.windowMs;
  res.setHeader('X-RateLimit-Limit', String(config.rateLimit.maxUploads));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, config.rateLimit.maxUploads - entry.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(resetAt / 1000)));
  if (entry.count > config.rateLimit.maxUploads) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
    return res.status(429).type('text/plain').send('Slow down a little, okay?');
  }
  next();
}
app.use(['/user/api.php', '/litterbox/api.php'], uploadThrottle);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.tmpDir),
    filename: (req, file, cb) => cb(null, `up_${crypto.randomBytes(12).toString('hex')}`),
  }),
  limits: { fileSize: config.maxFileSize, files: 1 },
});

// Multer writes a partial temp file before our handler runs. A client that
// disconnects mid-body — or a rejected/oversized file — would otherwise leave
// that orphan behind forever. Release the staged path once a job owns it.
function safeUpload(req, res, next) {
  upload.single('fileToUpload')(req, res, err => {
    const staged = (err && err.file && err.file.path) || (req.file && req.file.path);
    const drop = () => { if (staged) fs.promises.unlink(staged).catch(() => {}); };
    if (err) {
      drop();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).type('text/plain').send(`That file is larger than the ${util.humanSize(config.maxFileSize)} limit.`);
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).type('text/plain').send('No file was supplied.');
      }
      console.error('multipart error:', err);
      return res.status(400).type('text/plain').send('The upload could not be read.');
    }
    if (staged) {
      let released = false;
      req.releaseStaged = () => { released = true; };
      const cleanup = () => { if (!released) drop(); };
      req.on('aborted', cleanup);
      res.on('close', () => { if (!res.writableFinished) cleanup(); });
    }
    next();
  });
}

// A spoke is reachable only through its per-session public tunnel. Require the
// hub secret so a discovered tunnel URL cannot be abused for direct uploads.
// The hub always sends this header when it forwards a staging file.
function spokeAuth(req, res, next) {
  if (config.nodeMode) {
    const secret = process.env.NODE_UPLOAD_SECRET;
    if (!secret || req.get('X-Catbox-Secret') !== secret) {
      return res.status(403).type('text/plain').send('Forbidden.');
    }
  }
  next();
}

app.use(auth.sessionMiddleware);
app.use(adminAuth.middleware);

// Operator-controlled maintenance switch. Only upload writes are paused;
// downloads, account pages and the admin console itself keep working.
app.use(['/user/api.php', '/litterbox/api.php', '/api/uploads'], (req, res, next) => {
  if (req.method !== 'GET' && runtimeFlags.get().uploadsPaused) {
    return res.status(503).type('text/plain; charset=utf-8').send('Uploads are temporarily paused for maintenance.');
  }
  next();
});

// Short, resumable browser uploads. The signed token is a capability: each
// chunk and the final commit are independently authenticated and short-lived.
// Spokes only accept hub-forwarded multipart uploads; they never claim jobs.
if (!config.nodeMode) {
  uploadSessions.register(app, {
    enqueue: details => jobs.enqueue(details),
  });
}

// Browser experience and static assets.
app.use(express.static(path.join(__dirname, 'public')));

// Operator console and its API. Registered before the generic catch-all so
// /admin resolves to the console instead of the public SPA shell. There is one
// admin console on the hub; spokes do not expose one.
if (!config.nodeMode) adminApi.register(app);

/* ------------------------------- API ---------------------------------- */

// Public runtime configuration so the browser can enforce the same ceiling as
// the server. No secrets are ever exposed here.
app.get('/api/config', (req, res) => {
  res.json({
    maxFileSize: config.maxFileSize,
    maxFileSizeHuman: util.humanSize(config.maxFileSize),
    transport: config.discord.transport,
    batchConcurrency: config.batching.concurrency,
    batchMaxConcurrency: config.batching.maxConcurrency,
    adaptiveBatches: config.batching.adaptive,
    maxBatchFiles: config.batching.maxFiles,
    experimental: true,
  });
});

// Internal endpoint used by node workers after a successful Discord write.
// Guarded by a shared secret; never exposed to browsers.
app.post('/internal/files', express.json({ limit: '64kb' }), asyncRoute(async (req, res) => {
  const secret = process.env.NODE_UPLOAD_SECRET;
  if (!secret || req.get('X-Catbox-Secret') !== secret) {
    return res.status(401).type('text/plain').send('Unauthorized.');
  }
  const b = req.body || {};
  const originalName = b.original_name || b.originalName;
  if (!b.name || !originalName || !b.mime || !Number.isFinite(Number(b.size))) {
    return res.status(400).json({ error: 'Incomplete metadata.' });
  }
  const metadata = {
    name: b.name,
    ownerHash: b.owner_hash || b.ownerHash || null,
    originalName,
    mime: b.mime,
    size: Number(b.size),
    sha256: b.sha256 || null,
    expiresAt: b.expires_at || b.expiresAt || null,
    botId: b.bot_id || b.botId || null,
    channelId: b.channel_id || b.channelId || null,
    messageId: b.message_id || b.messageId || null,
    attachmentId: b.attachment_id || b.attachmentId || null,
    cdnUrl: b.cdn_url || b.cdnUrl || null,
    cdnExpiresAt: b.cdn_expires_at || b.cdnExpiresAt || null,
    status: b.status || 'ready',
  };
  try {
    await db.recordFile(metadata);
    return res.status(201).json({ ok: true });
  } catch (err) {
    // Discord already has the durable bytes. Journal the metadata and let the
    // sweep replay it, so the node does not re-upload and create an orphan.
    console.error('internal recordFile failed; journaling for replay:', err.message);
    try {
      await db.addJournal({
        jobId: b.job_id || '',
        fileName: b.name,
        stage: 'metadata',
        error: err.message,
        metadata,
      });
      return res.status(202).json({ ok: true, pending: true });
    } catch (journalErr) {
      console.error('journal write failed:', journalErr.message);
      return res.status(500).json({ error: 'Could not record file.' });
    }
  }
}));

// Node reports an orphan it could not reach the control plane to record. The
// sweep records the metadata from here (or flags it for manual cleanup).
app.post('/internal/journal', express.json({ limit: '64kb' }), asyncRoute(async (req, res) => {
  const secret = process.env.NODE_UPLOAD_SECRET;
  if (!secret || req.get('X-Catbox-Secret') !== secret) {
    return res.status(401).type('text/plain').send('Unauthorized.');
  }
  const b = req.body || {};
  if (!b.job_id && !b.file_name) return res.status(400).json({ error: 'job_id or file_name is required.' });
  await db.addJournal({
    jobId: b.job_id || '', fileName: b.file_name || null, stage: b.stage || 'metadata',
    error: b.error || null, metadata: b.metadata || null, attempts: Number(b.attempts) || 0,
  });
  res.status(201).json({ ok: true });
}));

// Manually trigger a reconciliation pass (used by operators and tests).
app.post('/internal/journal/reconcile', (req, res) => {
  const secret = process.env.NODE_UPLOAD_SECRET;
  if (!secret || req.get('X-Catbox-Secret') !== secret) {
    return res.status(401).type('text/plain').send('Unauthorized.');
  }
  jobs.reconcileJournal({ force: true })
    .then(() => res.json({ ok: true }))
    .catch(err => res.status(500).json({ error: err.message }));
});

// Operational metrics for dashboards and health checks. Aggregate counters
// only — no tokens, filenames or user data are exposed.
app.get('/api/metrics', asyncRoute(async (req, res) => {
  // The SQL counter is SQLite-only; the Supabase adapter reports jobs: null.
  let jobs = null;
  if (db.getDb && db.getDb()) {
    const row = db.getDb().prepare(
      `SELECT
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'uploading' THEN 1 ELSE 0 END) AS uploading,
         SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM upload_jobs`
    ).get();
    jobs = {
      queued: row.queued || 0, uploading: row.uploading || 0,
      ready: row.ready || 0, failed: row.failed || 0,
    };
  }
  const journal = db.journalStats ? await db.journalStats() : null;
  const nodeRows = await getNodeRegistry().catch(() => []);
  const storage = getStorage();
  res.json({
    ok: true,
    backend: db.backend || 'sqlite',
    storage: config.discord.transport,
    jobs,
    journal,
    discord: typeof storage.stats === 'function' ? storage.stats() : null,
    staging: {
      bytes: nodeRows.reduce((sum, n) => sum + (Number(n.staged_bytes) || 0), 0),
      files: nodeRows.reduce((sum, n) => sum + (Number(n.staged_files) || 0), 0),
    },
    nodes: nodeRows.map(n => ({
      id: n.node_id, status: n.status, pending: n.pending, active: n.active,
      draining: Boolean(n.draining), stagedBytes: n.staged_bytes || 0,
      stagedFiles: n.staged_files || 0, lastHeartbeat: n.last_heartbeat,
    })),
    uptimeSeconds: Math.floor(process.uptime()),
  });
}));

// Node registry consumed by the Cloudflare Worker for least-loaded routing.
app.get('/api/nodes', asyncRoute(async (req, res) => {
  const registered = (await getNodeRegistry()).map(node => ({
    id: node.node_id,
    url: node.web_url,
    status: node.status,
    pending: node.pending,
    active: node.active,
    draining: Boolean(node.draining),
    stagedBytes: node.staged_bytes || 0,
    stagedFiles: node.staged_files || 0,
    lastHeartbeat: node.last_heartbeat,
  }));
  if (registered.length) return res.json({ nodes: registered });
  // Local/SQLite fallback used before any node has sent a heartbeat.
  const fallback = String(process.env.NODE_REGISTRY || '');
  let nodes = [];
  try { nodes = fallback ? JSON.parse(fallback) : []; } catch { nodes = []; }
  res.json({ nodes: Array.isArray(nodes) ? nodes : [] });
}));

app.post('/internal/nodes/heartbeat', express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
  const secret = process.env.NODE_UPLOAD_SECRET;
  if (!secret || req.get('X-Catbox-Secret') !== secret) {
    return res.status(401).type('text/plain').send('Unauthorized.');
  }
  const b = req.body || {};
  if (!b.node_id) return res.status(400).json({ error: 'node_id is required.' });
  await db.upsertNode({
    nodeId: String(b.node_id),
    hostname: b.hostname,
    webUrl: b.web_url || b.webUrl || '',
    pending: Number(b.pending) || 0,
    active: Number(b.active) || 0,
    draining: b.draining ? 1 : 0,
    stagedBytes: Number(b.staged_bytes) || 0,
    stagedFiles: Number(b.staged_files) || 0,
    status: b.status || 'up',
  });
  // A heartbeat may introduce a new spoke or change its load. Make the cached
  // registry reflect it on the very next routing decision / metrics read.
  registryCache = null;
  res.json({ ok: true });
}));

// Poll an async upload. Returns queued/uploading/ready/failed without bytes.
app.get('/api/jobs/:id', asyncRoute(async (req, res) => {
  const job = jobs.publicJob(await db.getJob(String(req.params.id || '')), req);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  res.json(job);
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to view your library.' });
  const files = await db.filesByOwner(req.user.userhash);
  const albums = await db.albumsByOwner(req.user.userhash);
  res.json({
    user: { username: req.user.username, role: req.user.role || 'user' },
    files: files.map(file => ({
      name: file.name,
      originalName: file.original_name,
      mime: file.mime,
      size: file.size,
      uploadedAt: file.uploaded_at,
      url: publicUrl(req, `/files/${file.name}`),
    })),
    albums,
  });
}));

app.get('/api/albums/:short', asyncRoute(async (req, res) => {
  const album = await db.getAlbum(req.params.short);
  if (!album) return res.status(404).json({ error: 'Album not found.' });
  const files = await db.albumFiles(album.short);
  res.json({
    album: { title: album.title, description: album.description },
    files: files.map(file => ({
      name: file.name,
      originalName: file.original_name,
      mime: file.mime,
      size: file.size,
      url: publicUrl(req, `/files/${file.name}`),
    })),
  });
}));

/* -------------------------- hub / spoke routing ------------------------- */

// The hub forwards synchronous multipart uploads to the least-loaded healthy
// spoke so each bot can live in its own repo. Any failure falls back to the
// local storage path, so a dead spoke never becomes a user-visible outage.
// Async uploads stay local: their job ids are owned by this process.
// Node registry snapshot. Under load every upload previously made its own live
// Supabase round-trip just to pick a target; 80 concurrent uploads meant 80
// concurrent reads and starved the control-plane endpoints (/api/nodes,
// /api/metrics) when Supabase or the tunnel was busy. Heartbeats are 15s apart,
// so a 3s snapshot is fresh enough for load-aware routing. A stale snapshot is
// kept on errors so a transient registry failure never breaks upload routing.
const REGISTRY_TTL_MS = Math.max(500, parseInt(process.env.NODE_REGISTRY_TTL_MS || '3000', 10));
let registryCache = null;
let registryCacheAt = 0;
async function getNodeRegistry() {
  const now = Date.now();
  if (registryCache && now - registryCacheAt < REGISTRY_TTL_MS) return registryCache;
  try {
    registryCache = await db.listNodes();
    registryCacheAt = now;
  } catch (err) {
    if (!registryCache) throw err;
    console.warn('[hub] node registry refresh failed, using stale snapshot:', err.message);
  }
  return registryCache;
}

let routeCursor = 0;
// Live in-flight upload count, published in spoke heartbeats so the hub can
// route by actual pressure instead of assuming every runner is idle.
let activeUploads = 0;
function asyncMode(req) {
  const value = String(req.get('X-Catbox-Async') || '').toLowerCase();
  if (value === '1') return 'always';
  if (value === 'if-overloaded') return 'if-overloaded';
  return 'off';
}

async function cleanupStaged(req) {
  if (typeof req.releaseStaged === 'function') req.releaseStaged();
  const staged = req.file && req.file.path;
  if (staged) await fs.promises.unlink(staged).catch(() => {});
}

// Refuse only when there is nowhere left to send the bytes. A healthy spoke or
// an idle local bot bucket is enough to admit the request, so normal traffic
// never sees a 503 just because one runner is busy.
async function checkAdmission() {
  try {
    const now = Date.now();
    const nodes = (await getNodeRegistry()).filter(node =>
      node && node.web_url
      && node.status !== 'down' && node.status !== 'unhealthy' && !node.draining
      && (now - (Number(node.last_heartbeat) || 0)) <= config.nodeStaleAfterMs
    );
    const spokeSaturated = !nodes.length
      || nodes.every(node => nodeRouting.score(node) >= config.admission.nodeSaturationScore);
    const storage = getStorage();
    const stats = storage && typeof storage.stats === 'function' ? storage.stats() : null;
    const buckets = stats && stats.buckets;
    const localSaturated = activeUploads >= config.admission.localActiveMax
      || Boolean(buckets && (buckets.waiters > 0 || buckets.blockedMs > 0));
    return { admitted: !(spokeSaturated && localSaturated), stats };
  } catch (err) {
    console.warn('[admission] check failed, admitting request:', err.message);
    return { admitted: true, stats: null };
  }
}

function overloadRetryAfter(stats) {
  const buckets = stats && stats.buckets;
  const ms = buckets ? Math.max(buckets.blockedMs || 0, buckets.resetMs || 0) : 0;
  if (ms <= 0) return config.admission.retryAfterSeconds;
  return Math.min(120, Math.max(1, Math.ceil(ms / 1000)));
}

function trackActiveUploads(handler) {
  return async (req, res) => {
    activeUploads += 1;
    let done = false;
    const finish = () => { if (!done) { done = true; activeUploads -= 1; } };
    res.once('finish', finish);
    res.once('close', finish);
    // Browsers already stream chunks through /api/uploads; admission applies to
    // whole-body multipart uploads only, and never to delete/album operations.
    if (req.file && asyncMode(req) !== 'always') {
      const admission = await checkAdmission();
      if (!admission.admitted) {
        if (asyncMode(req) === 'if-overloaded') {
          // Same staged body, but the job runner owns it from here. The plain
          // synchronous contract is untouched for clients with no header.
          req.headers['x-catbox-async'] = '1';
          return handler(req, res);
        }
        res.setHeader('Retry-After', String(overloadRetryAfter(admission.stats)));
        finish();
        await cleanupStaged(req);
        return res.status(503).type('text/plain').send('Uploads are temporarily busy. Please retry shortly.');
      }
    }
    return handler(req, res);
  };
}

async function handleHubUpload(req, res, localHandler) {
  const forwardable = !config.nodeMode
    && req.file
    && req.get('X-Catbox-Async') !== '1';
  if (!forwardable) return localHandler(req, res);

  let node = null;
  try {
    node = nodeRouting.pickNode(await getNodeRegistry(), undefined, undefined, routeCursor++);
  } catch (err) {
    console.warn('[hub] node registry unavailable:', err.message);
  }
  if (!node) return localHandler(req, res);

  try {
    const result = await nodeRouting.forwardUpload(node, req);
    if (result.status >= 200 && result.status < 300 && /^https?:\/\//.test(result.text)) {
      // The spoke stored the bytes, so the hub's staged copy is no longer
      // needed. The local handler normally does this; do it here as well.
      const staged = req.file && req.file.path;
      if (typeof req.releaseStaged === 'function') req.releaseStaged();
      if (staged) await fs.promises.unlink(staged).catch(() => {});
      return res.status(result.status).type('text/plain; charset=utf-8').send(result.text);
    }
    // A spoke that is itself overloaded is only a hard failure when there is
    // no spare local capacity either; otherwise keep the existing local fallback.
    if ((result.status === 429 || result.status === 503) && !(await checkAdmission()).admitted) {
      for (const [name, value] of Object.entries(result.headers || {})) res.setHeader(name, value);
      if (!res.getHeader('Retry-After')) res.setHeader('Retry-After', String(config.admission.retryAfterSeconds));
      await cleanupStaged(req);
      return res.status(result.status).type('text/plain').send('Uploads are temporarily busy. Please retry shortly.');
    }
    throw new Error(`spoke returned ${result.status}: ${result.text.slice(0, 120)}`);
  } catch (err) {
    console.warn(`[hub] forward to ${node.node_id || node.id} failed: ${err.message}; using local upload`);
    return localHandler(req, res);
  }
}

function localApiUpload(req, res) {
  api.handleApi(req, res).catch(err => {
    console.error('api error:', err);
    if (!res.headersSent) res.status(500).type('text/plain').send('Internal server error.');
  });
}

// Multipart parsing first (file uploads); urlencoded bodies were parsed
// by the global middleware above for the form-style request types.
app.all('/user/api.php', spokeAuth, safeUpload, trackActiveUploads((req, res) => {
  handleHubUpload(req, res, localApiUpload);
}));

/* ---------------------------- file serving ----------------------------- */

const NAME_RE = /^[a-z0-9]{1,12}(\.[a-z0-9]{1,8})?$/i;

async function serveFile(req, res) {
  const name = String(req.params.name || '');
  if (!NAME_RE.test(name)) return res.status(404).type('text/plain').send('Not found.');
  const row = await db.getFile(name);
  if (!row || (row.expires_at && row.expires_at <= Date.now())) {
    return res.status(404).type('text/plain').send('This file does not exist or has been deleted.');
  }
  if (!row.cdn_url) {
    return res.status(503).type('text/plain').send('This file is still being uploaded. Try again shortly.');
  }
  const signedUrl = await getStorage().resolve(row);
  const target = signedUrl.startsWith('/') ? publicUrl(req, signedUrl) : signedUrl;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (config.fileDelivery === 'redirect') {
    // The signed storage URL is short-lived, so never cache the redirect.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.redirect(302, target);
  }
  return proxyBytes(target, req, res, row.mime, row.expires_at);
}

// Immutable content can be cached for a year. Temporary files get a cache
// lifetime bounded by their expiry so a link never outlives the file.
function fileCacheControl(expiresAt) {
  if (!expiresAt) return 'public, max-age=31536000, immutable';
  const seconds = Math.floor((Number(expiresAt) - Date.now()) / 1000);
  if (seconds <= 0) return 'no-store';
  return `public, max-age=${seconds}, immutable`;
}

// Stream the signed storage URL to the browser under our own hostname. The
// address bar never changes to the storage CDN, and no byte is written to disk.
async function proxyBytes(sourceUrl, req, res, mime, expiresAt) {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);

  const headers = { 'user-agent': 'MewPocket/1.0' };
  if (req.headers.range && /^bytes=/i.test(req.headers.range)) headers.range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(sourceUrl, { headers, redirect: 'follow', signal: controller.signal });
  } catch {
    if (!res.headersSent) return res.status(502).type('text/plain').send('The file is temporarily unavailable.');
    return res.end();
  }
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel().catch(() => {});
    if (!res.headersSent) return res.status(502).type('text/plain').send('The file is temporarily unavailable.');
    return res.end();
  }

  // Forward only safe, useful headers. Never leak the signed storage URL.
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!res.getHeader('content-type')) res.type(mime || 'application/octet-stream');
  res.setHeader('Cache-Control', fileCacheControl(expiresAt));
  res.status(upstream.status);

  if (req.method === 'HEAD' || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await once(res, 'drain');
    }
  } catch {
    // Client disconnected or the upstream stream dropped; nothing left to send.
  } finally {
    res.off('close', onClose);
    res.end();
  }
}

function serveFileSafe(req, res) {
  serveFile(req, res).catch(err => {
    console.error('resolve failed:', err);
    if (!res.headersSent) res.status(503).type('text/plain').send('Could not resolve the file right now.');
  });
}

app.get('/files/:name', serveFileSafe);
app.get('/i/:name', serveFileSafe); // image-host style alias

// Test-only byte source for the mock transport. Production never registers it.
if (config.discord.transport === 'mock') {
  app.get('/__mock_cdn/:id', (req, res) => {
    const item = getStorage().get(req.params.id);
    if (!item) return res.status(404).type('text/plain').send('Not found.');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(item.mime).send(item.buffer);
  });
}

/* ----------------------------- browser pages --------------------------- */

const browserPages = ['/', '/nofun.php', '/faq.php', '/tools.php', '/legal.php', '/contact.php', '/credits.php', '/litterbox.php', '/a/:short', '/user/login.php', '/user/register.php', '/user/forgotpassword.php', '/user/index.php', '/user/albums.php'];
app.get(browserPages, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/ops', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ops.html')));

/* ------------------------------ contact -------------------------------- */

app.post('/do_contact.php', asyncRoute(async (req, res) => {
  const name = String(req.body.sendername || '').slice(0, 100);
  const message = String(req.body.message || '').slice(0, 5000);
  if (!name || !message) return res.status(400).type('text/plain; charset=utf-8').send('Name and message are required.');
  await db.addMessage(name, String(req.body.email || '').slice(0, 200), message);
  res.type('text/plain; charset=utf-8').send('Thanks. Your message has been recorded.');
}));

function localLitterboxUpload(req, res) {
  litterboxUpload(req, res).catch(err => {
    console.error('litterbox error:', err);
    if (!res.headersSent) res.status(500).type('text/plain').send('Internal server error.');
  });
}

app.all('/litterbox/api.php', spokeAuth, safeUpload, trackActiveUploads((req, res) => {
  handleHubUpload(req, res, localLitterboxUpload);
}));

/* --------------------------- account actions --------------------------- */

app.post('/user/dologin.php', asyncRoute(async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const identity = `login:${username.toLowerCase() || req.ip}`;
  const state = bruteForce.check(req.ip, identity);
  if (state.blocked) {
    const seconds = Math.max(1, Math.ceil(state.retryAfterMs / 1000));
    return res.status(429).type('text/plain; charset=utf-8')
      .send(`Too many failed attempts. Try again in ${seconds} seconds.`);
  }
  const user = await auth.authenticate(username, req.body.password);
  if (!user) {
    bruteForce.fail(req.ip, identity);
    return res.status(401).type('text/plain; charset=utf-8').send('Wrong username or password.');
  }
  bruteForce.clear(req.ip, identity);
  await auth.rotateSession(req, res, user);
  res.type('text/plain; charset=utf-8').send('Authenticated. Session cookie set.');
}));

app.post('/user/doregister.php', asyncRoute(async (req, res) => {
  const { user, errors } = await auth.registerUser(req.body);
  if (errors) return res.status(400).type('text/plain; charset=utf-8').send(errors.join(' '));
  await auth.startSession(res, user);
  res.status(201).type('text/plain; charset=utf-8').send('Account created. Session cookie set.');
}));

app.post('/user/reset_password.php', (req, res) => {
  // Do not change credentials without a verified delivery channel. This build
  // has no email or token-based recovery flow, so return the same safe response
  // for every address and direct users to the contact page.
  res.status(503).type('text/plain; charset=utf-8').send('Password reset is not configured. Use the contact form to ask the site operator for help.');
});

app.get('/user/logout.php', asyncRoute(async (req, res) => {
  await auth.endSession(req, res);
  res.type('text/plain; charset=utf-8').send('Logged out.');
}));

/* ------------------------------ 404 & boot ------------------------------ */

function notFound(req, res) {
  res.status(404).type('text/plain; charset=utf-8').send('Not found.');
}
app.use(notFound);

// Any rejected async route/session middleware lands here instead of hanging.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('request failed:', err);
  if (res.headersSent) return next(err);
  res.status(500).type('text/plain; charset=utf-8').send('Internal server error.');
});

fs.mkdirSync(config.tmpDir, { recursive: true });

// Hourly sweep: delete the Discord message first, then the metadata row.
async function purgeExpired() {
  const rows = await db.expiredFiles();
  for (const row of rows) {
    try {
      await getStorage().remove(row);
      await db.deleteFileRows([row.name]);
    } catch (err) {
      console.error('purge failed for', row.name, err);
    }
  }
}
// Only the hub purges expired files: a spoke holds one bot token and cannot
// delete messages belonging to the other bots.
if (!config.nodeMode) {
  setInterval(() => {
    purgeExpired().catch(err => console.error('purge sweep failed:', err));
  }, 60 * 60 * 1000).unref();
}

if (require.main === module) {
  db.getDb();

  // A spoke owns one bot and nothing else. It must not run the job runner,
  // metadata mirror or admin console: all three assume a single writer.
  nodeRouting.startHeartbeat(() => ({ active: activeUploads }));

  if (!config.nodeMode) {
    // Supabase can come back empty after its host restarts. Restore the
    // Discord-backed metadata mirror before the job runner starts, so workers
    // never race a half-restored table.
    metadataMirror.start()
      .catch(err => console.error('metadata mirror failed to start:', err))
      .finally(() => {
        jobs.start().catch(err => console.error('job runner failed to start:', err));
      });

    // A runner that dies without a graceful shutdown leaves status='up' in the
    // registry forever. Reap rows whose heartbeat has gone stale so the hub
    // stops routing uploads to a tunnel that no longer exists.
    const reapStaleNodes = async () => {
      try {
        const now = Date.now();
        for (const node of await db.listNodes()) {
          if (node.node_id === 'local' || node.status === 'down') continue;
          if (now - (Number(node.last_heartbeat) || 0) <= config.nodeStaleAfterMs) continue;
          await db.upsertNode({
            nodeId: node.node_id,
            hostname: node.hostname,
            webUrl: node.web_url,
            status: 'down',
            draining: true,
            pending: 0,
            active: 0,
            stagedBytes: 0,
            stagedFiles: 0,
          });
          console.log(`[hub] reaped stale node ${node.node_id}`);
        }
      } catch (err) {
        console.warn('[hub] stale-node sweep failed:', err.message);
      }
    };
    setInterval(reapStaleNodes, config.nodeHeartbeatMs).unref();
  }

  const server = app.listen(config.port, () => {
    console.log(`File sharing service listening on http://localhost:${config.port}${config.nodeMode ? ' (spoke)' : ' (hub)'}`);
  });
  // Never let a half-sent body hold a connection indefinitely. The browser
  // watchdog reports a stalled transfer long before this ceiling is reached.
  server.headersTimeout = 60_000;
  server.requestTimeout = config.uploadRecovery.bodyTimeoutMs;

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    const finish = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    if (config.nodeMode) return finish();
    console.log('Persisting final metadata snapshot.');
    metadataMirror.flush().finally(() => {
      metadataMirror.stop();
      finish();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app };

/* Litterbox upload handler (server-side). */
async function litterboxUpload(req, res) {
  const send = (status, body) => res.status(status).type('text/plain; charset=utf-8').send(body);
  let timeRaw = req.body.time;
  if (Array.isArray(timeRaw)) timeRaw = timeRaw[timeRaw.length - 1];
  const timeKey = String(timeRaw || '24h');
  const ttl = config.litterboxTimes[timeKey];
  if (!ttl) return send(400, 'That expiry is not valid. Use 1h, 12h, 24h or 72h.');
  if (!req.file && req.body.reqtype === 'urlupload') return litterboxUrlUpload(req, res, ttl);
  if (!req.file) return send(400, 'No file was supplied.');
  const file = req.file;
  if (util.isBlockedUpload(file.originalname, file.mimetype)) {
    fs.unlink(file.path, () => {});
    return send(403, "That file type isn't allowed here.");
  }
  if (file.size > config.maxFileSize) {
    fs.unlink(file.path, () => {});
    return send(413, util.limitMessage());
  }
  try {
    const name = await api.commitUpload(
      { ownerHash: null }, file.path, file.originalname, file.mimetype, file.size, Date.now() + ttl
    );
    return send(200, publicUrl(req, `/files/${name}`));
  } catch (err) {
    console.error('temporary upload failed:', err);
    fs.unlink(file.path, () => {});
    return send(500, 'Something went wrong storing that file.');
  }
}

async function litterboxUrlUpload(req, res, ttl) {
  const send = (status, body) => res.status(status).type('text/plain; charset=utf-8').send(body);
  let parsed;
  try { parsed = new URL(String(req.body.url || '').trim()); } catch { return send(400, 'That does not look like an http(s) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return send(400, 'That does not look like an http(s) URL.');
  let response;
  try { response = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'FileSharingService/1.0' } }); }
  catch { return send(412, 'Could not reach that URL.'); }
  if (!response.ok || !response.body) return send(412, 'Could not download that file.');
  if (Number(response.headers.get('content-length') || 0) > config.maxFileSize) return send(413, util.limitMessage());
  const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const candidate = match ? decodeURIComponent(match[1]) : path.basename(new URL(response.url).pathname);
  const originalName = util.sanitizeOriginalName(candidate) || `file.${util.extForMime(mime)}`;
  if (util.isBlockedUpload(originalName, mime)) return send(403, "That file type isn't allowed here.");
  const tmpPath = path.join(config.tmpDir, `url_${crypto.randomBytes(12).toString('hex')}`);
  const out = fs.createWriteStream(tmpPath);
  let size = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > config.maxFileSize) { reader.cancel(); throw new Error('too-big'); }
      if (!out.write(Buffer.from(value))) await new Promise(resolve => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
  } catch (error) {
    out.destroy(); fs.unlink(tmpPath, () => {});
    return send(error.message === 'too-big' ? 413 : 412, error.message === 'too-big' ? util.limitMessage() : 'Could not download that file.');
  }
  if (!size) { fs.unlink(tmpPath, () => {}); return send(412, 'That URL returned nothing.'); }
  try {
    const name = await api.commitUpload({ ownerHash: null }, tmpPath, originalName, mime, size, Date.now() + ttl);
    return send(200, publicUrl(req, `/files/${name}`));
  } catch (error) {
    fs.unlink(tmpPath, () => {});
    console.error('temporary URL upload failed:', error);
    return send(500, 'Something went wrong storing that file.');
  }
}
