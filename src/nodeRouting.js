'use strict';

// Hub-and-spoke upload routing.
//
// The hub (NODE_MODE unset) keeps the public API and admin console. Spokes
// (NODE_MODE=node) run exactly one Discord bot each, in their own repo and on
// their own Windows runner, and advertise their per-session public URL to the
// hub with a short heartbeat. The hub streams an incoming upload to the
// least-loaded healthy spoke and falls back to its own bots if none is usable.

const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { config } = require('./config');
const { sanitizeOriginalName } = require('./util');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Same scoring as workers/catbox-router/index.js so both routers behave alike.
function score(node) {
  return (Number(node.pending) || 0) + (Number(node.active) || 0) * 2;
}

// Dead runners must stop receiving traffic even if their last heartbeat said
// "up". Heartbeats are 15s apart, so 60s without one means the session ended.
function pickNode(nodes, now = Date.now(), staleAfterMs = config.nodeStaleAfterMs) {
  const alive = (nodes || []).filter(node =>
    node && node.web_url
    && node.status !== 'down'
    && node.status !== 'unhealthy'
    && !node.draining
    && (now - (Number(node.last_heartbeat) || 0)) <= staleAfterMs
  );
  if (!alive.length) return null;
  return alive.reduce((best, node) => score(node) < score(best) ? node : best, alive[0]);
}

// Build a multipart body that looks exactly like the browser's upload, using a
// readable stream so a 20 MiB body never has to be buffered in memory twice.
function buildForwardBody(filePath, originalName, mime, fields = {}) {
  const boundary = `----catboxnode${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${String(value)}\r\n`
    );
  }
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="fileToUpload"; filename="${sanitizeOriginalName(originalName)}"\r\n` +
    `Content-Type: ${mime || 'application/octet-stream'}\r\n\r\n`
  );
  const preamble = Buffer.from(parts.join(''), 'utf8');
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  async function* chunks() {
    yield preamble;
    for await (const chunk of fs.createReadStream(filePath)) yield chunk;
    yield closing;
  }
  return {
    body: Readable.from(chunks()),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// Forward the already-staged multipart file to one spoke. Returns the spoke's
// plain-text response so the client still receives a synchronous 200 + URL.
async function forwardUpload(node, req) {
  const file = req.file;
  if (!file || !node || !node.web_url) throw new Error('No staged file or node URL.');
  const { body, contentType } = buildForwardBody(
    file.path, file.originalname, file.mimetype,
    { reqtype: req.body?.reqtype || 'fileupload', userhash: req.body?.userhash, time: req.body?.time }
  );
  const base = String(node.web_url).replace(/\/+$/, '');
  const response = await fetch(`${base}/user/api.php`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Catbox-Secret': process.env.NODE_UPLOAD_SECRET || '',
      'X-Catbox-Node-Target': String(node.node_id || node.id || 'unknown'),
      'User-Agent': 'CatboxHub/1.0',
    },
    body,
    duplex: 'half',
    signal: AbortSignal.timeout(config.discord.timeoutMs),
  });
  const text = (await response.text()).trim();
  return { status: response.status, text };
}

// Spoke side: tell the hub where to send uploads for this session.
async function heartbeatOnce() {
  if (!config.controlPlaneUrl || !config.nodePublicUrl) return false;
  const secret = process.env.NODE_UPLOAD_SECRET;
  if (!secret) return false;
  const payload = {
    node_id: config.nodeId,
    hostname: require('os').hostname(),
    web_url: config.nodePublicUrl,
    status: 'up',
    pending: 0,
    active: 0,
    draining: false,
    staged_bytes: 0,
    staged_files: 0,
  };
  const response = await fetch(`${config.controlPlaneUrl.replace(/\/+$/, '')}/internal/nodes/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Catbox-Secret': secret,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}

function startHeartbeat() {
  if (!config.nodeMode) return;
  const tick = async () => {
    try {
      if (await heartbeatOnce()) console.log(`[node ${config.nodeId}] heartbeat -> ${config.controlPlaneUrl}`);
      else console.warn(`[node ${config.nodeId}] heartbeat skipped (tunnel/secret not ready)`);
    } catch (err) {
      console.warn(`[node ${config.nodeId}] heartbeat failed: ${err.message}`);
    }
  };
  tick();
  setInterval(tick, config.nodeHeartbeatMs).unref();
  // A spoke's URL is only valid for this runner session. Never leave a stale
  // "up" row behind if the process is asked to exit.
  const retire = async () => {
    try {
      if (!config.controlPlaneUrl || !process.env.NODE_UPLOAD_SECRET) return;
      await fetch(`${config.controlPlaneUrl.replace(/\/+$/, '')}/internal/nodes/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Catbox-Secret': process.env.NODE_UPLOAD_SECRET,
        },
        body: JSON.stringify({
          node_id: config.nodeId,
          web_url: config.nodePublicUrl || '',
          status: 'down',
          draining: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best effort */ }
  };
  process.once('SIGTERM', retire);
  process.once('SIGINT', retire);
}

module.exports = { pickNode, score, buildForwardBody, forwardUpload, heartbeatOnce, startHeartbeat, sleep };
