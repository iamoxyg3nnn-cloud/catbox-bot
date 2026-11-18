'use strict';

// Live Discord verification — the first external go-live check.
//
// Uses the real transport (never the mock) to check one bot end to end:
//   token -> upload -> signed CDN bytes -> around-message refresh -> delete -> 404
//
// Usage:
//   DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_ID=... node scripts/verify-discord.js
//   DISCORD_BOTS='[{...}]' node scripts/verify-discord.js --all
//
// Nothing is stored on disk beyond a tiny temporary file that is always removed.
// Bot tokens are never printed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../src/config');
const { DiscordStorage } = require('../src/storage/discord');

const apiBase = config.discord.apiBase.replace(/\/+$/, '');
const authHeaders = token => ({
  Authorization: `Bot ${token}`,
  'User-Agent': config.discord.userAgent,
});

async function checkBytes(label, url, expected) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const actual = Buffer.from(await res.arrayBuffer());
  const match = res.ok && actual.equals(expected);
  if (match) console.log(`  OK ${label}: signed URL returned ${actual.length} original bytes`);
  else console.error(`  FAIL ${label}: HTTP ${res.status}, bytes match=${match}`);
  return match;
}

async function verifyBot(bot, storage) {
  console.log(`\nVerifying bot ${bot.id} / channel ${bot.channelId}`);

  const meRes = await fetch(`${apiBase}/users/@me`, {
    headers: authHeaders(bot.token),
    signal: AbortSignal.timeout(15_000),
  });
  if (!meRes.ok) {
    const detail = (await meRes.text()).slice(0, 300);
    throw new Error(`token check failed (HTTP ${meRes.status}): ${detail}`);
  }
  const me = await meRes.json();
  console.log(`  OK token: ${me.username} (id ${me.id})`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catbox-verify-'));
  const staged = path.join(dir, 'verify.txt');
  const bytes = Buffer.from(`catbox-live-verification-${Date.now()}\n`);
  fs.writeFileSync(staged, bytes);

  try {
    const result = await storage.upload({ filePath: staged, originalName: 'verify.txt', mime: 'text/plain' });
    console.log(`  OK upload: message ${result.messageId}, attachment ${result.attachmentId}`);

    const row = {
      bot_id: result.botId,
      channel_id: result.channelId,
      message_id: result.messageId,
      attachment_id: result.attachmentId,
      cdn_url: result.cdnUrl,
    };

    let ok = await checkBytes('CDN', result.cdnUrl, bytes);

    const refreshed = await storage.resolve(row);
    ok = await checkBytes('refresh', refreshed, bytes) && ok;
    console.log(`  OK refresh: around-message lookup found attachment ${row.attachment_id}`);

    await storage.remove(row);
    console.log('  OK delete: message removed');

    const gone = await fetch(`${apiBase}/channels/${row.channel_id}/messages/${row.message_id}`, {
      headers: authHeaders(bot.token),
      signal: AbortSignal.timeout(15_000),
    });
    if (gone.status === 404) console.log('  OK delete verified: message GET is 404');
    else {
      console.error(`  FAIL delete verified: expected 404, got ${gone.status}`);
      ok = false;
    }
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (config.discord.transport !== 'discord') {
    throw new Error('DISCORD_TRANSPORT=mock is test-only; unset it for live verification.');
  }
  const bots = config.discord.bots;
  if (!bots.length) {
    throw new Error('Set DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID (or DISCORD_BOTS JSON) to verify.');
  }
  const all = process.argv.includes('--all');
  const targets = all ? bots : [bots[0]];
  console.log(`Live Discord verification: ${targets.length} bot(s)${all ? ' (all configured)' : ''}`);

  // One storage instance so rate buckets and counters are shared across bots,
  // matching how the real control plane spreads load.
  const storage = new DiscordStorage(config);
  let passed = 0;
  for (const bot of targets) {
    try {
      if (await verifyBot(bot, storage)) passed++;
    } catch (err) {
      console.error(`  FAIL ${bot.id}: ${err.message}`);
    }
  }
  console.log(`\nResult: ${passed}/${targets.length} bots verified`);
  console.log(`Discord counters: ${JSON.stringify(storage.stats())}`);
  if (passed !== targets.length) process.exitCode = 1;
}

main().catch(err => {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
});
