/* Hybrid CDN rotation — steers each session between the Vercel edge and the
 * Cloudflare edge. Both origins serve the identical UI and API, so steering at
 * page-load time keeps every request same-origin (sessions and cookies keep
 * working) while still spreading traffic across both CDNs. This avoids the
 * known downsides of proxying Vercel through Cloudflare (lost IP/geo data,
 * bot-rule degradation, two independent caches).
 *
 * Strategy:
 *   1. Probe a tiny static file (edge latency) and /api/config (API health)
 *      on both origins with a hard timeout.
 *   2. Fail over immediately if the current origin cannot serve the app.
 *   3. Prefer a materially faster edge, using an EWMA to avoid flapping.
 *   4. Otherwise rotate a deterministic slice of new home-page sessions so
 *      both CDNs are genuinely used, not just held in reserve.
 *   5. Remember the choice per tab session and never redirect twice, so
 *      redirect loops are impossible.
 */
(() => {
  'use strict';

  const ORIGINS = [
    { id: 'vercel', name: 'Vercel', origin: 'https://mew-pocket.vercel.app' },
    { id: 'cloudflare', name: 'Cloudflare', origin: 'https://api.mew-pocket.de5.net' },
  ];

  const STICKY_KEY = 'mew-cdn-sticky';
  const REDIRECT_KEY = 'mew-cdn-redirected';
  const STATE_KEY = 'mew-cdn-health';
  const PING_PATH = '/ping.txt';
  const API_PATH = '/api/config';
  const TIMEOUT_MS = 2500;
  const SLOWER_BY_MS = 250;   // only move for a clear latency win
  const ROTATE_SHARE = 15;    // percent of new home-page sessions sent to the other edge
  const RECHECK_MS = 120000;  // baseline background re-check interval
  const COOLDOWN_MS = 60000;  // skip an edge briefly after it fails

  const self = ORIGINS.find(o => o.origin === location.origin) || null;
  const health = loadHealth();
  const state = { current: self, chosen: self, results: [], reason: 'local' };
  window.MewCDN = state;

  function loadHealth() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STATE_KEY));
      if (saved && typeof saved === 'object') return saved;
    } catch { /* private mode or corrupt cache */ }
    return Object.fromEntries(ORIGINS.map(o => [o.id, { rtt: null, cooldownUntil: 0 }]));
  }
  function saveHealth() {
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify(health)); } catch { /* ignore */ }
  }

  function timedFetch(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const started = performance.now();
    // no-cors keeps health probes independent of CORS policy on either edge.
    return fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
      .then(() => ({ ok: true, ms: performance.now() - started }),
            () => ({ ok: false, ms: TIMEOUT_MS }))
      .finally(() => clearTimeout(timer));
  }

  async function probe(target) {
    const stamp = Date.now();
    const [edge, api] = await Promise.all([
      timedFetch(`${target.origin}${PING_PATH}?__cdn=${stamp}`),
      timedFetch(`${target.origin}${API_PATH}?__cdn=${stamp}`),
    ]);
    return {
      ...target,
      edgeOk: edge.ok,
      apiOk: api.ok,
      ok: edge.ok && api.ok,
      ms: Math.round(edge.ms),
    };
  }

  function bucket() {
    let seed;
    try { seed = sessionStorage.getItem(STICKY_KEY); } catch { seed = null; }
    if (!seed) {
      seed = String(Math.random()).slice(2);
      try { sessionStorage.setItem(STICKY_KEY, seed); } catch { /* ignore */ }
    }
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    return hash % 100;
  }

  function decide(results) {
    const now = Date.now();
    for (const r of results) {
      const h = health[r.id];
      if (!h) continue;
      if (r.ok) {
        h.rtt = h.rtt == null ? r.ms : h.rtt * 0.7 + r.ms * 0.3; // EWMA
        if (now >= h.cooldownUntil) h.cooldownUntil = 0;
      } else {
        h.cooldownUntil = now + COOLDOWN_MS;
      }
    }
    saveHealth();

    const usable = results.filter(r => r.ok && Date.now() >= (health[r.id]?.cooldownUntil || 0));
    if (!usable.length) return { target: state.current, reason: 'no-healthy-edge' };
    if (!state.current) return { target: usable[0], reason: 'unknown-origin' };

    const currentResult = results.find(r => r.id === state.current.id);
    if (!currentResult?.ok) return { target: usable[0], reason: 'failover' };

    const ranked = [...usable].sort((a, b) =>
      (health[a.id]?.rtt ?? a.ms) - (health[b.id]?.rtt ?? b.ms));
    const fastest = ranked[0];
    if (fastest.id !== state.current.id &&
        (health[state.current.id]?.rtt ?? currentResult.ms) - (health[fastest.id]?.rtt ?? fastest.ms) > SLOWER_BY_MS) {
      return { target: fastest, reason: 'latency' };
    }

    if (location.pathname === '/' && usable.length > 1 && bucket() < ROTATE_SHARE) {
      const other = usable.find(r => r.id !== state.current.id);
      if (other) return { target: other, reason: 'rotation' };
    }
    return { target: state.current, reason: 'sticky' };
  }

  function paint() {
    document.documentElement.dataset.cdn = state.chosen ? state.chosen.id : 'unknown';
    const badge = document.getElementById('cdn-status');
    if (!badge) return;
    const rows = state.results.map(r => {
      const rtt = health[r.id]?.rtt;
      const detail = r.ok ? `${r.ms} ms${rtt ? ` · ewma ${Math.round(rtt)}` : ''}` : (r.apiOk ? 'API only' : 'down');
      return `<span class="${r.ok ? 'status-up' : 'status-down'}">${r.name} ${detail}</span>`;
    }).join(' · ');
    badge.innerHTML = `${rows} · serving: ${state.chosen?.name || 'unknown'} (${state.reason})`;
  }

  async function run(allowRedirect) {
    if (!self) { paint(); return; } // localhost / preview deployments: observe only
    const results = await Promise.all(ORIGINS.map(probe));
    state.results = results;
    const { target, reason } = decide(results);
    state.chosen = target;
    state.reason = reason;
    paint();

    if (!allowRedirect || !target || target.origin === location.origin) return;
    let redirected;
    try { redirected = sessionStorage.getItem(REDIRECT_KEY); } catch { redirected = null; }
    if (redirected) return;          // one steering decision per tab session
    try { sessionStorage.setItem(REDIRECT_KEY, target.id); } catch { /* ignore */ }
    location.replace(target.origin + location.pathname + location.search + location.hash);
  }

  // Explicit override: ?cdn=vercel / ?cdn=cloudflare (handy for testing).
  const forced = new URLSearchParams(location.search).get('cdn');
  if (forced === 'vercel' || forced === 'cloudflare') {
    const target = ORIGINS.find(o => o.id === forced);
    if (target) {
      state.chosen = target;
      state.reason = 'manual';
      paint();
      if (target.origin !== location.origin) {
        const url = new URL(location.href);
        url.searchParams.delete('cdn');
        location.replace(target.origin + url.pathname + url.search + url.hash);
      }
      return;
    }
  }

  run(true);
  const jitter = Math.round((Math.random() - 0.5) * 20000);
  setInterval(() => run(false), RECHECK_MS + jitter);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) run(false); // refresh status, never auto-redirect later
  });
})();
