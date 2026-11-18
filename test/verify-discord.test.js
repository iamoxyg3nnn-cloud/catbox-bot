'use strict';

// The live verifier must fail clearly instead of touching Discord when it is
// unconfigured or pointed at the test-only mock transport.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PROJECT = path.join(__dirname, '..');
const SCRIPT = path.join(PROJECT, 'scripts', 'verify-discord.js');

function run(extraEnv) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: PROJECT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: '', DISCORD_CHANNEL_ID: '', DISCORD_BOTS: '',
      DISCORD_TRANSPORT: 'discord',
      ...extraEnv,
    },
  });
}

test('live verifier refuses to run without bot credentials', () => {
  const res = run({});
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Set DISCORD_BOT_TOKEN/);
});

test('live verifier refuses the test-only mock transport', () => {
  const res = run({
    DISCORD_TRANSPORT: 'mock',
    DISCORD_BOT_TOKEN: 'not-a-real-token',
    DISCORD_CHANNEL_ID: '123',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /test-only/);
});
