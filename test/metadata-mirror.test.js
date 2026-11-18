'use strict';

// Tests for the Discord-backed metadata mirror that protects against an empty
// Supabase archive after a host restart. HTTP is stubbed in-process, following
// the patterns in supabase-adapter.test.js and discord.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.DISCORD_BOT_TOKEN = 'bot-token';
process.env.DISCORD_CHANNEL_ID = 'channel-1';
process.env.NODE_UPLOAD_SECRET = 'a-stable-mirror-key';
process.env.CONTACT_EMAIL = 'admin@test.local';

const mirror = require('../src/metadataMirror');
const { encrypt, decrypt } = mirror._internal;

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function empty() {
  return new Response('', { status: 200 });
}

function snapshot(users, extra = {}) {
  return {
    format: 1,
    takenAt: Date.now(),
    tables: {
      users: users.map(u => ({ username: u, email: `${u}@test.local`, password_hash: 's1$x$y', userhash: `hash-${u}`, created_at: 1 })),
      files: [],
      albums: [],
      album_files: [],
      messages: [],
      ...extra,
    },
  };
}

test.after(() => {
  global.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

test('snapshot encryption round-trips and rejects tampering', () => {
  const payload = snapshot(['alice']);
  const blob = encrypt(payload);
  assert.deepEqual(decrypt(blob).tables.users, payload.tables.users);

  const tampered = { ...blob, data: Buffer.from('corrupt').toString('base64') };
  assert.equal(decrypt(tampered), null);
  assert.equal(decrypt({ v: 99 }), null);
});

test('loadLatestSnapshot skips empty snapshots and returns the newest usable one', async () => {
  const goodOld = encrypt(snapshot(['alice']));
  const emptyNew = encrypt(snapshot([]));
  const attachments = {
    'https://cdn.test/old': goodOld,
    'https://cdn.test/new': emptyNew,
  };
  global.fetch = async (url) => {
    const key = String(url);
    return key in attachments ? json(attachments[key]) : json({});
  };

  const messages = [
    { id: '200', content: 'CATBOX_METADATA_MIRROR_V1 200', attachments: [{ url: 'https://cdn.test/new' }] },
    { id: '100', content: 'CATBOX_METADATA_MIRROR_V1 100', attachments: [{ url: 'https://cdn.test/old' }] },
  ];
  const loaded = await mirror._internal.loadLatestSnapshot(messages);
  assert.equal(loaded.tables.users[0].username, 'alice');
});

test('restoreOnce only fills empty tables when accounts are missing', async () => {
  const saved = encrypt(snapshot(['alice'], {
    files: [{ name: 'abc123.gif', original_name: 'a.gif' }],
    albums: [{ short: 'album1', title: 'One' }],
  }));
  const counts = { users: [], files: [], albums: [], album_files: [], messages: [] };
  const writes = [];

  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/rest/v1/')) {
      const table = u.match(/\/rest\/v1\/([^?]+)/)[1];
      if (init && init.method === 'POST') {
        writes.push({ table, rows: JSON.parse(init.body), prefer: init.headers.Prefer });
        return empty();
      }
      return json(counts[table] || []);
    }
    if (u.endsWith('/messages?limit=50')) {
      return json([{ id: '300', content: 'CATBOX_METADATA_MIRROR_V1 300', author: { bot: true }, attachments: [{ url: 'https://cdn.test/saved' }] }]);
    }
    if (u === 'https://cdn.test/saved') return json(saved);
    throw new Error(`unexpected fetch ${u}`);
  };

  const restored = await mirror._internal.restoreOnce();
  assert.deepEqual(restored, { users: 1, files: 1, albums: 1 });
  assert.deepEqual(writes.map(w => w.table), ['users', 'files', 'albums']);
  assert.match(writes[0].prefer, /resolution=merge-duplicates/);
});

test('restoreOnce does nothing when Supabase still has accounts', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/users')) return json([{ userhash: 'hash-alice' }]);
    if (u.endsWith('/messages?limit=50')) {
      return json([{ id: '301', content: 'CATBOX_METADATA_MIRROR_V1 301', author: { bot: true }, attachments: [{ url: 'https://cdn.test/saved' }] }]);
    }
    if (u === 'https://cdn.test/saved') return json(encrypt(snapshot(['alice'])));
    return json([]);
  };
  assert.equal(await mirror._internal.restoreOnce(), null);
});

test('tick refuses to publish an empty account snapshot', async () => {
  let posts = 0;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/rest/v1/')) {
      const table = u.match(/\/rest\/v1\/([^?]+)/)[1];
      return json(table === 'users' ? [] : []);
    }
    if (u.endsWith('/messages') && init && init.method === 'POST') posts++;
    return json([]);
  };
  await mirror._internal.tick();
  assert.equal(posts, 0);
});

test('tick publishes an encrypted snapshot and prunes old mirror messages', async () => {
  let posted;
  const deleted = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/rest/v1/users')) return json([{ username: 'alice', email: 'a@t.local', password_hash: 'h', userhash: 'hash', created_at: 1 }]);
    if (u.includes('/rest/v1/')) return json([]);
    if (u.endsWith('/messages') && init && init.method === 'POST') {
      posted = init.body.get('files[0]');
      return json({ id: '400' });
    }
    if (u.endsWith('/messages?limit=50')) {
      return json(Array.from({ length: 12 }, (_, i) => ({
        id: String(400 - i), content: `CATBOX_METADATA_MIRROR_V1 ${400 - i}`,
        author: { bot: true }, attachments: [{ url: `https://cdn.test/${i}` }],
      })));
    }
    if (/\/messages\/\d+$/.test(u)) { deleted.push(u); return empty(); }
    throw new Error(`unexpected fetch ${u}`);
  };

  await mirror._internal.tick();
  assert.ok(posted, 'expected a JSON attachment');
  const blob = JSON.parse(await posted.text());
  assert.equal(decrypt(blob).tables.users[0].username, 'alice');
  assert.equal(deleted.length, 2, 'keeps the newest ten snapshots');
});
