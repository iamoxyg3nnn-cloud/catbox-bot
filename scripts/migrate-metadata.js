'use strict';

// One-shot migration of existing SQLite metadata into the cloned Supabase
// project. Only metadata is copied — there are no byte files to move because
// Discord is the byte store. Safe to re-run (upsert by primary key).
//
// Usage:
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//     DATA_DIR=./data node scripts/migrate-metadata.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'catbox.db');

if (!SUPABASE_URL || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`No SQLite database found at ${DB_PATH}`);
  process.exit(1);
}

const base = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const db = new DatabaseSync(DB_PATH, { readOnly: true });

async function upsert(table, rows) {
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const response = await fetch(`${base}/${table}`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify(chunk),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`${table} upsert failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
    }
  }
  return rows.length;
}

const all = table => db.prepare(`SELECT * FROM ${table}`).all();

async function main() {
  const counts = {};
  counts.users = await upsert('users', all('users').map(r => ({
    id: r.id, username: r.username, email: r.email,
    password_hash: r.password_hash, userhash: r.userhash, created_at: r.created_at,
  })));
  counts.sessions = await upsert('sessions', all('sessions').map(r => ({
    token: r.token, user_id: r.user_id, expires_at: r.expires_at,
  })));
  counts.files = await upsert('files', all('files').map(r => ({
    name: r.name, owner_hash: r.owner_hash, original_name: r.original_name,
    mime: r.mime, size: r.size, sha256: r.sha256 || null,
    uploaded_at: r.uploaded_at, expires_at: r.expires_at || null,
    bot_id: r.bot_id || null, channel_id: r.channel_id || null,
    message_id: r.message_id || null, attachment_id: r.attachment_id || null,
    cdn_url: r.cdn_url || null, cdn_expires_at: r.cdn_expires_at || null,
    status: r.status || 'ready',
  })));
  counts.albums = await upsert('albums', all('albums').map(r => ({
    short: r.short, owner_hash: r.owner_hash, title: r.title,
    description: r.description, created_at: r.created_at,
  })));
  counts.album_files = await upsert('album_files', all('album_files').map(r => ({
    album_short: r.album_short, file_name: r.file_name, position: r.position,
  })));
  counts.messages = await upsert('messages', all('messages').map(r => ({
    id: r.id, name: r.name, email: r.email, body: r.body, created_at: r.created_at,
  })));
  console.log('Metadata migration complete:', counts);
  console.log('No byte files were copied; Discord remains the only byte store.');
}

main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => db.close());
