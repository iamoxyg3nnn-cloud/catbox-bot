'use strict';

// Discord-only byte storage. Bot tokens are read from config; bytes are
// streamed from the staging file to Discord and never buffered in memory.

const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { sanitizeOriginalName } = require('../util');
const cache = require('../cache');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Serialises requests through one bucket and tracks Discord's response headers.
// Bucket sizes are deliberately not hardcoded: we only trust X-RateLimit-*.
class Bucket {
  constructor() {
    this.remaining = 1;
    this.resetAt = 0;
    this.blockedUntil = 0;
    this.chain = Promise.resolve();
  }

  async acquire() {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const previous = this.chain;
    this.chain = previous.then(() => gate);
    await previous;
    try {
      while (Date.now() < this.blockedUntil) {
        await sleep(Math.min(this.blockedUntil - Date.now(), 30_000));
      }
      if (this.remaining <= 0 && Date.now() < this.resetAt) {
        await sleep(Math.max(0, this.resetAt - Date.now()) + 25);
      }
      return () => release();
    } catch (err) {
      release();
      throw err;
    }
  }

  update(headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining)) this.remaining = remaining;
    if (Number.isFinite(reset)) this.resetAt = reset * 1000;
  }

  block(ms) {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
    this.remaining = 0;
  }
}

// Discord's `ex` query parameter is a hex Unix timestamp in seconds.
function expiryFromUrl(url) {
  try {
    const ex = new URL(url).searchParams.get('ex');
    const seconds = ex ? parseInt(ex, 16) : 0;
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch { return null; }
}

function safeFilename(name) {
  return sanitizeOriginalName(name).replace(/"/g, '');
}

class DiscordStorage {
  constructor(config) {
    this.config = config;
    this.bots = config.discord.bots || [];
    this.health = new Map(this.bots.map(b => [b.id, true]));
    this.cursor = 0;
    this.buckets = new Map();
    // Cumulative counters exported through /api/metrics. No tokens or paths.
    this.counters = { requests: 0, rateLimited: 0, retries: 0, lastRateLimitAt: null };
  }

  stats() {
    const { requests, rateLimited, retries, lastRateLimitAt } = this.counters;
    return {
      transport: 'discord',
      requests,
      rateLimited,
      retries,
      rateLimitPct: requests ? +(rateLimited / requests * 100).toFixed(2) : 0,
      lastRateLimitAt,
    };
  }

  bucket(key) {
    if (!this.buckets.has(key)) this.buckets.set(key, new Bucket());
    return this.buckets.get(key);
  }

  pickBot() {
    const alive = this.bots.filter(b => this.health.get(b.id) !== false);
    if (!alive.length) throw new Error('No healthy Discord bots configured.');
    const bot = alive[this.cursor % alive.length];
    this.cursor += 1;
    return bot;
  }

  botById(id) {
    const bot = this.bots.find(b => b.id === id);
    if (!bot) throw new Error(`Unknown Discord bot id: ${id}`);
    return bot;
  }

  async request(bot, method, path, { body, contentType } = {}) {
    const botBucket = this.bucket(`bot:${bot.id}`);
    const channelBucket = this.bucket(`channel:${bot.channelId}`);
    const url = `${this.config.discord.apiBase.replace(/\/+$/, '')}${path}`;

    for (let attempt = 0; attempt <= this.config.discord.maxRetries; attempt++) {
      const releaseBot = await botBucket.acquire();
      let releaseChannel;
      try {
        releaseChannel = await channelBucket.acquire();
        const headers = {
          Authorization: `Bot ${bot.token}`,
          'User-Agent': this.config.discord.userAgent,
        };
        if (contentType) headers['Content-Type'] = contentType;
        const init = {
          method,
          headers,
          signal: AbortSignal.timeout(this.config.discord.timeoutMs),
        };
        if (body) {
          init.body = body;
          init.duplex = 'half';
        }
        const response = await fetch(url, init);
        this.counters.requests += 1;
        botBucket.update(response.headers);
        channelBucket.update(response.headers);

        if (response.status === 429) {
          this.counters.rateLimited += 1;
          this.counters.lastRateLimitAt = Date.now();
          let retry = 1;
          try {
            const payload = await response.json();
            if (Number.isFinite(Number(payload.retry_after))) retry = Number(payload.retry_after);
          } catch { /* keep the default */ }
          const global = response.headers.get('x-ratelimit-global') === 'true';
          const delay = Math.max(0.25, retry) * 1000 + Math.floor(Math.random() * 250);
          if (global) botBucket.block(delay); else channelBucket.block(delay);
          if (attempt === this.config.discord.maxRetries) {
            throw new Error(`Discord rate limit exceeded after ${attempt + 1} attempts.`);
          }
          this.counters.retries += 1;
          continue;
        }

        if (response.status === 401 || response.status === 403) this.health.set(bot.id, false);
        return response;
      } finally {
        if (releaseChannel) releaseChannel();
        releaseBot();
      }
    }
    throw new Error('Discord request failed.');
  }

  buildMultipart(filePath, originalName, mime) {
    const boundary = `----catbox${crypto.randomBytes(12).toString('hex')}`;
    const filename = safeFilename(originalName);
    const payload = JSON.stringify({ content: '', allowed_mentions: { parse: [] } });
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="payload_json"\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      `${payload}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files[1]"; filename="${filename}"\r\n` +
      `Content-Type: ${mime || 'application/octet-stream'}\r\n\r\n`,
      'utf8'
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    async function* chunks() {
      yield preamble;
      for await (const chunk of fs.createReadStream(filePath)) yield chunk;
      yield closing;
    }
    return {
      body: Readable.from(chunks()),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  async upload({ filePath, originalName, mime }) {
    const bot = this.pickBot();
    const { body, contentType } = this.buildMultipart(filePath, originalName, mime);
    const response = await this.request(
      bot,
      'POST',
      `/channels/${bot.channelId}/messages?wait=true`,
      { body, contentType }
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Discord upload failed (${response.status}): ${detail}`);
    }
    const message = await response.json();
    const attachment = (message.attachments || [])[0];
    if (!attachment) throw new Error('Discord response contained no attachment.');
    return {
      botId: bot.id,
      channelId: bot.channelId,
      messageId: String(message.id),
      attachmentId: String(attachment.id),
      cdnUrl: attachment.url,
      cdnExpiresAt: expiryFromUrl(attachment.url),
      status: 'ready',
    };
  }

  async resolve(row) {
    const cacheKey = `cdn:${row.message_id}:${row.attachment_id}`;
    try {
      const cached = await cache.get(cacheKey);
      if (cached && cached.url) return cached.url;
    } catch { /* cache is an optimisation; fall through to Discord */ }

    const bot = this.botById(row.bot_id);
    const response = await this.request(
      bot,
      'GET',
      `/channels/${row.channel_id}/messages?around=${row.message_id}&limit=1`
    );
    if (!response.ok) throw new Error(`Discord message fetch failed (${response.status}).`);
    const messages = await response.json();
    const message = Array.isArray(messages)
      ? messages.find(m => String(m.id) === String(row.message_id))
      : null;
    const attachment = (message && message.attachments || []).find(a => String(a.id) === String(row.attachment_id));
    if (!attachment) throw new Error('Discord attachment is no longer available.');
    try {
      // Signed URLs last hours; keep a short cache so every download does not
      // consume a Discord read request.
      await cache.set(cacheKey, { url: attachment.url }, 300);
    } catch { /* non-fatal */ }
    return attachment.url;
  }

  async remove(row) {
    const bot = this.botById(row.bot_id);
    const response = await this.request(
      bot,
      'DELETE',
      `/channels/${row.channel_id}/messages/${row.message_id}`
    );
    if (response.ok || response.status === 404) {
      try { await cache.del(`cdn:${row.message_id}:${row.attachment_id}`); } catch { /* non-fatal */ }
      return true;
    }
    throw new Error(`Discord message delete failed (${response.status}).`);
  }
}

module.exports = { DiscordStorage, Bucket, expiryFromUrl };
