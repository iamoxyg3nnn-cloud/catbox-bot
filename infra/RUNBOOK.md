# Operations runbook — Discord-backed Catbox clone

Companion to `architecture/01-ARCHITECTURE.md`. This file covers P6 operations.
Nothing here has been deployed yet; treat it as the target procedure.

## 1. Secrets inventory

Never commit any of these. Store in GitHub Actions Secrets / Wrangler secrets.

| Secret | Where | Purpose |
|---|---|---|
| `DISCORD_BOTS` | Control plane + node fleet | JSON array of `{id,token,channelId}` (20 entries). First test: `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID` |
| `NODE_UPLOAD_SECRET` | Worker + nodes + control plane | Shared secret for `/upload` and `/internal/files` |
| `API_TUNNEL_TOKEN`, `DB_TUNNEL_TOKEN` | `catbox-actions` GitHub repo | Cloudflare Tunnel tokens for PostgREST (HTTP) and Redis (TCP) |
| `POSTGRES_PASSWORD`, `JWT_SECRET`, `REDIS_PASSWORD` | `catbox-actions` GitHub repo | Credentials for the self-hosted Docker stack and PostgREST JWT |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Control plane | Cloned PostgREST metadata backend; `SUPABASE_URL` is the tunnel root (adapter appends `/rest/v1`) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Control plane | Rate counters + CDN URL cache (optional, free tier) |
| `QUOTA_KV` namespace | Cloudflare Worker | KV binding id in `wrangler.toml` (not a secret) |
| `NODE_REGISTRY` | Worker | JSON list of alive node tunnels (optional fallback to `CONTROL_PLANE_URL`) |
| `API_BASE` | Frontend (public, not a secret) | Worker URL for browser uploads |

## 2. First-time setup

1. Create public `catbox-actions` repo from the existing `Supabase-Actions` stack.
2. Apply `infra/supabase/schema.sql` to the **new** Supabase project.
3. Seed `discord_bots` with the 20 bot IDs and channel IDs (no tokens in DB).
4. Set control-plane env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NODE_UPLOAD_SECRET`, `MAX_FILE_SIZE=20mb`, `PUBLIC_BASE_URL`.
5. Deploy the frontend to Vercel/Cloudflare Pages; set `API_BASE` to the Worker URL.
6. Deploy the Worker with `wrangler deploy`; set `NODE_UPLOAD_SECRET` and `NODE_REGISTRY` via `wrangler secret put`.
7. Build `node-worker/` on a node (`go build ./...`) and roll out to node-1..node-18 with `STAGING_DIR=D:\catbox_staging`.

## 3. Live Discord verification (do this before any fleet rollout)

One command checks token, upload, signed CDN bytes, around-message refresh,
delete and the resulting 404 for each configured bot:

```bash
# One bot first
DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_ID=... node scripts/verify-discord.js

# Then all 20 bots/channels
DISCORD_BOTS='[{"id":"bot-1","token":"...","channelId":"..."}, ...]' \
  node scripts/verify-discord.js --all
```

The script never prints tokens and removes its tiny temp file on every path.
It refuses to run with `DISCORD_TRANSPORT=mock`. Watch the printed Discord
counters for 429s and confirm throughput spreads across bots rather than
hitting one channel bucket. Keep the API-level checks below as a second pass
after the transport is known good:

```bash
DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_ID=... npm start
curl -F "reqtype=fileupload" -F "fileToUpload=@tiny.txt" http://localhost:3000/user/api.php
curl -I http://localhost:3000/files/<name>          # -> 302 to cdn.discordapp.com
curl -H "X-Catbox-Async: 1" -F "reqtype=fileupload" -F "fileToUpload=@tiny.txt" ...
curl http://localhost:3000/api/jobs/<job_id>        # poll until ready
```

## 4. Monitoring alerts

- `GET /api/health` on each node: `pending > 500` sustained → add nodes or lower intake.
- `upload_jobs` with `status='queued'` older than 5 minutes → worker starvation.
- `discord_bots.health='unhealthy'` → token revoked/channel deleted; rotate.
- 429 rate > 5% of Discord requests → reduce concurrency or add channels.
- `D:\catbox_staging` free space < 20% → trigger reaper / drain node.
- Signed URL refresh failures → bot lost `View Channel` / `Read Message History`.

## 5. Common recovery actions

**Token revoked / 401:** set `health='unhealthy'` for that bot in `discord_bots`,
replace the token in node secrets, restart the node worker, then set health back.

**Node dies mid-upload:** staged file remains on `D:`. On restart `recoverStale()`
requeues files older than the TTL. The expiry purge deletes the Discord message
first, so no orphan bytes are left in Discord from a failed metadata write —
**exception:** if Discord upload succeeded but the control-plane write failed,
the message exists without metadata. The next journal sweep should locate it by
`message_id` and either record it or delete the message.

**Stale CDN URLs:** `GET /channels/{id}/messages?around={message}&limit=1`
refreshes them. The `cdn:*` Redis cache is invalidated on delete.

**Drain a node:** set `status='down'` (or `draining=true`) in `NODE_REGISTRY`,
wait for `active=0` on `/api/health`, then stop the worker.

**Discord ban / mass 429:** pause all workers, reduce `UPLOAD_MAX_CONCURRENT`,
do NOT rotate IPs or use proxies (prohibited by Discord Developer Policy),
and resume gradually.

## 6. Known gaps (handoff)

- Go node worker is uncompiled; needs a build on a real node.
- Crash recovery writes a `<job_id>.json` sidecar next to each staged file and
  replays recent orphans with their original name/MIME/owner; sidecar-less
  orphans are discarded. Verify this path once the worker is compiled.
- Worker quota is durable via `QUOTA_KV`; create the KV namespace before deploy.
- `/ops` charts the 429 rate and staged disk usage from `GET /api/metrics`; both
  are also available as JSON (`discord.rateLimitPct`, `staging.bytes/files`) for
  external dashboards. Counters are process-local and reset on restart.
