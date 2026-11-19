# Plan — one GitHub repo per Discord bot

Status: **approved for implementation** (2026-11-19). Owner: this session.

## Goal

`mew-pocket/catbox-bot` currently holds five bot tokens in one process. Replace that
with **one repo per bot**, each with its own Windows runner, its own `D:\catbox_staging`
and its own single Discord token, while keeping one public API origin and one admin
console.

## Decision: hub and spoke (not five full stacks)

I rejected "five independent full Express repos" because the code has three
single-writer assumptions that would race across repos:

| Problem | Where | Effect of 5 full repos |
|---|---|---|
| Global job claim | `infra/supabase/schema.sql:157-176`, `src/adapters/supabase.js:286-289` | One repo claims a job whose staged bytes live on another runner → terminal failure |
| Metadata mirror single writer | `src/metadataMirror.js:53-56,320-338` | All five overwrite the same snapshot channel every minute |
| One tunnel token / one domain | `.github/workflows/catbox-bot.yml:342`, `src/adminSecurity.js:8-19`, `public/vercel.json:4-16` | Needs 5 new tunnels, 5 hostnames, and admin cookies that are process-local |

Instead:

- **`mew-pocket/catbox-bot` stays the hub**: public API, admin console, `/api/nodes`
  registry, `/api/jobs/:id`, download proxy, all bot tokens for reads/deletes.
- **Five new repos are spokes**: `mew-pocket/catbox-bot-1` … `catbox-bot-5`, each
  running the same app in `NODE_MODE=node` with exactly one bot token. No admin, no
  job runner, no metadata mirror. Each heartbeats its per-session public URL into the
  hub's `nodes` table and uploads only bytes routed to it.
- **The hub forwards uploads** to the least-loaded healthy spoke (same scoring as
  `workers/catbox-router/index.js:86-93`), streaming the multipart body and returning
  the spoke's plain-text URL unchanged. If no spoke is healthy, the hub uploads
  locally with its own bots, so a spoke outage never causes downtime.

This reuses the already-written `/api/nodes` + heartbeat + least-loaded plumbing and
requires no Cloudflare Load Balancer, no Wrangler deployment, no new DNS, and no new
secrets from the user.

## Why not the alternatives

- **Cloudflare Worker router** (`workers/catbox-router/index.js`) is code-complete but
  undeployed; deploying it needs a Cloudflare API token and KV namespace that are not
  available here. It 404s every non-upload path, so it cannot front the whole API.
- **Tailscale-only private routing** was ruled out after checking run
  `44472229020`: the Tailscale step caught `A positional parameter cannot be found
  that accepts argument '\'` (PowerShell backslash continuation at workflow line 121)
  and never obtained an IP. I will fix that bug separately, but not depend on it.
- **Supabase-as-byte-relay** would put transient bytes in Supabase; the requirement is
  Discord as the only byte store.

## Implementation steps

1. Fix the Tailscale PowerShell continuation bug (`\` → backtick) — independent fix.
2. Add `NODE_MODE`, `CONTROL_PLANE_URL`, `NODE_PUBLIC_URL`, `NODE_ID` to `src/config.js`.
3. In `server.js`:
   - spoke: start a 15s heartbeat to `CONTROL_PLANE_URL/internal/nodes/heartbeat`, and
     skip job runner / metadata mirror / admin when `NODE_MODE=node`;
   - hub: in the upload route, pick a healthy node from `db.listNodes()`, stream the
     body to `POST {node.web_url}/user/api.php` with `X-Catbox-Secret`, return its
     response; fall back to local upload on any forwarding failure.
   - reap nodes whose `last_heartbeat` is older than 60s so dead spokes stop receiving
     traffic (the registry currently never checks staleness).
4. Add tests for node scoring, stale reaping and forward-fallback.
5. Create five public repos from this codebase. Each workflow:
   - `runs-on: windows-latest`, self-dispatch chain preserved;
   - one bot token secret only, `NODE_MODE=node`, `NODE_ID=bot-N`;
   - a per-session **Cloudflare quick tunnel** (`cloudflared tunnel --url
     http://localhost:3000`), URL captured from stdout and exported as
     `NODE_PUBLIC_URL`; no `CF_TUNNEL_TOKEN` needed for spokes;
   - same `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NODE_UPLOAD_SECRET` as the hub.
6. Set secrets via `gh secret set` (never printed). Copy the existing values locally
   without echoing them.
7. Canary: deploy `catbox-bot-1` only, verify heartbeat → `/api/nodes` → a forwarded
   upload → metadata → download → staged bytes deleted. Then roll out 2–5.
8. Keep all five tokens on the hub for `resolve()`/`remove()`; spokes only need their
   own. Document this in README and `architecture/03-PROGRESS.md`.

## Risks / mitigations

| Risk | Mitigation |
|---|---|
| Quick-tunnel URL changes mid-session | Heartbeat every 15s refreshes `web_url`; hub re-reads registry per upload; 60s stale reaping |
| Spoke down mid-upload | Hub catches forwarding error, falls back to local bot upload; client never sees the error |
| Duplicate Discord messages | Idempotency nonce is generated by the hub and passed through; same `job_id` retry dedupes |
| Metadata races | Spokes do not run metadataMirror; only the hub restores snapshots |
| Admin login breaks | Admin stays only on the hub origin; no cookie/LB changes |
| Vercel rewrites | Unchanged — still point at `api.mew-pocket.de5.net` (the hub) |

## Rollback

Set `NODE_MODE=` on spokes (or disable the hub forwarding flag) and the system returns
to today's single-process behaviour with no metadata migration.
