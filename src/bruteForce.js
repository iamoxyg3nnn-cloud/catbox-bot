'use strict';

// Shared login throttling with per-account lockout and exponential backoff.
//
// OWASP recommends that failed-attempt counters be associated with the account
// (not only the source IP), so an attacker rotating IPs cannot bypass the lock.
// We also keep a per-IP counter to slow distributed guessing of a single name.
// State is process-local and intentionally ephemeral: the bot runs on an
// ephemeral runner and a restart clears it, which is acceptable for slowing
// online attacks (it is not a substitute for strong credentials or MFA).

const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const buckets = new Map();

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function keys(ip, identity) {
  return [hash(`ip:${ip || 'unknown'}`), hash(`id:${identity || ''}`)];
}

function prune(now) {
  if (buckets.size < 2000) return;
  for (const [key, entry] of buckets) if (entry.reset <= now) buckets.delete(key);
}

function read(key, now) {
  const entry = buckets.get(key);
  if (!entry || entry.reset <= now) return { count: 0, until: 0, reset: now + WINDOW_MS };
  return entry;
}

function write(key, entry) {
  buckets.set(key, entry);
}

// Returns { blocked, retryAfterMs, attempts }. Call before checking credentials.
function check(ip, identity) {
  const now = Date.now();
  const [ipKey, idKey] = keys(ip, identity);
  const sources = [read(ipKey, now), read(idKey, now)].filter(entry => entry.reset > now);
  const blocked = sources.find(entry => entry.until > now);
  const until = sources.reduce((max, entry) => Math.max(max, entry.until), 0);
  return {
    blocked: Boolean(blocked),
    retryAfterMs: Math.max(0, until - now),
    attempts: sources.reduce((max, entry) => Math.max(max, entry.count), 0),
  };
}

// Call after a failed credential check. Delay doubles with each failure after
// the third, capped at the 15 minute window.
function fail(ip, identity) {
  const now = Date.now();
  const [ipKey, idKey] = keys(ip, identity);
  for (const key of [ipKey, idKey]) {
    const entry = read(key, now);
    entry.count += 1;
    // The first few mistakes are free; real backoff starts at the fourth.
    if (entry.count > 3) {
      entry.until = now + Math.min(WINDOW_MS, 1000 * (2 ** (entry.count - 3)));
    }
    write(key, entry);
  }
  prune(now);
  return check(ip, identity);
}

// Call after a successful credential check so the account is not punished for
// a legitimate user who eventually got their password right.
function clear(ip, identity) {
  const [ipKey, idKey] = keys(ip, identity);
  buckets.delete(ipKey);
  buckets.delete(idKey);
}

module.exports = { check, fail, clear, WINDOW_MS, MAX_FAILURES };
