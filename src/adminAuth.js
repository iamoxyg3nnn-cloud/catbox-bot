'use strict';

// Operator authentication for the admin console.
//
// Layered controls (OWASP Session Management / Authentication / CSRF):
//   * high-entropy ADMIN_TOKEN, exchanged once for a signed cookie
//   * __Host- cookie: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain
//   * short idle + absolute lifetime with sliding refresh
//   * binding to the underlying account session (logout kills elevation)
//   * per-account + per-IP brute-force throttling with backoff
//   * optional TOTP step-up (ADMIN_OTP_SECRET / ADMIN_MFA_REQUIRED)
//   * signed double-submit CSRF token delivered over same-origin JSON
//
// An admin-role account session is also accepted; middleware() automatically
// issues an equivalent operator cookie for those requests so they get the same
// CSRF and timeout protections as token logins.

const crypto = require('crypto');
const { parseCookies } = require('./util');
const bruteForce = require('./bruteForce');

const COOKIE = '__Host-catadmin';
const VERSION = 2;
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const MFA_MS = 30 * 60 * 1000;
const TTL_MS = IDLE_MS; // legacy alias
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function secret() {
  const value = process.env.ADMIN_TOKEN;
  return value && value.length >= 12 ? value : null;
}

function tokenEnabled() { return Boolean(secret()); }

// The console exists when a token is configured or an account can hold the
// admin role. Per-request checks decide which (if any) is actually valid.
function adminEnabled() { return true; }

function key(purpose) {
  return crypto.createHash('sha256').update(`${purpose}|${secret() || 'unconfigured'}`).digest();
}

function mac(purpose, data) {
  return crypto.createHmac('sha256', key(purpose)).update(data).digest('base64url');
}

function equal(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sessionId(req) {
  if (!req) return null;
  const token = parseCookies(req).catsess;
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 32);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac('session', body)}`;
}

function decode(token) {
  if (!token || !secret()) return null;
  const [body, signature] = String(token).split('.');
  if (!body || !signature || !equal(signature, mac('session', body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && payload.v === VERSION ? payload : null;
  } catch {
    return null;
  }
}

// Constant-time comparison for the raw ADMIN_TOKEN exchange.
function verifyToken(supplied) {
  const configured = secret();
  const value = String(supplied || '');
  if (!configured || value.length > 512) return false;
  return equal(value, configured);
}

function verify(req) {
  const token = req && parseCookies(req)[COOKIE];
  const payload = decode(token);
  if (!payload) return null;
  const now = Date.now();
  if (!(Number(payload.exp) > now)) return null;
  if (!(Number(payload.iat) > 0) || now - Number(payload.iat) > ABSOLUTE_MS) return null;
  const bound = sessionId(req);
  if (payload.sid === 'token') {
    if (bound) return null; // token cookie must not coexist with an account session
  } else if (!bound || payload.sid !== bound) {
    return null;
  }
  return payload;
}

function makePayload(req, options = {}) {
  const now = Date.now();
  return {
    v: VERSION,
    sid: options.sid || sessionId(req) || 'token',
    iat: Number(options.iat) || now,
    exp: now + IDLE_MS,
    nonce: crypto.randomBytes(16).toString('hex'),
    mfa: Boolean(options.mfa),
    mfaAt: Number(options.mfaAt) || now,
  };
}

function commit(req, res, payload) {
  if (res) setCookie(res, payload);
  if (req) {
    req.adminSession = payload;
    req.isAdmin = true;
    req.adminMethod = payload.sid === 'token' ? 'token' : 'account';
  }
  return payload;
}

// Backwards-compatible with the old `issue()` (no args) call site: returns a
// signed token string when no req/res is supplied.
function issue(req, res, options = {}) {
  const payload = makePayload(req, options);
  if (!req && !res) return sign(payload);
  return commit(req, res, payload);
}

function setCookie(res, value) {
  const token = typeof value === 'string' ? value : sign(value);
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${Math.floor(IDLE_MS / 1000)}`);
}

function clearCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`);
}

function refresh(req, res) {
  const payload = req && req.adminSession;
  if (!payload) return null;
  return commit(req, res, { ...payload, exp: Date.now() + IDLE_MS });
}

function isAdmin(req) {
  return Boolean(req && (req.isAdmin || (req.user && req.user.role === 'admin')));
}

function middleware(req, res, next) {
  const payload = verify(req);
  const bound = sessionId(req);
  const byAccount = Boolean(req.user && req.user.role === 'admin');
  req.adminSession = payload;
  req.isAdmin = Boolean(payload || byAccount);
  req.adminMethod = payload ? (payload.sid === 'token' ? 'token' : 'account') : (byAccount ? 'account' : null);

  // Account admins get the same hardened cookie so CSRF/timeouts apply to them.
  if (byAccount && (!payload || (bound && payload.sid !== bound))) {
    const issued = makePayload(req, { sid: bound || 'token' });
    // Preserve an existing absolute lifetime when refreshing an account cookie.
    if (payload && payload.sid === (bound || 'token')) issued.iat = Number(payload.iat) || issued.iat;
    commit(req, res, issued);
  }
  next();
}

/* ------------------------------- TOTP MFA ------------------------------- */

function otpSecret() {
  const value = String(process.env.ADMIN_OTP_SECRET || '').trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
  return value.length >= 16 ? value : null;
}

function mfaConfigured() { return Boolean(otpSecret()); }
function mfaRequired() { return mfaConfigured() && process.env.ADMIN_MFA_REQUIRED === '1'; }

function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(input || '')) {
    const index = BASE32.indexOf(ch);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpCode(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function verifyTotp(code) {
  const configured = otpSecret();
  if (!configured) return false;
  const supplied = String(code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(supplied)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let delta = -1; delta <= 1; delta++) {
    if (equal(supplied, totpCode(configured, step + delta))) return true;
  }
  return false;
}

function mfaSetup() {
  const configured = otpSecret();
  if (!configured) return { enabled: false, required: false };
  return {
    enabled: true,
    required: mfaRequired(),
    otpauth: `otpauth://totp/MewPocket%3Aadmin?secret=${configured}&issuer=MewPocket&algorithm=SHA1&digits=6&period=30`,
  };
}

function mfaSatisfied(req) {
  if (!mfaRequired()) return true;
  const payload = req && req.adminSession;
  return Boolean(payload && payload.mfa && Date.now() - Number(payload.mfaAt) < MFA_MS);
}

function markMfa(req, res) {
  const payload = (req && req.adminSession) || makePayload(req);
  return commit(req, res, { ...payload, mfa: true, mfaAt: Date.now(), exp: Date.now() + IDLE_MS });
}

/* --------------------------------- CSRF --------------------------------- */

// OWASP signed double-submit: HMAC over session-bound data, sent in a custom
// header. Cross-origin JS cannot set a custom header without a CORS preflight,
// and originGuard independently rejects cross-origin state changes.
function csrfFor(req) {
  const payload = req && req.adminSession;
  if (!payload) return null;
  return mac('csrf', `${payload.sid}|${payload.nonce}`);
}

function requireCsrf(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const expected = csrfFor(req);
  const supplied = String(req.get('x-csrf-token') || '');
  if (!expected || !equal(supplied, expected)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.', csrf: true });
  }
  next();
}

/* ------------------------------ route guards ---------------------------- */

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
  if (!mfaSatisfied(req)) return res.status(403).json({ error: 'MFA verification required.', mfaRequired: true });
  next();
}

/* ------------------------------ throttling ------------------------------ */

function clientIp(req) {
  return String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown');
}

function lockout(req) { return bruteForce.check(clientIp(req), 'admin-token'); }

function tooManyAttempts(req) {
  const state = lockout(req);
  return state.blocked || state.attempts >= bruteForce.MAX_FAILURES;
}

function recordFailure(req) { bruteForce.fail(clientIp(req), 'admin-token'); }
function clearAttempts(req) { bruteForce.clear(clientIp(req), 'admin-token'); }

module.exports = {
  COOKIE, VERSION, IDLE_MS, ABSOLUTE_MS, MFA_MS, TTL_MS,
  adminEnabled, tokenEnabled, isAdmin,
  issue, verify, verifyToken, middleware, requireAdmin,
  setCookie, clearCookie, refresh,
  csrfFor, requireCsrf,
  mfaConfigured, mfaRequired, mfaSetup, verifyTotp, mfaSatisfied, markMfa,
  lockout, tooManyAttempts, recordFailure, clearAttempts,
};
