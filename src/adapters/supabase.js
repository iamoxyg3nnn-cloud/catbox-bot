'use strict';

// Supabase/Postgres metadata adapter. Implements the same function surface as
// src/db.js using PostgREST over fetch, so no additional npm package is needed.
// Selected by setting SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
//
// IMPORTANT: this is metadata only. Byte storage stays in Discord.

const crypto = require('crypto');

function settings() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  return { base: `${url.replace(/\/$/, '')}/rest/v1`, key };
}

function headers(prefer) {
  const { key } = settings();
  const h = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

async function request(method, resource, { query, body, prefer } = {}) {
  const { base } = settings();
  const url = `${base}/${resource}${query ? `?${query}` : ''}`;
  const response = await fetch(url, {
    method,
    headers: headers(prefer),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${method} ${resource} failed (${response.status}): ${text.slice(0, 300)}`);
  if (!text) return [];
  try { return JSON.parse(text); } catch { return []; }
}

function q(params = {}) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      out.set(key, `(${value.map(v => `"${String(v).replace(/"/g, '')}"`).join(',')})`);
    } else {
      out.set(key, String(value));
    }
  }
  return out.toString();
}

const select = (table, params) => request('GET', table, { query: q(params) });
const insert = (table, row) => request('POST', table, { body: row, prefer: 'return=representation' });
const upsert = (table, row) => request('POST', table, {
  body: row,
  prefer: 'return=representation,resolution=merge-duplicates',
});
const patch = (table, params, row) => request('PATCH', table, { query: q(params), body: row, prefer: 'return=representation' });
const remove = (table, params) => request('DELETE', table, { query: q(params), prefer: 'return=representation' });
const first = async (table, params) => (await select(table, params))[0] || null;

function aliveFilter(now = Date.now()) {
  // PostgREST OR syntax; encoded once by q() via a raw marker below.
  return `or=(expires_at.is.null,expires_at.gt.${now})`;
}

async function rawSelect(table, queryString) {
  return request('GET', table, { query: queryString });
}

/* ---------------- users ---------------- */

async function createUser(username, email, passwordHash, userhash, role = 'user') {
  const rows = await insert('users', {
    username, email, password_hash: passwordHash, userhash, created_at: Date.now(),
    role: role === 'admin' ? 'admin' : 'user',
  });
  return Number(rows[0].id);
}

const findUserByName = username => first('users', { username: `eq.${username}`, limit: 1 });
const findUserByEmail = email => first('users', { email: `eq.${email}`, limit: 1 });
const findUserByHash = userhash => userhash ? first('users', { userhash: `eq.${userhash}`, limit: 1 }) : null;
const findUserById = id => first('users', { id: `eq.${id}`, limit: 1 });

async function setUserRole(userId, role) {
  await patch('users', { id: `eq.${userId}` }, { role: role === 'admin' ? 'admin' : 'user' });
}

async function setPassword(userId, passwordHash) {
  await patch('users', { id: `eq.${userId}` }, { password_hash: passwordHash });
}

/* ---------------- sessions ---------------- */

async function createSession(userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  await insert('sessions', { token, user_id: userId, expires_at: expiresAt });
  return { token, expiresAt };
}

async function getSession(token) {
  if (!token) return null;
  const row = await first('sessions', { token: `eq.${token}`, limit: 1 });
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) { await destroySession(token); return null; }
  return row;
}

const destroySession = token => remove('sessions', { token: `eq.${token}` });

/* ---------------- files ---------------- */

async function recordFile({
  name, ownerHash, originalName, mime, size, sha256, expiresAt,
  botId, channelId, messageId, attachmentId, cdnUrl, cdnExpiresAt, status = 'ready',
}) {
  // Idempotent replay after a lost acknowledgement; see src/db.js.
  await upsert('files', {
    name,
    owner_hash: ownerHash || null,
    original_name: originalName,
    mime,
    size,
    sha256: sha256 || null,
    uploaded_at: Date.now(),
    expires_at: expiresAt || null,
    bot_id: botId || null,
    channel_id: channelId || null,
    message_id: messageId || null,
    attachment_id: attachmentId || null,
    cdn_url: cdnUrl || null,
    cdn_expires_at: cdnExpiresAt || null,
    status,
  });
}

const getFile = name => first('files', { name: `eq.${name}`, limit: 1 });

async function filesByOwner(ownerHash) {
  return rawSelect('files', `owner_hash=eq.${encodeURIComponent(ownerHash)}&${aliveFilter()}&order=uploaded_at.desc`);
}

async function deleteFilesOwnedBy(names, ownerHash) {
  let removed = 0;
  for (const name of names) {
    const rows = await remove('files', {
      name: `eq.${name}`,
      owner_hash: `eq.${ownerHash}`,
    });
    if (rows.length) {
      removed += rows.length;
      await remove('album_files', { file_name: `eq.${name}` });
    }
  }
  return removed;
}

async function expiredFiles() {
  return rawSelect('files', `expires_at=lte.${Date.now()}`);
}

async function deleteFileRows(names) {
  if (!names.length) return 0;
  // PostgREST `in` values must be a parenthesised, comma-separated list.
  const values = `(${names.map(n => `"${String(n).replace(/"/g, '')}"`).join(',')})`;
  const rows = await remove('files', { name: `in.${values}` });
  await remove('album_files', { file_name: `in.${values}` });
  return rows.length;
}

const purgeExpiredFiles = async () => deleteFileRows((await expiredFiles()).map(f => f.name));

/* ---------------- albums ---------------- */

async function createAlbum({ short, ownerHash, title, description }) {
  await insert('albums', {
    short, owner_hash: ownerHash || null, title, description: description || '', created_at: Date.now(),
  });
}

const getAlbum = short => first('albums', { short: `eq.${short}`, limit: 1 });

async function deleteAlbum(short) {
  await remove('album_files', { album_short: `eq.${short}` });
  await remove('albums', { short: `eq.${short}` });
}

async function setAlbumMeta(short, title, description) {
  await patch('albums', { short: `eq.${short}` }, { title, description });
}

async function albumFileNames(short) {
  const rows = await rawSelect('album_files', `album_short=eq.${encodeURIComponent(short)}&order=position.asc`);
  return rows.map(r => r.file_name);
}

async function albumFiles(short) {
  const links = await rawSelect(
    'album_files',
    `select=files(*)&album_short=eq.${encodeURIComponent(short)}&order=position.asc`
  );
  const now = Date.now();
  return links
    .map(link => link.files)
    .filter(file => file && (!file.expires_at || Number(file.expires_at) > now));
}

async function setAlbumFiles(short, names) {
  await remove('album_files', { album_short: `eq.${short}` });
  let pos = 0;
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!await getFile(name)) continue;
    await insert('album_files', { album_short: short, file_name: name, position: pos++ });
  }
  return pos;
}

async function addToAlbum(short, names) {
  let added = 0;
  for (const name of names) {
    const existing = await first('album_files', { album_short: `eq.${short}`, file_name: `eq.${name}`, limit: 1 });
    if (existing || !await getFile(name)) continue;
    const rows = await rawSelect('album_files', `album_short=eq.${encodeURIComponent(short)}&order=position.desc&limit=1`);
    await insert('album_files', { album_short: short, file_name: name, position: rows.length ? Number(rows[0].position) + 1 : 0 });
    added++;
  }
  return added;
}

async function removeFromAlbum(short, names) {
  let removed = 0;
  for (const name of names) {
    const rows = await remove('album_files', { album_short: `eq.${short}`, file_name: `eq.${name}` });
    removed += rows.length;
  }
  return removed;
}

async function albumCount(short) {
  const rows = await select('album_files', { album_short: `eq.${short}`, select: 'file_name' });
  return rows.length;
}

const albumsByOwner = ownerHash => rawSelect('albums', `owner_hash=eq.${encodeURIComponent(ownerHash)}&order=created_at.desc`);

/* ---------------- messages ---------------- */

async function addMessage(name, email, body) {
  await insert('messages', { name, email: email || null, body, created_at: Date.now() });
}

/* ---------------- jobs ---------------- */

async function createJob(job) {
  const now = Date.now();
  await insert('upload_jobs', {
    job_id: job.jobId,
    node_id: job.nodeId || 'local',
    staged_path: job.stagedPath,
    owner_hash: job.ownerHash || null,
    original_name: job.originalName,
    mime: job.mime,
    size: job.size,
    expires_at: job.expiresAt || null,
    status: 'queued',
    attempts: 0,
    created_at: now,
    updated_at: now,
  });
  return getJob(job.jobId);
}

const getJob = jobId => first('upload_jobs', { job_id: `eq.${jobId}`, limit: 1 });

// Atomic claim provided by the claim_upload_job() RPC in infra/supabase/schema.sql.
async function claimJob() {
  const rows = await request('POST', 'rpc/claim_upload_job', { body: {} });
  return rows[0] || null;
}

async function finishJob(jobId, { name, botId, channelId, error }) {
  const job = await getJob(jobId);
  // A job row can be removed while a worker is finishing; do not crash there.
  if (!job) return null;
  const backoffMs = Math.min(30_000, 1000 * 2 ** Math.max(0, Number(job.attempts) - 1));
  const status = error ? (Number(job.attempts) >= 3 ? 'failed' : 'queued') : 'ready';
  const rows = await patch('upload_jobs', { job_id: `eq.${jobId}` }, {
    status,
    file_name: name || null,
    bot_id: botId || null,
    channel_id: channelId || null,
    last_error: error || null,
    updated_at: Date.now() + (status === 'queued' ? backoffMs : 0),
  });
  return rows[0] || null;
}

async function staleJobs(olderThanMs) {
  return rawSelect('upload_jobs', `status=eq.uploading&updated_at=lte.${Date.now() - olderThanMs}`);
}

async function requeueJob(jobId) {
  await patch('upload_jobs', { job_id: `eq.${jobId}` }, { status: 'queued', updated_at: Date.now() });
}

// Terminal failure for cases where a retry cannot help (missing staged body).
async function failJob(jobId, error) {
  const rows = await patch('upload_jobs', { job_id: `eq.${jobId}` }, {
    status: 'failed',
    last_error: error || 'Upload failed.',
    updated_at: Date.now(),
  });
  return rows[0] || null;
}

async function activeStagedPaths() {
  const rows = await rawSelect('upload_jobs', 'status=in.(queued,uploading)&select=staged_path');
  return rows.map(row => row.staged_path).filter(Boolean);
}

/* ---------------- nodes ---------------- */

async function upsertNode({
  nodeId, hostname, webUrl, pending = 0, active = 0,
  draining = 0, status = 'up', stagedBytes = 0, stagedFiles = 0,
}) {
  await upsert('nodes', {
    node_id: nodeId,
    hostname: hostname || nodeId,
    web_url: webUrl || '',
    status,
    pending,
    active,
    // Postgres column is boolean; the control plane sends 0/1 for SQLite.
    draining: Boolean(draining),
    staged_bytes: stagedBytes,
    staged_files: stagedFiles,
    last_heartbeat: Date.now(),
  });
  return getNode(nodeId);
}

const getNode = nodeId => first('nodes', { node_id: `eq.${nodeId}`, limit: 1 });
const listNodes = () => rawSelect('nodes', 'order=node_id.asc');

/* ---------------- upload journal ---------------- */

async function addJournal(entry) {
  await insert('upload_journal', {
    job_id: entry.jobId || '',
    file_name: entry.fileName || null,
    stage: entry.stage || 'metadata',
    error: entry.error || null,
    metadata: entry.metadata || null,
    attempts: entry.attempts || 0,
    resolved: false,
    created_at: Date.now(),
  });
}

function unresolvedJournal(olderThanMs = 0) {
  return rawSelect(
    'upload_journal',
    `resolved=eq.false&created_at=lte.${Date.now() - olderThanMs}&order=id.asc`
  );
}

const resolveJournal = id => patch('upload_journal', { id: `eq.${id}` }, { resolved: true });

async function journalStats() {
  const all = await rawSelect('upload_journal', 'resolved=eq.false&select=created_at');
  const cutoff = Date.now() - 60_000;
  return {
    unresolved: all.length,
    due: all.filter(row => Number(row.created_at) <= cutoff).length,
  };
}

/* ---------------- admin (whitelisted generic access) ---------------- */

const ADMIN_TABLES = new Set([
  'users', 'sessions', 'files', 'albums', 'album_files', 'messages',
  'upload_jobs', 'discord_bots', 'nodes', 'upload_journal',
]);
const ADMIN_SEARCH = {
  users: ['username', 'email', 'userhash'],
  sessions: ['token'],
  files: ['name', 'original_name', 'owner_hash', 'sha256', 'status'],
  albums: ['short', 'title', 'description', 'owner_hash'],
  album_files: ['album_short', 'file_name'],
  messages: ['name', 'email', 'body'],
  upload_jobs: ['job_id', 'node_id', 'file_name', 'original_name', 'status', 'last_error'],
  discord_bots: ['bot_id', 'channel_id', 'health'],
  nodes: ['node_id', 'hostname', 'web_url', 'status'],
  upload_journal: ['job_id', 'file_name', 'stage', 'error'],
};
const ADMIN_ORDER = {
  users: 'id', sessions: 'expires_at', files: 'uploaded_at', albums: 'created_at',
  album_files: 'album_short', messages: 'created_at', upload_jobs: 'created_at',
  discord_bots: 'bot_id', nodes: 'node_id', upload_journal: 'id',
};

function adminCheck(table) {
  if (!ADMIN_TABLES.has(table)) throw new Error('Unsupported admin table');
}

function adminFilter(table, options = {}) {
  const clauses = [];
  const params = new URLSearchParams();
  const search = String(options.q || '').replace(/[*%_,]/g, '').slice(0, 120);
  const columns = ADMIN_SEARCH[table] || [];
  if (search && columns.length) {
    // A search term matches ANY allow-listed column, so the inner expression
    // must be an OR; the outer AND combines it with exact-match filters.
    clauses.push(`or(${columns.map(col => `${col}.ilike.%${search}%`).join(',')})`);
  }
  const where = options.where && typeof options.where === 'object' ? options.where : {};
  for (const [key, value] of Object.entries(where)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) continue;
    clauses.push(value === null || value === undefined ? `${key}.is.null` : `${key}.eq.${value}`);
  }
  // PostgREST requires the whole expression to be wrapped once. Bare
  // `and=foo.eq.1` is parsed as a column named "andfoo" instead of a filter.
  if (clauses.length) params.set('and', `(${clauses.join(',')})`);
  return params;
}

async function adminCount(table, options = {}) {
  adminCheck(table);
  const params = adminFilter(table, options);
  params.set('select', '*');
  const rows = await rawSelect(table, params.toString());
  return rows.length;
}

async function adminQuery(table, options = {}) {
  adminCheck(table);
  const params = adminFilter(table, options);
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  params.set('select', '*');
  params.set('order', `${ADMIN_ORDER[table] || 'id'}.desc`);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return rawSelect(table, params.toString());
}

async function adminDelete(table, key, value) {
  adminCheck(table);
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error('Invalid admin target');
  const rows = await remove(table, { [key]: `eq.${value}` });
  return Array.isArray(rows) && rows.length > 0;
}

async function adminUpdate(table, key, value, patchData) {
  adminCheck(table);
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error('Invalid admin target');
  const entries = Object.entries(patchData || {});
  if (!entries.length) return null;
  for (const [field] of entries) {
    if (!/^[a-z_][a-z0-9_]*$/.test(field)) throw new Error('Invalid admin field');
  }
  const rows = await patch(table, { [key]: `eq.${value}` }, Object.fromEntries(entries));
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = {
  getDb: () => null,
  closeDb: async () => {},
  createUser, findUserByName, findUserByEmail, findUserByHash, findUserById, setUserRole, setPassword,
  createSession, getSession, destroySession,
  recordFile, getFile, filesByOwner, deleteFilesOwnedBy,
  expiredFiles, deleteFileRows, purgeExpiredFiles,
  createAlbum, getAlbum, deleteAlbum, setAlbumMeta, albumFileNames, albumFiles,
  setAlbumFiles, addToAlbum, removeFromAlbum, albumCount, albumsByOwner,
  addMessage,
  createJob, getJob, claimJob, finishJob, failJob, staleJobs, requeueJob, activeStagedPaths,
  upsertNode, getNode, listNodes,
  addJournal, unresolvedJournal, resolveJournal, journalStats,
  adminQuery, adminCount, adminDelete, adminUpdate,
};
