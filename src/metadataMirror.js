'use strict';

// Discord-backed metadata mirror.
//
// Supabase runs on an ephemeral GitHub Actions runner. Its own state archive is
// restored by dropping every schema first, so a stale/empty archive looks like
// a healthy but freshly initialised database. Discord is the only durable
// store in this design, so we keep a small encrypted JSON snapshot of the
// metadata there and restore it when the account table comes back empty.
//
// The mirror is deliberately conservative:
//   - it only restores when `users` is empty (there is no account-delete path,
//     so that is a reliable "database was flushed" signal);
//   - it only writes rows into tables that are themselves empty;
//   - it keeps several snapshots and restores the newest non-empty one, so an
//     empty snapshot published during a flush can never destroy the last good
//     copy;
//   - it never overwrites Supabase rows that are already present.

const crypto = require('crypto');
const { config } = require('./config');

const MARKER = 'CATBOX_METADATA_MIRROR_V1';
const KEEP_SNAPSHOTS = 10;
const SNAPSHOT_INTERVAL_MS = 60 * 1000;
const SNAPSHOT_FORMAT = 1;

// Identity columns are intentionally omitted: Postgres generates them, and
// restoring explicit ids would break the sequence. `users.userhash`,
// `files.name`, `albums.short`, etc. are the real stable keys.
const TABLES = [
  { table: 'users', columns: ['username', 'email', 'password_hash', 'userhash', 'created_at'] },
  { table: 'files', columns: ['name', 'owner_hash', 'original_name', 'mime', 'size', 'sha256',
    'uploaded_at', 'expires_at', 'bot_id', 'channel_id', 'message_id', 'attachment_id',
    'cdn_url', 'cdn_expires_at', 'status'] },
  { table: 'albums', columns: ['short', 'owner_hash', 'title', 'description', 'created_at'] },
  { table: 'album_files', columns: ['album_short', 'file_name', 'position'] },
  { table: 'messages', columns: ['name', 'email', 'body', 'created_at'] },
];

let timer = null;
let starting = null;

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null;
}

function discordConfig() {
  const bot = config.discord.bots && config.discord.bots[0];
  return bot && bot.token && bot.channelId ? bot : null;
}

function isConfigured() {
  return Boolean(supabaseConfig() && discordConfig() && process.env.NODE_UPLOAD_SECRET);
}

function log(...args) {
  console.log('[metadata-mirror]', ...args);
}

function warn(...args) {
  console.warn('[metadata-mirror]', ...args);
}

/* ------------------------------- encryption ------------------------------ */

function encryptionKey() {
  return crypto.createHash('sha256').update(String(process.env.NODE_UPLOAD_SECRET)).digest();
}

function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const text = Buffer.from(JSON.stringify(payload), 'utf8');
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return {
    v: SNAPSHOT_FORMAT,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(blob) {
  if (!blob || blob.v !== SNAPSHOT_FORMAT || !blob.iv || !blob.tag || !blob.data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const text = Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(text.toString('utf8'));
    return parsed && parsed.format === SNAPSHOT_FORMAT && parsed.tables ? parsed : null;
  } catch {
    return null;
  }
}

/* -------------------------------- Supabase -------------------------------- */

async function sbFetch(path, options = {}) {
  const sb = supabaseConfig();
  if (!sb) throw new Error('Supabase is not configured');
  const res = await fetch(sb.url + path, {
    ...options,
    headers: {
      apikey: sb.key,
      Authorization: `Bearer ${sb.key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function readTable(table, columns) {
  const res = await sbFetch(`/rest/v1/${table}?select=${columns.join(',')}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function writeTable(table, rows) {
  if (!rows.length) return 0;
  await sbFetch(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

/* --------------------------------- Discord -------------------------------- */

async function discordApi(path, options = {}) {
  const bot = discordConfig();
  if (!bot) throw new Error('Discord is not configured');
  const res = await fetch(`${config.discord.apiBase}/channels/${bot.channelId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${bot.token}`,
      'User-Agent': config.discord.userAgent,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(config.discord.timeoutMs),
  });
  if (!res.ok) throw new Error(`Discord ${options.method || 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

function snowflakeDesc(a, b) {
  try { return BigInt(b.id) > BigInt(a.id) ? 1 : -1; } catch { return 0; }
}

async function listMirrorMessages() {
  const res = await discordApi('/messages?limit=50');
  const messages = await res.json();
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && m.author && m.author.bot && typeof m.content === 'string'
      && m.content.startsWith(MARKER))
    .sort(snowflakeDesc);
}

async function publishSnapshot(snapshot) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: `${MARKER} ${snapshot.takenAt}` }));
  form.append('files[0]', new Blob([JSON.stringify(encrypt(snapshot))], { type: 'application/json' }), 'metadata.json');
  await discordApi('/messages', { method: 'POST', body: form });
}

async function pruneMirrorMessages(messages) {
  for (const msg of messages.slice(KEEP_SNAPSHOTS)) {
    try {
      await discordApi(`/messages/${msg.id}`, { method: 'DELETE' });
    } catch (err) {
      warn('could not delete old mirror message', msg.id, err.message);
    }
  }
}

async function loadLatestSnapshot(messages) {
  for (const msg of messages) {
    const attachment = msg.attachments && msg.attachments[0];
    if (!attachment || !attachment.url) continue;
    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const snapshot = decrypt(await res.json());
      // An empty account table means this snapshot was taken while the DB was
      // already flushed. Keep walking back to the last good one.
      if (snapshot && Array.isArray(snapshot.tables.users) && snapshot.tables.users.length) {
        return snapshot;
      }
    } catch (err) {
      warn('could not read mirror attachment', msg.id, err.message);
    }
  }
  return null;
}

/* --------------------------------- actions -------------------------------- */

async function snapshotSupabase() {
  const tables = {};
  for (const { table, columns } of TABLES) {
    tables[table] = await readTable(table, columns);
  }
  return { format: SNAPSHOT_FORMAT, takenAt: Date.now(), tables };
}

async function alert(text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    warn('alert delivery failed', err.message);
  }
}

async function restoreOnce() {
  const messages = await listMirrorMessages();
  const snapshot = await loadLatestSnapshot(messages);
  if (!snapshot) {
    log('no usable snapshot in Discord yet');
    return null;
  }

  const liveUsers = await readTable('users', ['userhash']);
  if (liveUsers.length) {
    log('Supabase still has accounts; no restore needed');
    return null;
  }

  const restored = {};
  for (const { table } of TABLES) {
    const rows = snapshot.tables[table] || [];
    if (!rows.length) continue;
    // Only fill empty tables, so uploads made since the flush are preserved.
    const live = await readTable(table, TABLES.find(t => t.table === table).columns.slice(0, 1));
    if (live.length) continue;
    restored[table] = await writeTable(table, rows);
  }

  const summary = Object.entries(restored).map(([t, n]) => `${t}:${n}`).join(' ');
  log('restored metadata from Discord mirror', summary || '(nothing)');
  await alert(`⚠️ Catbox metadata was restored from the Discord mirror after a Supabase flush. ${summary || 'no rows'}`);
  return restored;
}

async function tick() {
  const snapshot = await snapshotSupabase();
  // Never publish an empty account table over a good mirror.
  if (!snapshot.tables.users.length) {
    warn('snapshot has no accounts; keeping the existing mirror');
    return;
  }
  await publishSnapshot(snapshot);
  const messages = await listMirrorMessages();
  await pruneMirrorMessages(messages);
  log('snapshot published', snapshot.tables.users.length, 'accounts');
}

// Called on SIGTERM/SIGINT so a graceful session handoff persists the very
// last state. Failures are logged by the caller; they must never block exit.
async function flush() {
  if (!isConfigured()) return;
  try {
    await tick();
  } catch (err) {
    warn('final snapshot failed', err.message);
  }
}

async function start() {
  if (starting) return starting;
  if (!isConfigured()) {
    warn('disabled: Supabase, Discord, or NODE_UPLOAD_SECRET is missing');
    return null;
  }
  starting = (async () => {
    try {
      await restoreOnce();
    } catch (err) {
      warn('startup restore failed', err.message);
    }
    timer = setInterval(() => {
      tick().catch(err => warn('snapshot failed', err.message));
    }, SNAPSHOT_INTERVAL_MS);
    if (timer.unref) timer.unref();
    // Take a fresh snapshot shortly after boot rather than waiting a minute.
    tick().catch(err => warn('initial snapshot failed', err.message));
    return true;
  })();
  return starting;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  starting = null;
}

module.exports = {
  start,
  stop,
  flush,
  isConfigured,
  // Exposed for tests.
  _internal: { encrypt, decrypt, snapshotSupabase, restoreOnce, tick, listMirrorMessages, loadLatestSnapshot },
};
