'use strict';

// Defense-in-depth controls that wrap the operator console and its API.
// These complement (never replace) authentication and CSRF tokens.

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function allowedOrigins() {
  const origins = new Set([
    'https://mew-pocket.vercel.app',
    'https://api.mew-pocket.de5.net',
  ]);
  for (const value of [process.env.ADMIN_ALLOWED_ORIGINS, process.env.PUBLIC_BASE_URL]) {
    for (const part of String(value || '').split(',')) {
      const origin = part.trim().replace(/\/+$/, '');
      if (/^https:\/\/[^\s/]+$/i.test(origin)) origins.add(origin);
    }
  }
  return origins;
}

function originAllowed(value) {
  try {
    return allowedOrigins().has(new URL(String(value)).origin);
  } catch {
    return false;
  }
}

// Applied to /admin and /api/admin/* only. The console has no third-party
// scripts, fonts or frames, so a restrictive allow-list costs nothing.
// Inline <script>/<style> blocks in the legacy console are allowed by hash,
// computed from the served file rather than by 'unsafe-inline'.
function csp(scriptHashes = [], styleHashes = []) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    `style-src 'self' ${styleHashes.join(' ')}`.trim(),
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
  ].join('; ');
}

function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', csp());
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

// Rejects cross-site state changes even if a CSRF token were ever leaked.
// Requests from non-browser clients (no Origin/Sec-Fetch headers) still reach
// the CSRF token check, so this is purely additive.
function originGuard(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }
  const origin = req.get('origin');
  if (origin && !originAllowed(origin)) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  if (!origin && !site) {
    const referer = req.get('referer');
    if (referer && !originAllowed(referer)) {
      return res.status(403).json({ error: 'Request referrer is not allowed.' });
    }
  }
  next();
}

function parseCidr(value) {
  const match = /^([0-9.]+)\/(\d{1,2})$/.exec(value);
  if (!match) return null;
  const octets = match[1].split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const bits = Number(match[2]);
  if (bits < 0 || bits > 32) return null;
  const address = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { address: address & mask, mask };
}

// Optional IP allow-list. Requires TRUST_PROXY=1 behind Vercel/Cloudflare so
// req.ip reflects X-Forwarded-For rather than the edge's own address.
function ipGuard(req, res, next) {
  const configured = String(process.env.ADMIN_ALLOWED_IPS || '').trim();
  if (!configured) return next();
  // Express/Node commonly reports IPv4-mapped IPv6 (::ffff:203.0.113.5).
  const ip = String(req.ip || '').replace(/^::ffff:/i, '');
  const cidrs = [];
  const exact = new Set();
  for (const part of configured.split(',')) {
    const value = part.trim();
    if (!value) continue;
    const cidr = parseCidr(value);
    if (cidr) cidrs.push(cidr);
    else exact.add(value);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  let numeric = null;
  if (ipv4) {
    const o = ipv4.slice(1).map(Number);
    if (o.every(n => n >= 0 && n <= 255)) numeric = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  }
  const allowed = exact.has(ip) || cidrs.some(cidr => numeric !== null && (numeric & cidr.mask) === cidr.address);
  if (!allowed) return res.status(403).json({ error: 'This IP is not allowed.' });
  next();
}

const MAX_EVENTS = 250;
const events = [];

function audit(req, action, detail = {}) {
  const entry = {
    at: new Date().toISOString(),
    action,
    ip: req.ip || null,
    actor: req.user && req.user.username ? req.user.username : (req.adminSession && req.adminSession.sid) || null,
    method: req.method,
    path: String(req.originalUrl || req.path || '').split('?')[0],
    ...detail,
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.shift();
  console.warn('[admin-audit] ' + JSON.stringify(entry));
  return entry;
}

function recentAudit(limit = 100) {
  const count = Math.min(MAX_EVENTS, Math.max(1, Number(limit) || 100));
  return events.slice(-count).reverse();
}

module.exports = {
  MUTATING, csp, securityHeaders, originGuard, ipGuard, originAllowed,
  audit, recentAudit, MAX_EVENTS,
};
