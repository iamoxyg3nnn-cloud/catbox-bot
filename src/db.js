'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(config.tmpDir, { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      userhash      TEXT NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      name           TEXT PRIMARY KEY,
      owner_hash     TEXT,
      original_name  TEXT NOT NULL,
      mime           TEXT NOT NULL,
      size           INTEGER NOT NULL,
      sha256         TEXT,
      uploaded_at    INTEGER NOT NULL,
      expires_at     INTEGER,
      bot_id         TEXT,
      channel_id     TEXT,
      message_id     TEXT,
      attachment_id  TEXT,
      cdn_url        TEXT,
      cdn_expires_at INTEGER,
      status         TEXT NOT NULL DEFAULT 'ready'
    );
    CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_hash);

    CREATE TABLE IF NOT EXISTS albums (
      short       TEXT PRIMARY KEY,
      owner_hash  TEXT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS album_files (
      album_short TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      position    INTEGER NOT NULL,
      PRIMARY KEY (album_short, file_name)
    );
    CREATE INDEX IF NOT EXISTS idx_album_files ON album_files(album_short, position);

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upload_jobs (
      job_id        TEXT PRIMARY KEY,
      node_id       TEXT NOT NULL,
      bot_id        TEXT,
      channel_id    TEXT,
      staged_path   TEXT NOT NULL,
      owner_hash    TEXT,
      original_name TEXT NOT NULL,
      mime          TEXT NOT NULL,
      size          INTEGER NOT NULL,
      expires_at    INTEGER,
      status        TEXT NOT NULL DEFAULT 'queued',
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      file_name     TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON upload_jobs(status);

    CREATE TABLE IF NOT EXISTS nodes (
      node_id        TEXT PRIMARY KEY,
      hostname       TEXT NOT NULL,
      web_url        TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'up',
      pending        INTEGER NOT NULL DEFAULT 0,
      active         INTEGER NOT NULL DEFAULT 0,
      draining       INTEGER NOT NULL DEFAULT 0,
      staged_bytes   INTEGER NOT NULL DEFAULT 0,
      staged_files   INTEGER NOT NULL DEFAULT 0,
      last_heartbeat INTEGER
    );

    CREATE TABLE IF NOT EXISTS upload_journal (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     TEXT NOT NULL,
      file_name  TEXT,
      stage      TEXT NOT NULL,
      error      TEXT,
      metadata   TEXT,
      attempts   INTEGER NOT NULL DEFAULT 0,
      resolved   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_unresolved
      ON upload_journal(resolved);
  `);
  migrateFilesTable();
  migrateNodesTable();
  return db;
}

// Existing installs only have the original columns. Add Discord metadata
// columns in place so upgrades do not lose file records.
function migrateFilesTable() {
  const columns = new Set(
    db.prepare('PRAGMA table_info(files)').all().map(row => row.name)
  );
  const additions = {
    sha256: 'TEXT',
    bot_id: 'TEXT',
    channel_id: 'TEXT',
    message_id: 'TEXT',
    attachment_id: 'TEXT',
    cdn_url: 'TEXT',
    cdn_expires_at: 'INTEGER',
    status: "TEXT NOT NULL DEFAULT 'ready'",
  };
  for (const [name, type] of Object.entries(additions)) {
    if (!columns.has(name)) db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
  }
}

// Add staging-usage columns to node tables created by older builds.
function migrateNodesTable() {
  const columns = new Set(
    db.prepare('PRAGMA table_info(nodes)').all().map(row => row.name)
  );
  if (!columns.has('staged_bytes')) db.exec('ALTER TABLE nodes ADD COLUMN staged_bytes INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('staged_files')) db.exec('ALTER TABLE nodes ADD COLUMN staged_files INTEGER NOT NULL DEFAULT 0');
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

/* ---------------- users ---------------- */

function createUser(username, email, passwordHash, userhash) {
  const r = getDb().prepare(
    'INSERT INTO users (username, email, password_hash, userhash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(username, email, passwordHash, userhash, Date.now());
  return Number(r.lastInsertRowid);
}

function findUserByName(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function findUserByHash(userhash) {
  if (!userhash) return null;
  return getDb().prepare('SELECT * FROM users WHERE userhash = ?').get(userhash);
}

function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function setPassword(userId, passwordHash) {
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

/* ---------------- sessions ---------------- */

function createSession(userId, ttlMs) {
  const token = require('crypto').randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  getDb().prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expiresAt);
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const s = getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) { destroySession(token); return null; }
  return s;
}

function destroySession(token) {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* ---------------- files ---------------- */

function recordFile({
  name, ownerHash, originalName, mime, size, sha256, expiresAt,
  botId, channelId, messageId, attachmentId, cdnUrl, cdnExpiresAt, status = 'ready',
}) {
  // Idempotent: a node may replay metadata after a lost acknowledgement. If the
  // row already exists the first write won, so keep it and do not throw.
  getDb().prepare(
    `INSERT OR IGNORE INTO files
      (name, owner_hash, original_name, mime, size, sha256, uploaded_at, expires_at,
       bot_id, channel_id, message_id, attachment_id, cdn_url, cdn_expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, ownerHash || null, originalName, mime, size, sha256 || null, Date.now(), expiresAt || null,
    botId || null, channelId || null, messageId || null, attachmentId || null,
    cdnUrl || null, cdnExpiresAt || null, status
  );
}

function getFile(name) {
  return getDb().prepare('SELECT * FROM files WHERE name = ?').get(name);
}

function filesByOwner(ownerHash) {
  return getDb().prepare(
    'SELECT * FROM files WHERE owner_hash = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY uploaded_at DESC'
  ).all(ownerHash, Date.now());
}

// Deletes rows for the given names that belong to ownerHash.
// Returns the number of rows actually removed.
function deleteFilesOwnedBy(names, ownerHash) {
  const d = getDb();
  const stmt = d.prepare('DELETE FROM files WHERE name = ? AND owner_hash = ?');
  const albumLink = d.prepare('DELETE FROM album_files WHERE file_name = ?');
  let removed = 0;
  for (const name of names) {
    const r = stmt.run(name, ownerHash);
    if (r.changes > 0) { removed += r.changes; albumLink.run(name); }
  }
  return removed;
}

// Rows whose temporary lifetime has ended. Discord message deletion is the
// caller's responsibility; the database layer never touches byte storage.
function expiredFiles() {
  return getDb().prepare(
    'SELECT * FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?'
  ).all(Date.now());
}

// Delete metadata rows only. Used after storage.remove() has succeeded.
function deleteFileRows(names) {
  const d = getDb();
  const delFile = d.prepare('DELETE FROM files WHERE name = ?');
  const delAlbum = d.prepare('DELETE FROM album_files WHERE file_name = ?');
  let removed = 0;
  for (const name of names) {
    removed += delFile.run(name).changes;
    delAlbum.run(name);
  }
  return removed;
}

// Backwards-compatible helper: strips expired metadata without touching disk.
function purgeExpiredFiles() {
  return deleteFileRows(expiredFiles().map(f => f.name));
}

/* ---------------- albums ---------------- */

function createAlbum({ short, ownerHash, title, description }) {
  getDb().prepare('INSERT INTO albums (short, owner_hash, title, description, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(short, ownerHash || null, title, description || '', Date.now());
}

function getAlbum(short) {
  return getDb().prepare('SELECT * FROM albums WHERE short = ?').get(short);
}

function deleteAlbum(short) {
  getDb().prepare('DELETE FROM album_files WHERE album_short = ?').run(short);
  getDb().prepare('DELETE FROM albums WHERE short = ?').run(short);
}

function setAlbumMeta(short, title, description) {
  getDb().prepare('UPDATE albums SET title = ?, description = ? WHERE short = ?')
    .run(title, description, short);
}

function albumFileNames(short) {
  return getDb().prepare('SELECT file_name FROM album_files WHERE album_short = ? ORDER BY position')
    .all(short).map(r => r.file_name);
}

// Full file rows for an album, ordered.
function albumFiles(short) {
  return getDb().prepare(
    `SELECT f.* FROM album_files af
     JOIN files f ON f.name = af.file_name
     WHERE af.album_short = ?
       AND (f.expires_at IS NULL OR f.expires_at > ?)
     ORDER BY af.position`
  ).all(short, Date.now());
}

// Replaces the album's file membership with the given ordered list.
// Only names that actually exist on the host are kept; duplicates are dropped.
function setAlbumFiles(short, names) {
  const d = getDb();
  const exists = d.prepare('SELECT 1 FROM files WHERE name = ?');
  d.prepare('DELETE FROM album_files WHERE album_short = ?').run(short);
  const insert = d.prepare('INSERT OR IGNORE INTO album_files (album_short, file_name, position) VALUES (?, ?, ?)');
  let pos = 0;
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (!exists.get(n)) continue;
    insert.run(short, n, pos++);
  }
  return pos;
}

function addToAlbum(short, names) {
  const d = getDb();
  const exists = d.prepare('SELECT 1 FROM files WHERE name = ?');
  const present = d.prepare('SELECT 1 FROM album_files WHERE album_short = ? AND file_name = ?');
  const maxRow = d.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM album_files WHERE album_short = ?').get(short);
  let pos = maxRow.m + 1;
  const insert = d.prepare('INSERT OR IGNORE INTO album_files (album_short, file_name, position) VALUES (?, ?, ?)');
  let added = 0;
  for (const n of names) {
    if (present.get(short, n)) continue;
    if (!exists.get(n)) continue;
    insert.run(short, n, pos++);
    added++;
  }
  return added;
}

function removeFromAlbum(short, names) {
  const d = getDb();
  const del = d.prepare('DELETE FROM album_files WHERE album_short = ? AND file_name = ?');
  let removed = 0;
  for (const n of names) removed += del.run(short, n).changes;
  return removed;
}

function albumCount(short) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM album_files WHERE album_short = ?').get(short).c;
}

function albumsByOwner(ownerHash) {
  return getDb().prepare('SELECT * FROM albums WHERE owner_hash = ? ORDER BY created_at DESC').all(ownerHash);
}

/* ---------------- messages ---------------- */

function addMessage(name, email, body) {
  getDb().prepare('INSERT INTO messages (name, email, body, created_at) VALUES (?, ?, ?, ?)')
    .run(name, email, body, Date.now());
}

/* ---------------- nodes ---------------- */

function upsertNode({
  nodeId, hostname, webUrl, pending = 0, active = 0,
  draining = 0, status = 'up', stagedBytes = 0, stagedFiles = 0,
}) {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO nodes (node_id, hostname, web_url, status, pending, active,
                        draining, staged_bytes, staged_files, last_heartbeat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       hostname = excluded.hostname, web_url = excluded.web_url,
       status = excluded.status, pending = excluded.pending,
       active = excluded.active, draining = excluded.draining,
       staged_bytes = excluded.staged_bytes, staged_files = excluded.staged_files,
       last_heartbeat = excluded.last_heartbeat`
  ).run(
    nodeId, hostname || nodeId, webUrl || '', status, pending, active, draining,
    stagedBytes, stagedFiles, now
  );
  return getNode(nodeId);
}

function getNode(nodeId) {
  return getDb().prepare('SELECT * FROM nodes WHERE node_id = ?').get(nodeId);
}

function listNodes() {
  return getDb().prepare('SELECT * FROM nodes ORDER BY node_id').all();
}

/* ---------------- upload jobs ---------------- */

function createJob(job) {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO upload_jobs
      (job_id, node_id, staged_path, owner_hash, original_name, mime, size,
       expires_at, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`
  ).run(
    job.jobId, job.nodeId || 'local', job.stagedPath, job.ownerHash || null,
    job.originalName, job.mime, job.size, job.expiresAt || null, now, now
  );
  return getJob(job.jobId);
}

function getJob(jobId) {
  return getDb().prepare('SELECT * FROM upload_jobs WHERE job_id = ?').get(jobId);
}

// Atomically claim one queued job for this process.
function claimJob() {
  const d = getDb();
  const next = d.prepare(
    'SELECT job_id FROM upload_jobs WHERE status = ? AND updated_at <= ? ORDER BY created_at LIMIT 1'
  ).get('queued', Date.now());
  if (!next) return null;
  const changed = d.prepare(
    "UPDATE upload_jobs SET status = 'uploading', attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND status = 'queued'"
  ).run(Date.now(), next.job_id).changes;
  return changed ? getJob(next.job_id) : null;
}

function finishJob(jobId, { name, botId, channelId, error }) {
  const job = getJob(jobId);
  if (!job) return null; // row removed while the worker was finishing
  // Exponential backoff for retryable failures; give up after three attempts.
  const backoffMs = Math.min(30_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
  const status = error ? (job.attempts >= 3 ? 'failed' : 'queued') : 'ready';
  const updatedAt = Date.now() + (status === 'queued' ? backoffMs : 0);
  getDb().prepare(
    `UPDATE upload_jobs SET status = ?, file_name = ?, bot_id = ?, channel_id = ?,
     last_error = ?, updated_at = ? WHERE job_id = ?`
  ).run(status, name || null, botId || null, channelId || null, error || null, updatedAt, jobId);
  return getJob(jobId);
}

// Jobs left in 'uploading' by a dead process are safe to retry: the staged file
// is still present and Discord writes are idempotent by message, not by row.
function staleJobs(olderThanMs) {
  return getDb().prepare(
    "SELECT * FROM upload_jobs WHERE status = 'uploading' AND updated_at <= ?"
  ).all(Date.now() - olderThanMs);
}

function requeueJob(jobId) {
  getDb().prepare(
    "UPDATE upload_jobs SET status = 'queued', updated_at = ? WHERE job_id = ?"
  ).run(Date.now(), jobId);
}

/* ---------------- upload journal ---------------- */
// Records "Discord succeeded but metadata failed" events so a sweep can
// reconcile them: record the file metadata, or delete the orphan message.

function addJournal(entry) {
  getDb().prepare(
    `INSERT INTO upload_journal (job_id, file_name, stage, error, metadata, attempts, resolved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    entry.jobId || '', entry.fileName || null, entry.stage || 'metadata',
    entry.error || null, entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.attempts || 0, Date.now()
  );
}

function unresolvedJournal(olderThanMs = 0) {
  return getDb().prepare(
    'SELECT * FROM upload_journal WHERE resolved = 0 AND created_at <= ? ORDER BY id'
  ).all(Date.now() - olderThanMs);
}

function resolveJournal(id) {
  getDb().prepare('UPDATE upload_journal SET resolved = 1 WHERE id = ?').run(id);
}

function journalStats() {
  return getDb().prepare(
    `SELECT COUNT(*) AS unresolved,
            COALESCE(SUM(CASE WHEN created_at <= ? THEN 1 ELSE 0 END), 0) AS due
     FROM upload_journal WHERE resolved = 0`
  ).get(Date.now() - 60_000);
}

module.exports = {
  getDb, closeDb,
  createUser, findUserByName, findUserByEmail, findUserByHash, findUserById, setPassword,
  createSession, getSession, destroySession,
  recordFile, getFile, filesByOwner, deleteFilesOwnedBy,
  expiredFiles, deleteFileRows, purgeExpiredFiles,
  createAlbum, getAlbum, deleteAlbum, setAlbumMeta, albumFileNames, albumFiles,
  setAlbumFiles, addToAlbum, removeFromAlbum, albumCount, albumsByOwner,
  addMessage,
  createJob, getJob, claimJob, finishJob, staleJobs, requeueJob,
  upsertNode, getNode, listNodes,
  addJournal, unresolvedJournal, resolveJournal, journalStats,
};
