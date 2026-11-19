'use strict';

// Unit tests for hub -> spoke routing. No network calls are made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickNode, score, buildForwardBody } = require('../src/nodeRouting');

const now = 1_700_000_000_000;
const node = (id, extra = {}) => ({
  node_id: id, id, web_url: `https://${id}.test`, status: 'up',
  pending: 0, active: 0, draining: false, last_heartbeat: now, ...extra,
});

test('pickNode chooses the least-loaded healthy spoke', () => {
  const chosen = pickNode([
    node('busy', { pending: 9 }),
    node('idle', { pending: 0, active: 2 }),
    node('middle', { pending: 2 }),
  ], now, 60_000);
  assert.equal(chosen.node_id, 'middle');
  assert.equal(score(node('x', { pending: 3, active: 2 })), 7);
});

test('pickNode ignores stale, down, unhealthy, draining and URL-less nodes', () => {
  const chosen = pickNode([
    node('stale', { last_heartbeat: now - 120_000 }),
    node('down', { status: 'down' }),
    node('unhealthy', { status: 'unhealthy' }),
    node('draining', { draining: true }),
    node('nourl', { web_url: '' }),
    node('good', { pending: 1 }),
  ], now, 60_000);
  assert.equal(chosen.node_id, 'good');
});

test('pickNode returns null when no spoke can serve the upload', () => {
  assert.equal(pickNode([], now, 60_000), null);
  assert.equal(pickNode([node('dead', { status: 'down' })], now, 60_000), null);
});

test('buildForwardBody streams the staged file with the original multipart fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-routing-'));
  const staged = path.join(dir, 'up_abc123');
  fs.writeFileSync(staged, 'hello from staged bytes');
  try {
    const built = buildForwardBody(staged, '../evil name.txt', 'text/plain', {
      reqtype: 'fileupload', userhash: 'hash-1',
    });
    assert.match(built.contentType, /^multipart\/form-data; boundary=/);
    let raw = '';
    for await (const chunk of built.body) raw += chunk.toString();
    assert.match(raw, /name="reqtype"\r\n\r\nfileupload/);
    assert.match(raw, /name="userhash"\r\n\r\nhash-1/);
    assert.match(raw, /filename="evil_name.txt"/);
    assert.match(raw, /hello from staged bytes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
