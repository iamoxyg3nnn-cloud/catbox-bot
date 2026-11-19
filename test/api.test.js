'use strict';

// End-to-end smoke tests for the Catbox clone. The server is started as a
// child process against a throwaway data directory so nothing touches the
// developer's real uploads or database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'catbox-test-'));
const PROJECT = path.join(__dirname, '..');
const { config } = require('../src/config');

let server;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status === 410) return;
    } catch { /* not up yet */ }
    await wait(100);
  }
  throw new Error('server did not start');
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, DISCORD_TRANSPORT: 'mock', NODE_UPLOAD_SECRET: 'test-secret', ADMIN_TOKEN: 'test-admin-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  await waitForServer();
});

test.after(async () => {
  if (server) {
    server.kill();
    for (let i = 0; i < 50; i++) {
      if (server.exitCode !== null || server.signalCode) break;
      await wait(100);
    }
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* Windows may keep the WAL file briefly; leftover temp dirs are harmless */ }
});

/* ------------------------------- helpers ------------------------------- */

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of fields) body.append(key, value);
  return body;
}

async function postApi(fields) {
  const res = await fetch(`${BASE}/user/api.php`, { method: 'POST', body: formBody(fields) });
  return { status: res.status, text: await res.text() };
}

async function uploadFile(fields, filename, contents, type = 'text/plain') {
  const form = new FormData();
  for (const [key, value] of fields) form.append(key, value);
  form.append('fileToUpload', new Blob([contents], { type }), filename);
  const res = await fetch(`${BASE}/user/api.php`, { method: 'POST', body: form });
  return { status: res.status, text: await res.text() };
}

async function postForm(url, fields) {
  return fetch(url, { method: 'POST', body: formBody(fields), redirect: 'manual' });
}

/* -------------------------- browser interface ------------------------- */

test('ops dashboard is served as a standalone page', async () => {
  const res = await fetch(`${BASE}/ops`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Catbox operations/);
});

test('browser pages serve the restored interface', async () => {
  const routes = ['/', '/faq.php', '/tools.php', '/legal.php', '/contact.php', '/credits.php',
    '/litterbox.php', '/nofun.php', '/user/login.php', '/user/register.php',
    '/user/forgotpassword.php', '/user/index.php', '/user/albums.php', '/admin'];
  for (const route of routes) {
    const res = await fetch(BASE + route);
    assert.equal(res.status, 200, `${route} should serve the browser UI`);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
  }
});

test('unknown route is a plain-text 404', async () => {
  const res = await fetch(`${BASE}/definitely-not-here`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Not found/);
});

/* ------------------------------ file upload ---------------------------- */

test('fileupload stores and serves a file', async () => {
  const up = await uploadFile([['reqtype', 'fileupload']], 'hello.txt', 'hello world');
  assert.equal(up.status, 200);
  assert.match(up.text, /\/files\/[a-z0-9]+\.txt$/i);

  const served = await fetch(up.text.trim());
  assert.equal(served.status, 200);
  assert.equal(await served.text(), 'hello world');
});

test('downloads stream bytes under our own domain and no permanent disk copy is made', async () => {
  const up = await uploadFile([['reqtype', 'fileupload']], 'redirect.txt', 'redirect body');
  assert.equal(up.status, 200, up.text);
  const res = await fetch(up.text.trim(), { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('location'), null);
  assert.match(res.headers.get('content-type') || '', /text\/plain/);
  assert.equal(await res.text(), 'redirect body');
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'files')), false);
});

test('async upload returns a job and resolves to a share URL', async () => {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob(['async body'], { type: 'text/plain' }), 'async.txt');
  const accepted = await fetch(`${BASE}/user/api.php`, {
    method: 'POST', body: form, headers: { 'X-Catbox-Async': '1' },
  });
  assert.equal(accepted.status, 202);
  const job = await accepted.json();
  assert.equal(job.status, 'queued');
  assert.match(job.job_id, /^[a-f0-9]{24}$/);

  let status;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BASE}${job.status_url}`);
    assert.equal(res.status, 200);
    status = await res.json();
    if (status.status !== 'queued' && status.status !== 'uploading') break;
    await wait(100);
  }
  assert.equal(status.status, 'ready', status.error);
  assert.match(status.url, /\/files\/[a-z0-9]+\.txt$/);
  const page = await fetch(status.url, { redirect: 'manual' });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'async body');
});

test('resumable chunk upload rejects bad offsets and commits only once', async () => {
  const created = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalName: 'chunked.txt', mime: 'text/plain', size: 11 }),
  });
  assert.equal(created.status, 201);
  const session = await created.json();
  assert.equal(session.chunkSize, 4 * 1024 * 1024);

  const badOwner = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalName: 'bad.txt', mime: 'text/plain', size: 1, userhash: { value: 'fake' } }),
  });
  const badSession = await badOwner.json();
  const badPayload = JSON.parse(Buffer.from(badSession.token.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(badPayload.o, null, 'non-string userhash must not become "[object Object]"');
  const headers = token => ({ 'Content-Type': 'application/octet-stream', 'X-Upload-Token': token });

  const wrongOffset = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
    method: 'PUT',
    headers: { ...headers(session.token), 'X-Upload-Offset': '5' },
    body: 'hello',
  });
  assert.equal(wrongOffset.status, 409);
  assert.equal((await wrongOffset.json()).received, 0);

  const first = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
    method: 'PUT',
    headers: { ...headers(session.token), 'X-Upload-Offset': '0' },
    body: 'hello worl',
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).received, 10);

  const probe = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
    headers: { 'X-Upload-Token': session.token },
  });
  assert.equal((await probe.json()).received, 10);

  const oversized = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
    method: 'PUT',
    headers: { ...headers(session.token), 'X-Upload-Offset': '10' },
    body: 'this exceeds the session',
  });
  assert.equal(oversized.status, 413);

  const last = await fetch(`${BASE}/api/uploads/${session.uploadId}`, {
    method: 'PUT',
    headers: { ...headers(session.token), 'X-Upload-Offset': '10' },
    body: 'd',
  });
  assert.equal(last.status, 200);
  assert.equal((await last.json()).complete, true);

  const complete = () => fetch(`${BASE}/api/uploads/${session.uploadId}/complete`, {
    method: 'POST', headers: { 'X-Upload-Token': session.token },
  });
  const accepted = await complete();
  assert.equal(accepted.status, 202);
  const job = await accepted.json();
  assert.equal(job.job_id, session.uploadId.slice(0, 24));
  const retry = await complete();
  assert.equal((await retry.json()).job_id, job.job_id);

  let status;
  for (let i = 0; i < 40; i++) {
    status = await fetch(`${BASE}${job.status_url}`).then(r => r.json());
    if (status.status !== 'queued' && status.status !== 'uploading') break;
    await wait(100);
  }
  assert.equal(status.status, 'ready', status.error);
  const file = await fetch(status.url);
  assert.equal(await file.text(), 'hello world');
});

test('internal metadata endpoint requires the shared secret', async () => {
  const payload = {
    name: 'internal1.txt', owner_hash: null, original_name: 'internal.txt',
    mime: 'text/plain', size: 5, status: 'ready',
    bot_id: 'bot-1', channel_id: 'ch-1', message_id: 'm-1',
  };
  const denied = await fetch(`${BASE}/internal/files`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${BASE}/internal/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Catbox-Secret': 'test-secret' },
    body: JSON.stringify(payload),
  });
  assert.equal(accepted.status, 201);
  const page = await fetch(`${BASE}/files/internal1.txt`, { redirect: 'manual' });
  assert.equal(page.status, 503); // ready metadata but no signed URL was supplied yet
});

test('node registry and heartbeat drive worker routing', async () => {
  const before = await fetch(`${BASE}/api/nodes`).then(r => r.json());
  assert.equal(before.nodes.length, 0);

  const denied = await fetch(`${BASE}/internal/nodes/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_id: 'node-test' }),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${BASE}/internal/nodes/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Catbox-Secret': 'test-secret' },
    body: JSON.stringify({
      node_id: 'node-test', web_url: 'https://tunnel.test', pending: 3, active: 1,
      staged_bytes: 4096, staged_files: 2,
    }),
  });
  assert.equal(accepted.status, 200);

  const after = await fetch(`${BASE}/api/nodes`).then(r => r.json());
  assert.equal(after.nodes.length, 1);
  assert.equal(after.nodes[0].id, 'node-test');
  assert.equal(after.nodes[0].url, 'https://tunnel.test');
  assert.equal(after.nodes[0].pending, 3);
  assert.equal(after.nodes[0].active, 1);
  assert.equal(after.nodes[0].stagedBytes, 4096);
  assert.equal(after.nodes[0].stagedFiles, 2);
});

test('metrics endpoint reports queue and node health without secrets', async () => {
  const res = await fetch(`${BASE}/api/metrics`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isFinite(body.uptimeSeconds));
  assert.ok(body.jobs && Number.isFinite(body.jobs.queued));
  assert.ok(Array.isArray(body.nodes));
  assert.equal(body.discord.transport, 'mock');
  assert.equal(body.staging.bytes, 4096);
  assert.equal(body.staging.files, 2);
  assert.ok(!('token' in body) && !('secret' in body));
});

test('journal replay recovers metadata after a failed record', async () => {
  const payload = {
    job_id: 'journal-job-1', stage: 'metadata',
    metadata: {
      name: 'journaled.txt', ownerHash: null, originalName: 'journaled.txt',
      mime: 'text/plain', size: 7, status: 'ready',
      botId: 'bot-1', channelId: 'ch-1', messageId: 'm-journal',
    },
  };
  const added = await fetch(`${BASE}/internal/journal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Catbox-Secret': 'test-secret' },
    body: JSON.stringify(payload),
  });
  assert.equal(added.status, 201);

  const reconcile = await fetch(`${BASE}/internal/journal/reconcile`, {
    method: 'POST', headers: { 'X-Catbox-Secret': 'test-secret' },
  });
  assert.equal(reconcile.status, 200);

  // Metadata now exists (503 = recorded but no mock CDN object for this test).
  const page = await fetch(`${BASE}/files/journaled.txt`, { redirect: 'manual' });
  assert.equal(page.status, 503);

  const metrics = await fetch(`${BASE}/api/metrics`).then(r => r.json());
  assert.equal(metrics.journal.unresolved, 0);

  // Replaying again is safe and resolves the already-resolved row.
  await fetch(`${BASE}/internal/journal/reconcile`, {
    method: 'POST', headers: { 'X-Catbox-Secret': 'test-secret' },
  });
});

test('default upload cap is 20 MiB', () => {
  assert.equal(config.maxFileSize, 20 * 1024 * 1024);
});

test('public config endpoint exposes the limit but no secrets', async () => {
  const res = await fetch(`${BASE}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.maxFileSize, 20 * 1024 * 1024);
  assert.equal(body.transport, 'mock');
  assert.equal(body.experimental, true);
  assert.equal(JSON.stringify(body).includes('token'), false);
});

test('repeated form fields still parse', async () => {
  const up = await uploadFile(
    [['reqtype', 'fileupload'], ['reqtype', 'fileupload'], ['userhash', ''], ['userhash', '']],
    'dupe.txt',
    'duplicated fields'
  );
  assert.equal(up.status, 200, up.text);
  assert.match(up.text, /\/files\/[a-z0-9]+\.txt$/i);
});

test('blocked file types are refused', async () => {
  const up = await uploadFile([['reqtype', 'fileupload']], 'virus.exe', 'MZ', 'application/octet-stream');
  assert.equal(up.status, 403);
});

test('missing file is a 400 and unknown reqtype a 412', async () => {
  const noFile = await postApi([['reqtype', 'fileupload']]);
  assert.ok([400, 412].includes(noFile.status), `unexpected ${noFile.status}`);
  const unknown = await postApi([['reqtype', 'haxxor']]);
  assert.equal(unknown.status, 412);
});

test('urlupload copies a remote file', async () => {
  const source = await uploadFile([['reqtype', 'fileupload']], 'source.txt', 'source content');
  const up = await postApi([['reqtype', 'urlupload'], ['url', source.text.trim()]]);
  assert.equal(up.status, 200, up.text);
  const served = await fetch(up.text.trim());
  assert.equal(served.status, 200);
});

test('urlupload rejects non-http urls', async () => {
  const up = await postApi([['reqtype', 'urlupload'], ['url', 'notaurl']]);
  assert.equal(up.status, 400);
});

/* --------------------------------- auth -------------------------------- */

let userhash;
let sessionCookie;

test('registration and deletefiles', async () => {
  const res = await postForm(`${BASE}/user/doregister.php`, [
    ['username', 'smoketester'],
    ['email', 'smoke@example.com'],
    ['password', 'supersecret1'],
  ]);
  assert.equal(res.status, 201);
  userhash = decodeURIComponent(res.headers.getSetCookie()
    .find(cookie => cookie.startsWith('userhash='))
    .split(';')[0].slice('userhash='.length));
  sessionCookie = res.headers.getSetCookie()
    .find(cookie => cookie.startsWith('catsess='))
    .split(';')[0];
  assert.match(userhash, /^[a-f0-9]+$/i);

  // An upload tagged with the userhash belongs to the account.
  const up = await uploadFile(
    [['reqtype', 'fileupload'], ['userhash', userhash], ['userhash', userhash]],
    'mine.txt',
    'owned file'
  );
  assert.equal(up.status, 200, up.text);
  const name = up.text.trim().split('/').pop();

  const del = await postApi([['reqtype', 'deletefiles'], ['userhash', userhash], ['files', name]]);
  assert.equal(del.status, 200);
  assert.match(del.text, /Removed 1 file\(s\)\./);
  assert.equal((await fetch(`${BASE}${up.text.trim().replace(BASE, '')}`)).status, 404);

  // A signed-in dashboard upload is associated with its session even if the
  // browser cannot send the readable userhash cookie.
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob(['dashboard upload'], { type: 'text/plain' }), 'dashboard.txt');
  const dashboardUpload = await fetch(`${BASE}/user/api.php`, {
    method: 'POST', headers: { cookie: sessionCookie }, body: form,
  });
  assert.equal(dashboardUpload.status, 200, await dashboardUpload.text());
  const dashboard = await fetch(`${BASE}/api/dashboard`, { headers: { cookie: sessionCookie } }).then(response => response.json());
  assert.ok(dashboard.files.some(file => file.originalName === 'dashboard.txt'));
});

test('deletefiles needs a valid userhash', async () => {
  const res = await postApi([['reqtype', 'deletefiles'], ['userhash', 'deadbeef'], ['files', 'x.txt']]);
  assert.equal(res.status, 401);
});

test('login accepts the registered password', async () => {
  const res = await postForm(`${BASE}/user/dologin.php`, [
    ['username', 'smoketester'],
    ['password', 'supersecret1'],
  ]);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Authenticated/);
});

test('a signed-in session owns albums even if the body userhash is stale', async () => {
  const up = await uploadFile([['reqtype', 'fileupload'], ['userhash', userhash]], 'session-album.txt', 'owned');
  assert.equal(up.status, 200, up.text);
  const name = up.text.trim().split('/').pop();

  const body = new URLSearchParams();
  body.append('reqtype', 'createalbum');
  body.append('userhash', 'ffffffffffffffffffffffffffffffffffffffff');
  body.append('title', 'Session Album');
  body.append('files', name);
  const created = await fetch(`${BASE}/user/api.php`, {
    method: 'POST', headers: { cookie: sessionCookie }, body,
  });
  const createdUrl = await created.text();
  assert.equal(created.status, 200, createdUrl);
  const short = createdUrl.trim().split('/').pop();

  const dashboard = await fetch(`${BASE}/api/dashboard`, {
    headers: { cookie: sessionCookie },
  }).then(response => response.json());
  assert.ok(dashboard.albums.some(album => album.short === short),
    'album should be listed for the session owner');
});

/* -------------------------------- albums ------------------------------- */

test('album lifecycle with ownership protection', async () => {
  const file = await uploadFile([['reqtype', 'fileupload'], ['userhash', userhash]], 'album.txt', 'in album');
  const name = file.text.trim().split('/').pop();

  const created = await postApi([['reqtype', 'createalbum'], ['userhash', userhash], ['title', 'Smoke Album'], ['desc', 'd'], ['files', name]]);
  assert.equal(created.status, 200, created.text);
  const short = created.text.trim().split('/').pop();
  assert.match(short, /^[a-z0-9]{6}$/i);

  const added = await uploadFile([['reqtype', 'fileupload'], ['userhash', userhash]], 'second.txt', 'second');
  const second = added.text.trim().split('/').pop();
  assert.equal((await postApi([['reqtype', 'addtoalbum'], ['userhash', userhash], ['short', short], ['files', second]])).status, 200);
  assert.equal((await postApi([['reqtype', 'removefromalbum'], ['userhash', userhash], ['short', short], ['files', second]])).status, 200);

  const edited = await postApi([['reqtype', 'editalbum'], ['userhash', userhash], ['short', short], ['title', 'Renamed'], ['desc', ''], ['files', name]]);
  assert.equal(edited.status, 200, edited.text);

  const albumPage = await fetch(`${BASE}/a/${short}`);
  assert.equal(albumPage.status, 200);
  assert.match(albumPage.headers.get('content-type') || '', /text\/html/);
  const albumData = await fetch(`${BASE}/api/albums/${short}`).then(response => response.json());
  assert.equal(albumData.album.title, 'Renamed');
  assert.equal(albumData.files[0].name, name);

  const stranger = await postApi([['reqtype', 'editalbum'], ['userhash', 'ffffffffffffffffffffffffffffffffffffffff'], ['short', short], ['title', 'nope']]);
  assert.equal(stranger.status, 401);

  const deleted = await postApi([['reqtype', 'deletealbum'], ['userhash', userhash], ['short', short]]);
  assert.equal(deleted.status, 200);
  assert.equal((await postApi([['reqtype', 'deletealbum'], ['userhash', userhash], ['short', short]])).status, 404);
});

test('anonymous albums exist but cannot be managed', async () => {
  const file = await uploadFile([['reqtype', 'fileupload']], 'anon.txt', 'anon');
  const name = file.text.trim().split('/').pop();
  const created = await postApi([['reqtype', 'createalbum'], ['title', 'Anon Album'], ['desc', ''], ['files', name]]);
  assert.equal(created.status, 200, created.text);
  const short = created.text.trim().split('/').pop();

  const edit = await postApi([['reqtype', 'editalbum'], ['userhash', userhash], ['short', short], ['title', 'hijack']]);
  assert.equal(edit.status, 403);
  const albumPage = await fetch(`${BASE}/a/${short}`);
  assert.equal(albumPage.status, 200);
  const albumData = await fetch(`${BASE}/api/albums/${short}`).then(response => response.json());
  assert.equal(albumData.album.title, 'Anon Album');
});

/* ------------------------------- litterbox ----------------------------- */

test('litterbox stores a file with an expiry', async () => {
  const form = new FormData();
  form.append('time', '1h');
  form.append('fileToUpload', new Blob(['temporary'], { type: 'text/plain' }), 'temp.txt');
  const res = await fetch(`${BASE}/litterbox/api.php`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const url = (await res.text()).trim();
  assert.match(url, /\/files\/[a-z0-9]+\.txt$/i);
  assert.equal((await fetch(url)).status, 200);
});

test('litterbox rejects an unknown expiry', async () => {
  const form = new FormData();
  form.append('time', '3d');
  form.append('fileToUpload', new Blob(['x'], { type: 'text/plain' }), 'temp.txt');
  const res = await fetch(`${BASE}/litterbox/api.php`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
});

/* ---------------------------- admin console ---------------------------- */

let adminCookie;

async function adminPost(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify(body),
  });
}

test('admin console is protected by a signed session cookie', async () => {
  const page = await fetch(`${BASE}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Control room/);

  const status = await fetch(`${BASE}/api/admin/status`).then(response => response.json());
  assert.equal(status.enabled, true);
  assert.equal(status.authenticated, false);

  const denied = await fetch(`${BASE}/api/admin/overview`);
  assert.equal(denied.status, 401);

  const wrong = await adminPost('/api/admin/login', { token: 'wrong' });
  assert.equal(wrong.status, 401);

  const login = await adminPost('/api/admin/login', { token: 'test-admin-token' });
  assert.equal(login.status, 200);
  adminCookie = login.headers.getSetCookie()
    .find(cookie => cookie.startsWith('catadmin='))
    .split(';')[0];
  assert.ok(adminCookie.length > 'catadmin='.length);

  const authenticated = await fetch(`${BASE}/api/admin/status`, { headers: { cookie: adminCookie } }).then(response => response.json());
  assert.equal(authenticated.authenticated, true);
});

test('a normal account with the admin role can enter the console', async () => {
  const users = await fetch(`${BASE}/api/admin/tables/users`, { headers: { cookie: adminCookie } }).then(response => response.json());
  const target = users.rows.find(user => user.username === 'smoketester');
  assert.ok(target, 'the registered smoke-test account should be listed');

  const promoted = await fetch(`${BASE}/api/admin/tables/users`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ value: target.id, patch: { role: 'admin' } }),
  });
  assert.equal(promoted.status, 200);

  const status = await fetch(`${BASE}/api/admin/status`, { headers: { cookie: sessionCookie } }).then(response => response.json());
  assert.equal(status.authenticated, true);
  assert.equal(status.method, 'account');
  assert.equal(status.username, 'smoketester');

  const overview = await fetch(`${BASE}/api/admin/overview`, { headers: { cookie: sessionCookie } });
  assert.equal(overview.status, 200);
});

test('admin overview and table listings expose metadata without password hashes', async () => {
  const overview = await fetch(`${BASE}/api/admin/overview`, { headers: { cookie: adminCookie } }).then(response => response.json());
  assert.equal(overview.ok, true);
  assert.equal(typeof overview.counts.files, 'number');
  assert.equal(overview.storage, 'mock');

  const users = await fetch(`${BASE}/api/admin/tables/users`, { headers: { cookie: adminCookie } }).then(response => response.json());
  assert.ok(Array.isArray(users.rows));
  for (const row of users.rows) assert.equal(row.password_hash, undefined);
});

test('admin file delete purges stored bytes and metadata', async () => {
  const up = await uploadFile([['reqtype', 'fileupload']], 'admin-delete.txt', 'remove me');
  assert.equal(up.status, 200, up.text);
  const path = new URL(up.text.trim()).pathname;
  const name = path.split('/').pop();
  assert.equal((await fetch(`${BASE}${path}`)).status, 200);

  const del = await fetch(`${BASE}/api/admin/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ names: [name] }),
  }).then(response => response.json());
  assert.deepEqual(del.failed, []);
  assert.ok(del.deleted.includes(name));
  assert.equal((await fetch(`${BASE}${path}`)).status, 404);
});

test('admin runtime switch can pause and resume uploads', async () => {
  const paused = await fetch(`${BASE}/api/admin/runtime`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ uploadsPaused: true }),
  }).then(response => response.json());
  assert.equal(paused.uploadsPaused, true);

  const blocked = await uploadFile([['reqtype', 'fileupload']], 'paused.txt', 'nope');
  assert.equal(blocked.status, 503);

  await fetch(`${BASE}/api/admin/runtime`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ uploadsPaused: false }),
  });
  const resumed = await uploadFile([['reqtype', 'fileupload']], 'resumed.txt', 'ok');
  assert.equal(resumed.status, 200);
});
