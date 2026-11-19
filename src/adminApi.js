'use strict';

// Operator API behind the /admin console. Every mutating route is authenticated
// with a short-lived signed cookie and restricted to a fixed set of tables,
// keys and fields. File deletion always purges Discord bytes before metadata.

const path = require('path');
const express = require('express');
const db = require('./dbAdapter');
const adminAuth = require('./adminAuth');
const runtimeFlags = require('./runtimeFlags');
const { getStorage } = require('./storage');
const jobs = require('./jobs');
const { config } = require('./config');
const util = require('./util');

const TABLE_KEYS = {
  users: 'id',
  sessions: 'token',
  files: 'name',
  albums: 'short',
  album_files: 'album_short',
  messages: 'id',
  upload_jobs: 'job_id',
  discord_bots: 'bot_id',
  nodes: 'node_id',
  upload_journal: 'id',
};

const PATCHABLE = {
  users: ['role'],
  files: ['status'],
  albums: ['title', 'description'],
  upload_jobs: ['status', 'attempts', 'last_error'],
  discord_bots: ['enabled', 'health'],
  nodes: ['draining', 'status'],
  upload_journal: ['resolved'],
  sessions: ['expires_at'],
};

const STATUS_VALUES = {
  files: ['queued', 'uploading', 'ready', 'failed'],
  upload_jobs: ['queued', 'uploading', 'ready', 'failed', 'dead'],
  nodes: ['unknown', 'up', 'down', 'draining'],
  discord_bots: ['unknown', 'healthy', 'unhealthy'],
};

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const json = express.json({ limit: '64kb' });

function cleanRow(table, row) {
  if (!row) return row;
  if (table === 'users') {
    const { password_hash, ...safe } = row; // eslint-disable-line no-unused-vars
    return safe;
  }
  return row;
}

function sanitizePatch(table, input) {
  const allowed = PATCHABLE[table] || [];
  const out = {};
  for (const field of allowed) {
    if (!(field in (input || {}))) continue;
    let value = input[field];
    if (field === 'enabled' || field === 'draining' || field === 'resolved') {
      value = Boolean(value);
    } else if (field === 'attempts') {
      value = Math.min(100, Math.max(0, parseInt(value, 10) || 0));
    } else if (field === 'expires_at') {
      value = Number(value) || Date.now();
    } else if (field === 'status') {
      const permitted = STATUS_VALUES[table] || [];
      value = String(value);
      if (permitted.length && !permitted.includes(value)) {
        throw new Error(`Invalid status. Use one of: ${permitted.join(', ')}`);
      }
    } else if (field === 'role') {
      value = String(value);
      if (value !== 'user' && value !== 'admin') throw new Error('Role must be user or admin.');
    } else if (field === 'health') {
      value = String(value).slice(0, 40);
    } else {
      value = String(value).slice(0, field === 'description' || field === 'last_error' ? 2000 : 200);
    }
    out[field] = value;
  }
  if (!Object.keys(out).length) throw new Error('No editable fields supplied.');
  return out;
}

// Discord is the only byte store. Delete the message with the same bot that
// uploaded it, and only then remove the metadata row. A failed purge keeps the
// row so the hourly sweep can retry instead of orphaning bytes forever.
async function purgeFiles(names) {
  const unique = [...new Set((names || []).map(n => String(n || '')).filter(Boolean))].slice(0, 50);
  const result = { requested: unique.length, deleted: [], failed: [] };
  const storage = getStorage();
  for (const name of unique) {
    let row;
    try {
      row = await db.getFile(name);
    } catch (err) {
      result.failed.push({ name, error: `lookup: ${err.message}` });
      continue;
    }
    if (!row) {
      result.deleted.push(name); // already gone; treat as idempotent
      continue;
    }
    try {
      if (storage && storage.remove) await storage.remove(row);
    } catch (err) {
      result.failed.push({ name, error: `storage: ${err.message}` });
      continue;
    }
    try {
      await db.deleteFileRows([name]);
      result.deleted.push(name);
    } catch (err) {
      result.failed.push({ name, error: `metadata: ${err.message}` });
    }
  }
  return result;
}

async function probe(url, headers = {}) {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    });
    return { ok: response.ok, status: response.status, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: String(err.message).slice(0, 120), ms: Date.now() - start };
  }
}

async function health() {
  const result = {
    controlPlane: { ok: true },
    backend: db.backend || 'unknown',
    storage: config.discord.transport,
  };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  result.supabase = supabaseUrl && supabaseKey
    ? await probe(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/users?select=id&limit=1`, {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    })
    : { ok: false, error: 'not configured' };

  const base = (config.baseUrl || '').replace(/\/$/, '');
  result.edge = base ? await probe(`${base}/ping.txt`) : { ok: false, error: 'PUBLIC_BASE_URL not set' };

  try {
    const bots = await db.adminQuery('discord_bots', { limit: 50 });
    result.bots = bots.map(b => ({ id: b.bot_id, health: b.health, enabled: b.enabled }));
  } catch {
    result.bots = [];
  }
  return result;
}

function register(app) {
  // The console itself is served from the API origin so its session cookie is
  // same-origin. Vercel redirects /admin here (see public/vercel.json).
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

  app.get('/api/admin/status', (req, res) => {
    const authenticated = adminAuth.isAdmin(req);
    const byAccount = Boolean(req.user && req.user.role === 'admin');
    res.json({
      enabled: adminAuth.adminEnabled(),
      authenticated,
      method: authenticated ? (byAccount ? 'account' : 'token') : null,
      username: byAccount ? req.user.username : null,
      tokenEnabled: adminAuth.tokenEnabled(),
    });
  });

  app.post('/api/admin/login', json, (req, res) => {
    if (!adminAuth.tokenEnabled()) {
      return res.status(503).json({ error: 'Token sign-in is disabled. Sign in with an admin account instead.' });
    }
    if (adminAuth.tooManyAttempts(req)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const supplied = String((req.body && req.body.token) || '');
    const configured = String(process.env.ADMIN_TOKEN || '');
    const a = Buffer.from(supplied);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Incorrect admin token.' });
    }
    adminAuth.clearAttempts(req);
    adminAuth.setCookie(res, adminAuth.issue());
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    adminAuth.clearCookie(res);
    res.json({ ok: true });
  });

  // Everything below this line requires a valid admin cookie.
  app.use('/api/admin', adminAuth.requireAdmin);

  app.get('/api/admin/overview', asyncRoute(async (req, res) => {
    const counts = {};
    for (const table of Object.keys(TABLE_KEYS)) {
      try { counts[table] = await db.adminCount(table); }
      catch { counts[table] = null; }
    }
    let journal = null;
    try { journal = await db.journalStats(); } catch { journal = null; }
    let discord = null;
    try { discord = getStorage().stats ? getStorage().stats() : null; } catch { discord = null; }
    res.json({
      ok: true,
      backend: db.backend || 'unknown',
      storage: config.discord.transport,
      runtime: runtimeFlags.get(),
      config: {
        maxFileSize: config.maxFileSize,
        maxFileSizeHuman: util.humanSize(config.maxFileSize),
        fileDelivery: config.fileDelivery,
        albumMaxFiles: config.albumMaxFiles,
        sessionTtlDays: Math.round(config.sessionTtlMs / 86400000),
        rateLimit: config.rateLimit,
        blockedExtensions: config.blockedExtensions,
      },
      counts,
      journal,
      discord,
    });
  }));

  app.get('/api/admin/health', asyncRoute(async (req, res) => res.json(await health())));

  app.get('/api/admin/runtime', (req, res) => res.json(runtimeFlags.get()));
  app.patch('/api/admin/runtime', json, (req, res) => {
    res.json(runtimeFlags.set(req.body || {}));
  });

  app.get('/api/admin/tables/:table', asyncRoute(async (req, res) => {
    const table = req.params.table;
    if (!TABLE_KEYS[table]) return res.status(400).json({ error: 'Unsupported table.' });
    const options = { q: req.query.q, limit: req.query.limit, offset: req.query.offset };
    const rows = await db.adminQuery(table, options);
    const total = await db.adminCount(table, { q: req.query.q });
    res.json({
      table,
      rows: rows.map(row => cleanRow(table, row)),
      total,
      key: TABLE_KEYS[table],
      editable: PATCHABLE[table] || [],
    });
  }));

  app.patch('/api/admin/tables/:table', json, asyncRoute(async (req, res) => {
    const table = req.params.table;
    if (!TABLE_KEYS[table]) return res.status(400).json({ error: 'Unsupported table.' });
    const patch = sanitizePatch(table, req.body && req.body.patch);
    const value = req.body && req.body.value;
    if (value === undefined || value === null || value === '') return res.status(400).json({ error: 'A row key is required.' });
    const ok = await db.adminUpdate(table, TABLE_KEYS[table], value, patch);
    res.json({ ok, table, value, patch });
  }));

  app.delete('/api/admin/tables/:table', json, asyncRoute(async (req, res) => {
    const table = req.params.table;
    if (!TABLE_KEYS[table]) return res.status(400).json({ error: 'Unsupported table.' });
    const value = req.body && req.body.value;
    if (value === undefined || value === null || value === '') return res.status(400).json({ error: 'A row key is required.' });
    if (table === 'files') return res.json(await purgeFiles([value]));
    const ok = await db.adminDelete(table, TABLE_KEYS[table], value);
    res.json({ ok, table, value });
  }));

  app.post('/api/admin/files/delete', json, asyncRoute(async (req, res) => {
    const names = req.body && (Array.isArray(req.body.names) ? req.body.names : req.body.name ? [req.body.name] : []);
    if (!names || !names.length) return res.status(400).json({ error: 'No files selected.' });
    res.json(await purgeFiles(names));
  }));

  app.post('/api/admin/users/delete', json, asyncRoute(async (req, res) => {
    const id = req.body && req.body.id;
    if (id === undefined || id === null || id === '') return res.status(400).json({ error: 'A user id is required.' });
    const user = await db.findUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const fileRows = await db.adminQuery('files', { where: { owner_hash: user.userhash }, limit: 200 });
    const purged = await purgeFiles(fileRows.map(row => row.name));
    const albums = await db.adminQuery('albums', { where: { owner_hash: user.userhash }, limit: 200 });
    for (const album of albums) await db.deleteAlbum(album.short);
    const sessions = await db.adminQuery('sessions', { where: { user_id: id }, limit: 200 });
    for (const session of sessions) await db.adminDelete('sessions', 'token', session.token);
    await db.adminDelete('users', 'id', id);
    res.json({ ok: true, user: user.username, purged, albums: albums.length, sessions: sessions.length });
  }));

  app.post('/api/admin/jobs/:id/requeue', asyncRoute(async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    await db.requeueJob(req.params.id);
    res.json({ ok: true, job_id: req.params.id, status: 'queued' });
  }));

  app.post('/api/admin/jobs/:id/fail', json, asyncRoute(async (req, res) => {
    const job = await db.failJob(req.params.id, String((req.body && req.body.error) || 'Marked failed by operator.').slice(0, 500));
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ ok: true, job });
  }));

  app.post('/api/admin/journal/:id/resolve', asyncRoute(async (req, res) => {
    await db.resolveJournal(req.params.id);
    res.json({ ok: true, id: req.params.id });
  }));

  app.post('/api/admin/journal/reconcile', asyncRoute(async (req, res) => {
    await jobs.reconcileJournal({ force: true });
    res.json({ ok: true });
  }));
}

module.exports = { register, purgeFiles, TABLE_KEYS };
