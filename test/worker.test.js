'use strict';

// Unit tests for the Cloudflare Worker router using a stubbed global fetch.
// These run under Node's test runner; the Worker module is loaded as text and
// evaluated in a small ESM shim so no Wrangler/Miniflare install is required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', 'workers', 'catbox-router', 'index.js');

async function loadWorker() {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return (await import(moduleUrl)).default;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
    clone() { return this; },
  };
}

function request(pathname, { headers = {}, body = null } = {}) {
  const h = new Headers(headers);
  return {
    method: body ? 'POST' : 'GET',
    url: `https://router.test${pathname}`,
    headers: h,
    body,
  };
}

function env(extra = {}) {
  return {
    NODE_REGISTRY: JSON.stringify([
      { id: 'node-1', url: 'https://n1.test', status: 'up', pending: 0, active: 0 },
      { id: 'node-2', url: 'https://n2.test', status: 'up', pending: 5, active: 2 },
    ]),
    FRONTEND_ORIGIN: 'https://frontend.test',
    ...extra,
  };
}

test('worker health reports the node count', async () => {
  const worker = await loadWorker();
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ nodes: JSON.parse(env().NODE_REGISTRY) });
  try {
    const res = await worker.fetch(request('/health'), env());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.nodes, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('worker picks the least-loaded node and forwards the body', async () => {
  const worker = await loadWorker();
  const originalFetch = global.fetch;
  let upstreamUrl = '';
  global.fetch = async (url) => {
    const str = String(url);
    if (str.includes('/api/nodes')) return jsonResponse({ nodes: JSON.parse(env().NODE_REGISTRY) });
    upstreamUrl = str;
    return jsonResponse({ ok: true }, 202);
  };
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    const res = await worker.fetch(
      request('/user/api.php', { headers: { 'content-length': '100', 'cf-connecting-ip': '1.2.3.4' }, body: form }),
      env()
    );
    assert.equal(res.status, 202);
    assert.ok(upstreamUrl.startsWith('https://n1.test/'), upstreamUrl);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://frontend.test');
  } finally {
    global.fetch = originalFetch;
  }
});

test('worker rejects files over the 20 MiB ceiling before proxying', async () => {
  const worker = await loadWorker();
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return jsonResponse({}); };
  try {
    const res = await worker.fetch(
      request('/user/api.php', { headers: { 'content-length': String(21 * 1024 * 1024) }, body: new FormData() }),
      env()
    );
    assert.equal(res.status, 413);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('worker returns 503 when no nodes are healthy', async () => {
  const worker = await loadWorker();
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ nodes: [] });
  try {
    const res = await worker.fetch(
      request('/user/api.php', { headers: { 'content-length': '10' }, body: new FormData() }),
      env({ NODE_REGISTRY: '[]' })
    );
    assert.equal(res.status, 503);
  } finally {
    global.fetch = originalFetch;
  }
});
