'use strict';

const path = require('path');

// Parse a size value that may be raw bytes or a friendly "20mb"/"20MiB" string.
function parseSize(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/.exec(raw);
  if (!match) return fallback;
  const n = Number(match[1]);
  const unit = match[2] || 'b';
  const factors = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 };
  return Math.floor(n * factors[unit]);
}

// Discord bots may be supplied as a single token/channel pair (handy for the
// first live verification) or as a JSON array for the 20-bot fleet.
function parseBots() {
  const raw = process.env.DISCORD_BOTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(b => b && b.id && b.token && b.channelId)
          .map(b => ({ id: String(b.id), token: String(b.token), channelId: String(b.channelId) }));
      }
    } catch { /* fall through to the single-bot form */ }
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (token && channelId) {
    return [{ id: process.env.DISCORD_BOT_ID || 'primary', token, channelId }];
  }
  return [];
}

const config = {
  // TCP port the HTTP server listens on.
  port: parseInt(process.env.PORT || '3000', 10),

  // Public origin used when building returned upload URLs (e.g. inside API
  // responses). When unset, the origin is derived from each incoming request's
  // Host header, so the clone works on localhost, LAN IPs or real hostnames
  // without reconfiguration.
  baseUrl: process.env.PUBLIC_BASE_URL || null,

  // How /files/:name delivers bytes. "proxy" streams storage bytes through
  // this origin so the browser keeps showing our own domain; "redirect" is the
  // legacy 302-to-CDN behaviour. Discord remains the only durable byte store
  // either way.
  fileDelivery: process.env.FILE_DELIVERY === 'redirect' ? 'redirect' : 'proxy',

  // Where uploaded bytes are staged while they are being sent to Discord.
  // This directory is transient: production must never treat it as storage.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // In-flight upload bodies are staged on the node's local disk. Production
  // Windows runners set STAGING_DIR=D:\catbox_staging so the body survives a
  // Discord upload failure and is deleted only after Discord confirms it.
  // Local/test runs keep the old ./data/tmp path when the variable is absent.
  stagingDir: process.env.STAGING_DIR || null,
  // Only in-flight upload bodies live here; there is no permanent files dir.
  get tmpDir() { return this.stagingDir || path.join(this.dataDir, 'tmp'); },
  get dbPath() { return path.join(this.dataDir, 'catbox.db'); },

  // Hub-and-spoke deployment. A spoke (NODE_MODE=node) runs exactly one Discord
  // bot, skips the admin console, job runner and metadata mirror (all of which
  // are single-writer), and heartbeats its per-session public URL to the hub.
  // The hub forwards uploads to the least-loaded healthy spoke and falls back
  // to its own bots when no spoke is available.
  nodeMode: process.env.NODE_MODE === 'node',
  nodeId: process.env.NODE_ID || 'local',
  controlPlaneUrl: process.env.CONTROL_PLANE_URL || null,
  nodePublicUrl: process.env.NODE_PUBLIC_URL || null,
  nodeHeartbeatMs: parseInt(process.env.NODE_HEARTBEAT_MS || '15000', 10),
  nodeStaleAfterMs: parseInt(process.env.NODE_STALE_AFTER_MS || '60000', 10),

  // Discord's practical non-Nitro per-file limit. Configurable so chunking can
  // be added later without changing callers.
  maxFileSize: parseSize(process.env.MAX_FILE_SIZE, 20 * 1024 * 1024),

  discord: {
    // Only the mock transport exists for tests; production always uses Discord.
    transport: process.env.DISCORD_TRANSPORT === 'mock' ? 'mock' : 'discord',
    apiBase: process.env.DISCORD_API_BASE || 'https://discord.com/api/v10',
    userAgent: process.env.DISCORD_USER_AGENT || 'DiscordBot (catbox-clone, 1.0)',
    timeoutMs: parseInt(process.env.DISCORD_TIMEOUT_MS || '120000', 10),
    maxRetries: parseInt(process.env.DISCORD_MAX_RETRIES || '3', 10),
    // Bounded parallel Discord requests per bucket. The rate-limit headers and
    // 429 handler remain the hard cap; this only lets a saturated runner keep
    // several uploads in flight instead of fully serialising every request.
    requestConcurrency: Math.max(1, parseInt(process.env.DISCORD_REQUEST_CONCURRENCY || '4', 10)),
    // Adaptive ceiling: a bucket halves its concurrency on a 429 and grows
    // back one request at a time while X-RateLimit-Remaining shows headroom.
    maxConcurrency: Math.max(1, parseInt(process.env.DISCORD_MAX_CONCURRENCY || '8', 10)),
    bots: parseBots(),
  },

  // Max files accepted in one album (catbox historically caps albums at 500).
  albumMaxFiles: 500,

  // Session lifetime for logged-in accounts.
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,

  // Extensions refused outright, both client- and server-side.
  blockedExtensions: ['exe', 'scr', 'doc', 'jar'],

  // Litterbox-style temporary storage windows.
  litterboxTimes: {
    '1h': 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '72h': 72 * 60 * 60 * 1000,
  },

  // Contact address shown on the contact page.
  contactEmail: process.env.CONTACT_EMAIL || 'admin@localhost',

  // Coarse per-IP upload throttle (window -> max upload requests). Tunable so
  // operators can raise it for a controlled load test; production default stays
  // at 40/min to keep a single abusive source from saturating a runner.
  rateLimit: {
    windowMs: 60 * 1000,
    maxUploads: Math.max(1, parseInt(process.env.UPLOAD_MAX_PER_MIN || '40', 10)),
  },

  // Browser batch queue tuning. These are hints only; the queue still caps
  // concurrency locally, and the server remains authoritative on file size.
  batching: {
    concurrency: Math.max(1, Math.min(16, parseInt(process.env.BATCH_CONCURRENCY || '5', 10) || 5)),
    adaptive: process.env.BATCH_ADAPTIVE !== '0',
    maxConcurrency: Math.max(5, Math.min(16, parseInt(process.env.BATCH_MAX_CONCURRENCY || '8', 10) || 8)),
    maxFiles: Math.max(1, Math.min(100, parseInt(process.env.BATCH_MAX_FILES || '100', 10) || 100)),
  },

  // Overload admission. A request is refused only when every healthy spoke AND
  // the hub's own Discord buckets are saturated, so a single busy runner never
  // turns into a user-visible outage while spare capacity exists elsewhere.
  admission: {
    nodeSaturationScore: Math.max(1, parseInt(process.env.NODE_SATURATION_SCORE || '12', 10) || 12),
    localActiveMax: Math.max(1, parseInt(process.env.LOCAL_ACTIVE_MAX || '16', 10) || 16),
    retryAfterSeconds: Math.max(1, parseInt(process.env.OVERLOAD_RETRY_AFTER || '10', 10) || 10),
  },

  // Recovery knobs for uploads that are interrupted mid-flight. A job left in
  // `uploading` past staleAfterMs is assumed abandoned by a dead process and is
  // requeued; orphaned temp files older than tempMaxAgeMs are swept.
  uploadRecovery: {
    staleAfterMs: parseInt(process.env.STALE_JOB_AFTER_MS || '180000', 10),
    sweepMs: parseInt(process.env.JOB_RECOVERY_SWEEP_MS || '30000', 10),
    tempMaxAgeMs: parseInt(process.env.TEMP_MAX_AGE_MS || '1800000', 10),
    tempSweepMs: parseInt(process.env.TEMP_SWEEP_MS || '600000', 10),
    // Wall-clock ceiling for receiving one HTTP upload body. The browser also
    // runs an inactivity watchdog so a stalled client does not wait this long.
    bodyTimeoutMs: parseInt(process.env.UPLOAD_BODY_TIMEOUT_MS || '600000', 10),
  },
};

// Build an absolute public URL for a site-relative path.
function publicUrl(req, sitePath) {
  const base = config.baseUrl || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/+$/, '') + sitePath;
}

module.exports = { config, publicUrl, parseSize };
