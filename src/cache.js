'use strict';

// Small cache/rate-counter layer. Uses Upstash Redis REST (card-free free tier)
// when configured, otherwise an in-process Map with TTLs. Same API either way.
//
// Keys used by the architecture:
//   rl:bot:{id} / rl:channel:{id}  - rate-limit counters
//   job:{jobId}                   - async job state
//   cdn:{messageId}               - signed CDN URL cache

const local = new Map();

function configured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '');
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Redis request failed (${response.status}).`);
  const payload = await response.json();
  return payload.result;
}

function cleanLocal(key) {
  const entry = local.get(key);
  if (entry && entry.expiresAt <= Date.now()) { local.delete(key); return null; }
  return entry ? entry.value : null;
}

async function get(key) {
  if (configured()) {
    const value = await redis(['GET', key]);
    if (value === null) return null;
    try { return JSON.parse(value); } catch { return value; }
  }
  return cleanLocal(key);
}

async function set(key, value, ttlSeconds = 0) {
  const serialized = JSON.stringify(value);
  if (configured()) {
    if (ttlSeconds > 0) await redis(['SET', key, serialized, 'EX', String(Math.ceil(ttlSeconds))]);
    else await redis(['SET', key, serialized]);
    return value;
  }
  local.set(key, { value, expiresAt: Date.now() + (ttlSeconds > 0 ? ttlSeconds * 1000 : Infinity) });
  return value;
}

async function del(key) {
  if (configured()) { await redis(['DEL', key]); return; }
  local.delete(key);
}

// Fixed-window counter. Returns the new count. Bots/channels also read Discord's
// X-RateLimit headers; this is a coarse secondary guard.
async function incr(key, windowSeconds = 1) {
  if (configured()) {
    const count = await redis(['INCR', key]);
    if (count === 1) await redis(['EXPIRE', key, String(windowSeconds)]);
    return Number(count);
  }
  const now = Date.now();
  const entry = local.get(key);
  if (!entry || entry.windowEnd <= now) {
    local.set(key, { value: 0, windowEnd: now + windowSeconds * 1000, expiresAt: now + windowSeconds * 1000 });
  }
  const next = local.get(key);
  next.value += 1;
  return next.value;
}

module.exports = { get, set, del, incr, configured };
