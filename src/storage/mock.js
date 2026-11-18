'use strict';

// Test-only transport. It keeps uploaded bytes in memory and serves them from
// a site-local route. DISCORD_TRANSPORT=mock is never used in production.

const fs = require('fs');
const { config } = require('../config');

const objects = new Map();
let sequence = 0;

function nextId(prefix) {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

class MockStorage {
  async upload({ filePath, originalName, mime }) {
    const buffer = await fs.promises.readFile(filePath);
    const attachmentId = nextId('att');
    const messageId = nextId('msg');
    objects.set(attachmentId, { buffer, mime, originalName });
    return {
      botId: 'mock-bot',
      channelId: 'mock-channel',
      messageId,
      attachmentId,
      cdnUrl: `/__mock_cdn/${attachmentId}`,
      cdnExpiresAt: Date.now() + (config.litterboxTimes['72h'] * 365),
      status: 'ready',
    };
  }

  async resolve(row) {
    if (!objects.has(row.attachment_id)) throw new Error('mock attachment not found');
    return row.cdn_url || `/__mock_cdn/${row.attachment_id}`;
  }

  async remove(row) {
    objects.delete(row.attachment_id);
  }

  get(attachmentId) {
    return objects.get(attachmentId) || null;
  }

  // Mirrors DiscordStorage.stats() so /api/metrics works under the test transport.
  stats() {
    return {
      transport: 'mock',
      requests: 0, rateLimited: 0, retries: 0,
      rateLimitPct: 0, lastRateLimitAt: null,
    };
  }
}

module.exports = { MockStorage };
