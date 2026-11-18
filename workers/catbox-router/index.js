/**
 * Cloudflare Worker "catbox-router" — public upload entry point.
 *
 * The browser keeps calling /user/api.php. This Worker:
 *   1. enforces the per-file ceiling and a durable per-user quota (KV),
 *   2. fetches the live node registry from the control plane,
 *   3. picks the healthiest node and streams the multipart body to its tunnel,
 *   4. returns the node's response unchanged.
 *
 * Bytes never touch the Express control plane. Node URLs are never exposed to
 * the browser, so no CORS configuration is needed on the node fleet.
 *
 * STATUS: code complete; still needs Wrangler deployment and real bindings.
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024; // keep in sync with MAX_FILE_SIZE on the API
const QUOTA_WINDOW_MS = 60_000;
const QUOTA_MAX = 40;
const REGISTRY_TTL_MS = 10_000;

// Process-local fallbacks. A Worker instance is ephemeral, so real deployments
// must bind QUOTA_KV and CONTROL_PLANE_URL (see wrangler.toml.example).
const localQuota = new Map();
let registryCache = { at: 0, nodes: [] };

function quotaKey(req) {
  const ip = req.headers.get('CF-Connecting-IP')
    || req.headers.get('X-Forwarded-For')
    || 'unknown';
  return `${ip}:${req.headers.get('X-Userhash') || ''}`;
}

async function allowRequest(req, env) {
  const key = `quota:${Math.floor(Date.now() / QUOTA_WINDOW_MS)}:${quotaKey(req)}`;

  if (env.QUOTA_KV) {
    try {
      const raw = await env.QUOTA_KV.get(key, 'json');
      const count = raw?.count || 0;
      if (count >= QUOTA_MAX) return false;
      await env.QUOTA_KV.put(key, { count: count + 1 }, { expirationTtl: 120 });
      return true;
    } catch {
      // Fall through to local limiter if KV is unavailable for a moment.
    }
  }

  const now = Date.now();
  const entry = localQuota.get(key);
  if (!entry || now - entry.start > QUOTA_WINDOW_MS) {
    localQuota.set(key, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= QUOTA_MAX) return false;
  entry.count += 1;
  return true;
}

async function getRegistry(env) {
  if (Date.now() - registryCache.at < REGISTRY_TTL_MS && registryCache.nodes.length) {
    return registryCache.nodes;
  }
  if (env.CONTROL_PLANE_URL) {
    try {
      const response = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/$/, '')}/api/nodes`, {
        signal: AbortSignal.timeout(4000),
        headers: env.NODE_UPLOAD_SECRET
          ? { 'X-Catbox-Secret': env.NODE_UPLOAD_SECRET }
          : {},
      });
      if (response.ok) {
        const payload = await response.json();
        registryCache = { at: Date.now(), nodes: Array.isArray(payload.nodes) ? payload.nodes : [] };
        if (registryCache.nodes.length) return registryCache.nodes;
      }
    } catch { /* fall back to the static registry */ }
  }
  try {
    const list = JSON.parse(env.NODE_REGISTRY || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pickNode(registry) {
  const alive = registry.filter(n =>
    n.status !== 'down' && n.status !== 'unhealthy' && !n.draining
  );
  if (!alive.length) return null;
  const score = node => (Number(node.pending) || 0) + (Number(node.active) || 0) * 2;
  return alive.reduce((best, node) => score(node) < score(best) ? node : best, alive[0]);
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      const nodes = await getRegistry(env);
      return Response.json({ ok: true, nodes: nodes.length });
    }

    const isUpload = request.method === 'POST'
      && (url.pathname === '/user/api.php' || url.pathname === '/litterbox/api.php');
    if (!isUpload) return text(404, 'Not found.');

    if (!await allowRequest(request, env)) return text(429, 'Slow down a little, okay?');

    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_FILE_SIZE) {
      return text(413, `That file is too big. The limit is ${Math.round(MAX_FILE_SIZE / 1048576)} MB.`);
    }

    const node = pickNode(await getRegistry(env));
    if (!node) return text(503, 'No upload nodes are available right now.');

    const upstream = new URL(node.url);
    upstream.pathname = `${upstream.pathname.replace(/\/$/, '')}${url.pathname}`;
    upstream.search = url.search;

    const headers = new Headers(request.headers);
    headers.delete('Host');
    if (env.NODE_UPLOAD_SECRET) headers.set('X-Catbox-Secret', env.NODE_UPLOAD_SECRET);
    headers.set('X-Catbox-Node-Target', node.id);

    try {
      const response = await fetch(upstream.toString(), {
        method: request.method,
        headers,
        body: request.body,
        duplex: 'half',
        signal: AbortSignal.timeout(120_000),
      });
      const out = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      out.headers.set('Access-Control-Allow-Origin', env.FRONTEND_ORIGIN || '*');
      out.headers.set('Access-Control-Allow-Credentials', 'true');
      return out;
    } catch (err) {
      return text(502, `Upload node unavailable: ${err.message}`);
    }
  },
};
