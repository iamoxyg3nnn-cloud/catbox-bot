'use strict';

// Unit tests for the real Discord transport using a stubbed global fetch.
// No network calls are made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiscordStorage, expiryFromUrl } = require('../src/storage/discord');

const config = {
  discord: {
    apiBase: 'https://discord.test/api/v10',
    userAgent: 'DiscordBot (test, 1.0)',
    timeoutMs: 2000,
    maxRetries: 2,
    bots: [{ id: 'bot-1', token: 'secret-token', channelId: 'channel-1' }],
  },
};

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('expiryFromUrl reads the hex ex parameter', () => {
  const url = 'https://cdn.discordapp.com/attachments/1/2/x.txt?ex=65abc123&is=65abc456&hm=deadbeef';
  assert.equal(expiryFromUrl(url), parseInt('65abc123', 16) * 1000);
});

test('upload posts a bot-authenticated multipart message and stores metadata', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-test-')), 'hello.txt');
  fs.writeFileSync(staged, 'hello world');

  const future = Math.floor(Date.now() / 1000) + 3600;
  const cdn = `https://cdn.discordapp.com/attachments/1/2/hello.txt?ex=${future.toString(16)}&is=1&hm=x`;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return response(200, {
      id: '999',
      attachments: [{ id: '777', filename: 'hello.txt', url: cdn }],
    }, { 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': String(future) });
  };
  try {
    const storage = new DiscordStorage(config);
    const meta = await storage.upload({ filePath: staged, originalName: 'hello.txt', mime: 'text/plain' });
    assert.equal(meta.botId, 'bot-1');
    assert.equal(meta.channelId, 'channel-1');
    assert.equal(meta.messageId, '999');
    assert.equal(meta.attachmentId, '777');
    assert.equal(meta.cdnUrl, cdn);
    assert.equal(meta.cdnExpiresAt, future * 1000);
    assert.equal(calls[0].url, 'https://discord.test/api/v10/channels/channel-1/messages?wait=true');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bot secret-token');
    assert.match(calls[0].init.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert.equal(calls[0].init.duplex, 'half');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(path.dirname(staged), { recursive: true, force: true });
  }
});

test('upload sends a stable nonce so retries cannot duplicate a message', async () => {
  const originalFetch = global.fetch;
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-test-')), 'nonce.txt');
  fs.writeFileSync(staged, 'nonce body');
  let multipart = '';
  global.fetch = async (url, init) => {
    for await (const chunk of init.body) multipart += chunk.toString();
    return response(200, { id: '1001', attachments: [{ id: '779', url: 'https://cdn.test/nonce' }] });
  };
  try {
    const storage = new DiscordStorage(config);
    await storage.upload({
      filePath: staged,
      originalName: 'nonce.txt',
      mime: 'text/plain',
      idempotencyKey: 'job-12345678901234567890',
    });
    assert.match(multipart, /"nonce":"job-12345678901234567890"/);
    assert.match(multipart, /"enforce_nonce":true/);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(path.dirname(staged), { recursive: true, force: true });
  }
});

test('429 responses are retried using retry_after', async () => {
  let attempt = 0;
  const originalFetch = global.fetch;
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-test-')), 'retry.txt');
  fs.writeFileSync(staged, 'retry');
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) return response(429, { retry_after: 0.01, global: false });
    return response(200, { id: '1000', attachments: [{ id: '778', url: 'https://cdn.test/x' }] });
  };
  try {
    const storage = new DiscordStorage(config);
    const meta = await storage.upload({ filePath: staged, originalName: 'retry.txt', mime: 'text/plain' });
    assert.equal(attempt, 2);
    assert.equal(meta.messageId, '1000');
    const stats = storage.stats();
    assert.equal(stats.requests, 2);
    assert.equal(stats.rateLimited, 1);
    assert.equal(stats.retries, 1);
    assert.equal(stats.rateLimitPct, 50);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(path.dirname(staged), { recursive: true, force: true });
  }
});

test('resolve uses the documented around-message fetch and remove deletes the message', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'GET') {
      return response(200, [
        { id: '999', attachments: [{ id: '777', url: 'https://cdn.test/fresh' }] },
      ]);
    }
    return response(204, null);
  };
  try {
    const storage = new DiscordStorage(config);
    const url = await storage.resolve({
      bot_id: 'bot-1', channel_id: 'channel-1', message_id: '999', attachment_id: '777',
    });
    assert.equal(url, 'https://cdn.test/fresh');
    assert.equal(calls[0].url, 'https://discord.test/api/v10/channels/channel-1/messages?around=999&limit=1');
    const removed = await storage.remove({ bot_id: 'bot-1', channel_id: 'channel-1', message_id: '999' });
    assert.equal(removed, true);
    assert.equal(calls[1].init.method, 'DELETE');
    assert.equal(calls[1].url, 'https://discord.test/api/v10/channels/channel-1/messages/999');
  } finally {
    global.fetch = originalFetch;
  }
});

test('upload fails over to a sibling bot on 403 instead of failing the user', async () => {
  const originalFetch = global.fetch;
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-test-')), 'failover.txt');
  fs.writeFileSync(staged, 'failover body');
  const fleet = {
    discord: {
      ...config.discord,
      bots: [
        { id: 'dead-bot', token: 'dead-token', channelId: 'channel-1' },
        { id: 'live-bot', token: 'live-token', channelId: 'channel-1' },
      ],
    },
  };
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(init.headers.Authorization);
    if (init.headers.Authorization === 'Bot dead-token') return response(403, { message: 'Missing Permissions' });
    return response(200, { id: '2000', attachments: [{ id: '800', url: 'https://cdn.test/failover' }] });
  };
  try {
    const storage = new DiscordStorage(fleet);
    const meta = await storage.upload({ filePath: staged, originalName: 'failover.txt', mime: 'text/plain' });
    assert.equal(meta.botId, 'live-bot');
    assert.deepEqual(calls, ['Bot dead-token', 'Bot live-token']);
    assert.equal(storage.health.get('dead-bot').up, false);
    assert.equal(storage.health.get('live-bot').up, true);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(path.dirname(staged), { recursive: true, force: true });
  }
});

test('a retired bot rejoins rotation after its backoff expires', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response(403, { message: 'Forbidden' });
  try {
    const storage = new DiscordStorage(config);
    await assert.rejects(() => storage.upload({
      filePath: __filename, originalName: 'x.txt', mime: 'text/plain',
    }));
    assert.equal(storage.health.get('bot-1').up, false);
    assert.throws(() => storage.pickBot(), /No healthy Discord bots/);
    // Simulate the backoff elapsing; the bot should be retried on probation.
    storage.health.get('bot-1').retryAt = Date.now() - 1;
    assert.equal(storage.pickBot().id, 'bot-1');
  } finally {
    global.fetch = originalFetch;
  }
});
