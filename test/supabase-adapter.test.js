'use strict';

// Contract tests for the PostgREST adapter. A live Supabase instance is still
// required for RLS/RPC behaviour, but request shapes, auth headers and error
// handling can be verified locally with a stubbed fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/adapters/supabase');

const ORIGINAL_ENV = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
let originalFetch;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.before(() => {
  process.env.SUPABASE_URL = 'https://cloned.supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  originalFetch = global.fetch;
});

test.after(() => {
  global.fetch = originalFetch;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('reads use the service key and PostgREST eq filters', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json([{ id: 7, username: 'bob' }]);
  };
  const user = await db.findUserByName('bob');
  assert.equal(user.username, 'bob');
  assert.match(calls[0].url, /^https:\/\/cloned\.supabase\.test\/rest\/v1\/users\?username=eq\.bob&limit=1$/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.apikey, 'test-service-key');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-service-key');
});

test('recordFile uses an idempotent upsert', async () => {
  let call;
  global.fetch = async (url, init) => {
    call = { url: String(url), init };
    return json([{ name: 'abc.txt' }], 201);
  };
  await db.recordFile({
    name: 'abc.txt', ownerHash: null, originalName: 'a.txt', mime: 'text/plain',
    size: 3, botId: 'b', channelId: 'c', messageId: 'm', attachmentId: 'a',
  });
  assert.match(call.url, /\/rest\/v1\/files$/);
  assert.equal(call.init.method, 'POST');
  assert.match(call.init.headers.Prefer, /resolution=merge-duplicates/);
  const body = JSON.parse(call.init.body);
  assert.equal(body.name, 'abc.txt');
  assert.equal(body.message_id, 'm');
});

test('claimJob calls the RPC and returns the claimed row', async () => {
  const urls = [];
  global.fetch = async (url, init) => {
    urls.push({ url: String(url), method: init.method });
    return json([{ job_id: 'job-1', status: 'uploading' }]);
  };
  const job = await db.claimJob();
  assert.equal(job.job_id, 'job-1');
  assert.deepEqual(urls, [{
    url: 'https://cloned.supabase.test/rest/v1/rpc/claim_upload_job',
    method: 'POST',
  }]);
});

test('node heartbeats publish staged disk usage', async () => {
  let body;
  global.fetch = async (url, init) => {
    if (init.method === 'POST') body = JSON.parse(init.body);
    return json([{ node_id: 'node-1' }]);
  };
  await db.upsertNode({ nodeId: 'node-1', draining: 1, stagedBytes: 4096, stagedFiles: 2 });
  assert.equal(body.staged_bytes, 4096);
  assert.equal(body.staged_files, 2);
  assert.equal(body.draining, true); // Postgres boolean column
});

test('deleteFileRows uses a parenthesised PostgREST in filter', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: decodeURIComponent(String(url)), method: init.method });
    return json([{ name: 'a.txt' }]);
  };
  const removed = await db.deleteFileRows(['a.txt', 'b.txt']);
  assert.equal(removed, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/files\?name=in\.\("a\.txt","b\.txt"\)/);
  assert.match(calls[1].url, /\/album_files\?file_name=in\.\("a\.txt","b\.txt"\)/);
  assert.ok(calls.every(c => c.method === 'DELETE'));
});

test('finishJob tolerates a job row removed mid-flight', async () => {
  global.fetch = async () => json([]);
  assert.equal(await db.finishJob('gone', { name: null }), null);
});

test('owner listings include the alive filter', async () => {
  let url;
  global.fetch = async (target) => { url = String(target); return json([]); };
  await db.filesByOwner('hash-1');
  assert.match(url, /owner_hash=eq\.hash-1/);
  assert.match(url, /or=\(expires_at\.is\.null,expires_at\.gt\.\d+\)/);
  assert.match(url, /order=uploaded_at\.desc/);
});

test('backend errors surface with status and body detail', async () => {
  global.fetch = async () => new Response('permission denied', { status: 403 });
  await assert.rejects(
    () => db.findUserByName('bob'),
    /Supabase GET users failed \(403\): permission denied/
  );
});

test('adminQuery wraps OR search inside a single AND expression', async () => {
  let url;
  global.fetch = async requestUrl => {
    url = String(requestUrl);
    return json([{ name: 'abc.gif' }]);
  };
  await db.adminQuery('files', { q: 'gif', where: { status: 'ready' }, limit: 3, offset: 2 });
  const parsed = new URL(url);
  const expression = parsed.searchParams.get('and');
  assert.match(expression, /^\(or\(name\.ilike\.%gif%,original_name\.ilike\.%gif%,/);
  assert.match(expression, /,status\.eq\.ready\)$/);
  assert.equal(parsed.searchParams.get('limit'), '3');
  assert.equal(parsed.searchParams.get('offset'), '2');
  assert.equal(parsed.searchParams.get('order'), 'uploaded_at.desc');
});

test('adminQuery wraps exact filters and rejects unknown tables', async () => {
  let url;
  global.fetch = async requestUrl => {
    url = String(requestUrl);
    return json([{ token: 'abc' }]);
  };
  await db.adminQuery('sessions', { where: { user_id: 1 } });
  assert.equal(new URL(url).searchParams.get('and'), '(user_id.eq.1)');
  await assert.rejects(() => db.adminQuery('password_reset_tokens', {}), /Unsupported admin table/);
});
