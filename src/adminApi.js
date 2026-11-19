'use strict';

// Operator API behind the /admin console. Every request is origin-checked,
// authenticated and (for mutations) CSRF-protected. Rows are limited to fixed
// table/key/field allow-lists. File deletion purges Discord bytes before
// metadata so a failed purge leaves a recoverable row.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./dbAdapter');
const adminAuth = require('./adminAuth');
const adminSecurity = require('./adminSecurity');
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

function safeError(err) {
  const message = String((err && err.message) || err || 'Action failed.');
  return message.length > 300 ? message.slice(0, 300) + '…' : message;
}

function record(req, action, detail = {}) {
  return adminSecurity.audit(req, action, detail);
}

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
      result.failed.push({ name, error: `lookup: ${safeError(err)}` });
      continue;
    }
    if (!row) {
      result.deleted.push(name); // already gone; treat as idempotent
      continue;
    }
    try {
      if (storage && storage.remove) await storage.remove(row);
    } catch (err) {
      result.failed.push({ name, error: `storage: ${safeError(err)}` });
      continue;
    }
    try {
      await db.deleteFileRows([name]);
      result.deleted.push(name);
    } catch (err) {
      result.failed.push({ name, error: `metadata: ${safeError(err)}` });
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

// Hash the console's inline blocks so a strict CSP can be used without an
// external build step. The file is static, so cache the result.
let consolePage = null;
function consoleAsset() {
  if (consolePage) return consolePage;
  const file = path.join(__dirname, '..', 'public', 'admin.html');
  const html = fs.readFileSync(file, 'utf8');
  const scriptHashes = [];
  const styleHashes = [];
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    scriptHashes.push(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
  }
  for (const match of html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)) {
    if (!match[1].trim()) continue;
    styleHashes.push(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
  }
  consolePage = { html, scriptHashes, styleHashes };
  return consolePage;
}

// Prevent an operator from removing every administrator, including themselves.
async function lastAdminGuard(req, res, id, action) {
  const admins = await db.adminQuery('users', { limit: 200 });
  const adminRows = admins.filter(row => row.role === 'admin');
  const target = String(id);
  const isTargetAdmin = adminRows.some(row => String(row.id) === target);
  if (isTargetAdmin && adminRows.length <= 1) {
    res.status(409).json({ error: `Cannot ${action} the last administrator.` });
    return true;
  }
  if (action === 'delete' && req.user && String(req.user.id) === target) {
    res.status(409).json({ error: 'You cannot delete your own account from the console.' });
    return true;
  }
  if (action === 'demote' && req.user && String(req.user.id) === target) {
    res.status(409).json({ error: 'You cannot demote your own account from the console.' });
    return true;
  }
  return false;
}

function register(app) {
  const protectedApi = express.Router();
  protectedApi.use(adminSecurity.securityHeaders);
  protectedApi.use(adminSecurity.ipGuard);
  protectedApi.use(adminSecurity.originGuard);
  protectedApi.use(adminAuth.requireAdmin);
  protectedApi.use(adminAuth.requireCsrf);
  // Re-check the database role on every request so a revoked admin loses access
  // immediately even if their signed cookie has not expired yet.
  protectedApi.use(asyncRoute(async (req, res, next) => {
    if (req.user) {
      const fresh = await db.findUserById(req.user.id);
      if (!fresh || fresh.role !== 'admin') {
        return res.status(403).json({ error: 'Administrator role was revoked.' });
      }
    }
    next();
  }));

  // The console itself is served from the API origin so its session cookie is
  // same-origin. Vercel rewrites /admin here (see public/vercel.json).
  app.get('/admin', (req, res) => {
    adminSecurity.securityHeaders(req, res, () => {});
    const { html, scriptHashes, styleHashes } = consoleAsset();
    res.setHeader('Content-Security-Policy', adminSecurity.csp(scriptHashes, styleHashes));
    res.type('html').send(html);
  });

  app.use('/api/admin', adminSecurity.securityHeaders);
  app.use('/api/admin', adminSecurity.ipGuard);

  app.get('/api/admin/status', (req, res) => {
    const authenticated = adminAuth.isAdmin(req);
    const byAccount = Boolean(req.user && req.user.role === 'admin');
    res.json({
      enabled: adminAuth.adminEnabled(),
      authenticated,
      method: authenticated ? (byAccount ? 'account' : 'token') : null,
      username: byAccount ? req.user.username : null,
      tokenEnabled: adminAuth.tokenEnabled(),
      idleMinutes: Math.round(adminAuth.IDLE_MS / 60000),
      mfaConfigured: adminAuth.mfaConfigured(),
      mfaRequired: adminAuth.mfaRequired(),
      mfaSatisfied: adminAuth.mfaSatisfied(req),
      csrf: authenticated ? adminAuth.csrfFor(req) : null,
    });
  });

  app.post('/api/admin/login', adminSecurity.originGuard, json, (req, res) => {
    if (!adminAuth.tokenEnabled()) {
      return res.status(503).json({ error: 'Token sign-in is disabled. Sign in with an admin account instead.' });
    }
    if (adminAuth.tooManyAttempts(req)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    if (!adminAuth.verifyToken(req.body && req.body.token)) {
      adminAuth.recordFailure(req);
      record(req, 'admin.login.failed');
      return res.status(401).json({ error: 'Incorrect admin token.' });
    }
    adminAuth.clearAttempts(req);
    adminAuth.issue(req, res);
    record(req, 'admin.login.success');
    res.json({ ok: true, csrf: adminAuth.csrfFor(req) });
  });

  app.post('/api/admin/logout', adminSecurity.originGuard, (req, res) => {
    record(req, 'admin.logout', { username: req.user && req.user.username });
    adminAuth.clearCookie(res);
    res.json({ ok: true });
  });

  // Optional TOTP step-up. Disabled unless ADMIN_OTP_SECRET is configured.
  app.post('/api/admin/mfa/verify', adminSecurity.originGuard, json, (req, res) => {
    if (!adminAuth.isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
    if (!adminAuth.verifyTotp(req.body && req.body.code)) {
      record(req, 'admin.mfa.failed');
      return res.status(401).json({ error: 'Invalid authenticator code.' });
    }
    adminAuth.markMfa(req, res);
    record(req, 'admin.mfa.success');
    res.json({ ok: true, csrf: adminAuth.csrfFor(req) });
  });

  app.use('/api/admin', protectedApi);

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

  // Purpose-built Jobs view: aggregates that drive the dashboard cards plus a
  // bounded recent queue. Uses the same adapter surface as the rest of the
  // console so it works on both SQLite and Supabase.
  app.get('/api/admin/jobs', asyncRoute(async (req, res) => {
    const stats = db.jobStats ? await db.jobStats(config.uploadRecovery.staleAfterMs) : null;
    const rows = await db.adminQuery('upload_jobs', { limit: 50 });
    const batches = stats && stats.byBatch && stats.byBatch.length
      ? await Promise.all(stats.byBatch.slice(0, 10).map(async batch => ({
        ...batch,
        items: typeof db.jobsByBatch === 'function' ? await db.jobsByBatch(batch.id) : [],
      })))
      : [];
    res.json({
      ok: true,
      stats,
      recent: rows.map(row => cleanRow('upload_jobs', row)),
      batches,
    });
  }));

  app.get('/api/admin/audit', (req, res) => {
    res.json({ ok: true, events: adminSecurity.recentAudit(100), max: adminSecurity.MAX_EVENTS });
  });

  app.get('/api/admin/health', asyncRoute(async (req, res) => res.json(await health())));

  app.get('/api/admin/runtime', (req, res) => res.json(runtimeFlags.get()));
  app.patch('/api/admin/runtime', json, (req, res) => {
    const next = runtimeFlags.set(req.body || {});
    record(req, 'admin.runtime.update', { fields: Object.keys(req.body || {}) });
    res.json(next);
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

    if (table === 'users' && patch.role && patch.role !== 'admin') {
      if (await lastAdminGuard(req, res, value, 'demote')) return;
    }
    // Only an existing admin can elevate another account; prevents a compromised
    // low-privilege session from creating a second administrator via a stale form.
    if (table === 'users' && patch.role === 'admin' && req.user && String(req.user.id) === String(value)) {
      return res.status(409).json({ error: 'Use an existing admin account to elevate others.' });
    }

    const ok = await db.adminUpdate(table, TABLE_KEYS[table], value, patch);
    record(req, 'admin.table.update', { table, value: String(value).slice(0, 120), fields: Object.keys(patch) });
    res.json({ ok, table, value, patch });
  }));

  app.delete('/api/admin/tables/:table', json, asyncRoute(async (req, res) => {
    const table = req.params.table;
    if (!TABLE_KEYS[table]) return res.status(400).json({ error: 'Unsupported table.' });
    const value = req.body && req.body.value;
    if (value === undefined || value === null || value === '') return res.status(400).json({ error: 'A row key is required.' });
    if (table === 'files') {
      const result = await purgeFiles([value]);
      record(req, 'admin.file.delete', { name: String(value).slice(0, 200) });
      return res.json(result);
    }
    if (table === 'users' && await lastAdminGuard(req, res, value, 'delete')) return;
    const ok = await db.adminDelete(table, TABLE_KEYS[table], value);
    record(req, 'admin.table.delete', { table, value: String(value).slice(0, 120) });
    res.json({ ok, table, value });
  }));

  app.post('/api/admin/files/delete', json, asyncRoute(async (req, res) => {
    const names = req.body && (Array.isArray(req.body.names) ? req.body.names : req.body.name ? [req.body.name] : []);
    if (!names || !names.length) return res.status(400).json({ error: 'No files selected.' });
    const result = await purgeFiles(names);
    record(req, 'admin.files.bulk_delete', { count: names.length });
    res.json(result);
  }));

  app.post('/api/admin/users/delete', json, asyncRoute(async (req, res) => {
    const id = req.body && req.body.id;
    if (id === undefined || id === null || id === '') return res.status(400).json({ error: 'A user id is required.' });
    const user = await db.findUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (await lastAdminGuard(req, res, id, 'delete')) return;

    const fileRows = await db.adminQuery('files', { where: { owner_hash: user.userhash }, limit: 200 });
    const purged = await purgeFiles(fileRows.map(row => row.name));
    const albums = await db.adminQuery('albums', { where: { owner_hash: user.userhash }, limit: 200 });
    for (const album of albums) await db.deleteAlbum(album.short);
    const sessions = await db.adminQuery('sessions', { where: { user_id: id }, limit: 200 });
    for (const session of sessions) await db.adminDelete('sessions', 'token', session.token);
    await db.adminDelete('users', 'id', id);
    record(req, 'admin.user.delete', { username: user.username, id: String(id).slice(0, 120) });
    res.json({ ok: true, user: user.username, purged, albums: albums.length, sessions: sessions.length });
  }));

  app.post('/api/admin/jobs/:id/requeue', asyncRoute(async (req, res) => {
    const job = await db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    await db.requeueJob(req.params.id);
    record(req, 'admin.job.requeue', { job: String(req.params.id).slice(0, 120) });
    res.json({ ok: true, job_id: req.params.id, status: 'queued' });
  }));

  app.post('/api/admin/jobs/:id/fail', json, asyncRoute(async (req, res) => {
    const job = await db.failJob(req.params.id, String((req.body && req.body.error) || 'Marked failed by operator.').slice(0, 500));
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    record(req, 'admin.job.fail', { job: String(req.params.id).slice(0, 120) });
    res.json({ ok: true, job });
  }));

  app.post('/api/admin/journal/:id/resolve', asyncRoute(async (req, res) => {
    await db.resolveJournal(req.params.id);
    record(req, 'admin.journal.resolve', { id: String(req.params.id).slice(0, 120) });
    res.json({ ok: true, id: req.params.id });
  }));

  app.post('/api/admin/journal/reconcile', asyncRoute(async (req, res) => {
    await jobs.reconcileJournal({ force: true });
    record(req, 'admin.journal.reconcile');
    res.json({ ok: true });
  }));

  // Structured audit endpoint for the console (process-local ring buffer).
  app.use('/api/admin', (error, _req, res, _next) => {
    console.error('admin api error:', error);
    if (!res.headersSent) res.status(500).json({ error: safeError(error) });
  });
}

module.exports = { register, purgeFiles, TABLE_KEYS };
