'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { config } = require('./config');

/* ---------------- names & hashes ---------------- */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Short, URL-safe storage name like catbox uses: 6 chars of [a-z0-9].
function randomName(len = 6) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// 40-hex-char account token, the "userhash" the API speaks in.
function randomUserhash() {
  return crypto.randomBytes(20).toString('hex');
}

/* ---------------- filenames ---------------- */

function extOf(filename) {
  const base = String(filename || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
}

// Keep a display-friendly version of the client-supplied name (extension
// matters, the rest is cosmetic). Never used for storage paths.
function sanitizeOriginalName(filename) {
  const base = String(filename || '').split(/[\\/]/).pop();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'file';
}

function isBlockedUpload(filename, mimetype) {
  const ext = extOf(filename);
  if (ext && config.blockedExtensions.includes(ext)) return true;
  if (mimetype === 'application/exe' || mimetype === 'application/x-msdownload') return true;
  return false;
}

/* ---------------- mime types ---------------- */

const MIME_BY_EXT = {
  // images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  apng: 'image/apng', avif: 'image/avif',
  // video
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  avi: 'video/x-msvideo', m4v: 'video/x-m4v', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  // audio
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', wma: 'audio/x-ms-wma', opus: 'audio/opus',
  // documents & misc
  txt: 'text/plain', log: 'text/plain', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', pdf: 'application/pdf', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', md: 'text/markdown',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  exe: 'application/x-msdownload', scr: 'application/x-msdownload',
  doc: 'application/msword', jar: 'application/java-archive',
};

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'audio/mp4': 'm4a', 'application/pdf': 'pdf', 'application/json': 'json',
  'text/plain': 'txt', 'text/html': 'html', 'application/zip': 'zip',
};

function mimeFor(name) {
  return MIME_BY_EXT[extOf(name) || ''] || 'application/octet-stream';
}

function extForMime(mime) {
  return EXT_BY_MIME[String(mime || '').split(';')[0].trim().toLowerCase()] || 'bin';
}

function isImageMime(mime) { return /^image\//.test(mime); }
function isVideoMime(mime) { return /^video\//.test(mime); }
function isAudioMime(mime) { return /^audio\//.test(mime); }

/* ---------------- passwords ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [version, saltHex, hashHex] = String(stored).split('$');
    if (version !== 's1' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------- cookies ---------------- */

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge) cookie += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.expires) cookie += `; Expires=${new Date(opts.expires).toUTCString()}`;
  cookie += `; Path=${opts.path || '/'}`;
  if (opts.httpOnly) cookie += '; HttpOnly';
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  return cookie;
}

/* ---------------- misc ---------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Hash a staged file without loading it into memory.
async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function limitMessage() {
  return `That file is too big. The limit is ${humanSize(config.maxFileSize)}.`;
}

module.exports = {
  randomName, randomUserhash,
  extOf, sanitizeOriginalName, isBlockedUpload,
  mimeFor, extForMime, isImageMime, isVideoMime, isAudioMime,
  hashPassword, verifyPassword,
  parseCookies, serializeCookie,
  escapeHtml, isValidEmail, humanSize, hashFile, limitMessage,
};
