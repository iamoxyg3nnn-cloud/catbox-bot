'use strict';

// Operator authentication for the admin console.
//
// The console is gated by a single high-entropy ADMIN_TOKEN stored only in the
// environment (never in the database, never in client code). A successful
// login issues a short-lived HMAC-signed cookie, so the token itself is only
// ever sent once and is never persisted in the browser.

const crypto = require('crypto');
const { parseCookies } = require('./util');

const COOKIE = 'catadmin';
const TTL_MS = 12 * 60 * 60 * 1000;
const attempts = new Map();

function secret() {
  const value = process.env.ADMIN_TOKEN;
  return value && value.length >= 12 ? value : null;
}

function tokenEnabled() {
  return Boolean(secret());
}

// The console is available whenever either an ADMIN_TOKEN is configured or a
// user account carries the admin role. The role comes from the normal session
// middleware, so no second credential is needed for an admin account.
function adminEnabled() {
  return true;
}

function isAdmin(req) {
  return Boolean(req.isAdmin || (req.user && req.user.role === 'admin'));
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function issue() {
  const body = Buffer.from(JSON.stringify({
    exp: Date.now() + TTL_MS,
    nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return false;
  const [body, signature] = token.split('.');
  if (!body || !signature || !secret()) return false;
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Number(parsed.exp) > Date.now() && typeof parsed.nonce === 'string';
  } catch {
    return false;
  }
}

// Basic per-IP throttle for the single password form. State is process-local
// and intentionally ephemeral; it only needs to slow online guessing.
function tooManyAttempts(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (entry.reset <= now) { entry.count = 0; entry.reset = now + 15 * 60 * 1000; }
  entry.count += 1;
  attempts.set(ip, entry);
  if (attempts.size > 5000) {
    for (const [key, value] of attempts) if (value.reset <= now) attempts.delete(key);
  }
  return entry.count > 8;
}

function clearAttempts(req) {
  attempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
}

function middleware(req, _res, next) {
  const cookies = parseCookies(req);
  req.isAdmin = verify(cookies[COOKIE]);
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
  next();
}

function setCookie(res, token) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${Math.floor(TTL_MS / 1000)}`);
}

function clearCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`);
}

module.exports = {
  COOKIE, TTL_MS,
  adminEnabled, tokenEnabled, isAdmin, issue, verify, middleware, requireAdmin,
  tooManyAttempts, clearAttempts, setCookie, clearCookie,
};
