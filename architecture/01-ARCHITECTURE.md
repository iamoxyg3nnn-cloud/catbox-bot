# Catbox Clone — Full Architecture Plan

Status: **approved for implementation** (updated 2026-11-18)
Workspace: `C:\Users\basud\OneDrive\Desktop\catbox clone\node_modules\`
Companion docs: `02-PHASES.md` (work breakdown), `03-PROGRESS.md` (live tracker).

---

## 1. Objective

Replace the clone's flat local-file byte storage (`data/files`) with **Discord as the only byte store**, while keeping the existing Express/SQLite-shaped API working. Bytes land temporarily on the Windows RDP nodes' `D:` disk, are uploaded to Discord in the background, and are deleted from `D:` only after Discord confirms the message. Public downloads are 302 redirects to Discord's signed CDN URLs.

## 2. Constraints and decisions

| Topic | Decision | Reason |
|---|---|---|
| Byte storage | Discord only. No local/disk/R2 fallback. | User requirement. |
| Auth | **Bot token** (`Authorization: Bot <token>`), 20 bots, one dedicated channel each. | Official auth, can upload/read/delete. Webhooks are IP-limited and IP rotation violates Discord Developer Policy. |
| Upload ceiling | `MAX_FILE_SIZE`, default **20 MiB**. | Discord's practical non-Nitro limit; structured for future chunking. |
| URL delivery | `302` to `cdn.discordapp.com` signed URL. | Cloudflare-fronted global CDN, range requests work. |
| URL refresh | `GET /channels/{channel_id}/messages?around={message_id}&limit=1`. | Documented; returns freshly signed URLs. Avoids undocumented `POST /attachments/refresh-urls`. |
| Deletion | `DELETE /channels/{channel_id}/messages/{message_id}` with the *same bot* that uploaded. | Documented and removes the attachment. |
| Public upload router | **Cloudflare Worker proxy** (`workers/catbox-router`), not 307 redirect. | Free plan allows 100 MB bodies; single origin, no CORS exposure of node tunnels, allows auth/quota/node selection before forwarding. |
| Staging | `D:\catbox_staging\<job_id>` on the Windows runner hosting the control plane. | Each `windows-latest` GitHub runner has a ~150 GiB ephemeral D: drive. Tailscale/RDP expose it interactively but provide **no** storage and no durability; the body stays until Discord confirms, then is deleted. |
| Metadata | Separate cloned Supabase (Postgres) + Redis stack, **not** the existing project's Supabase. | User requirement; avoids cross-project interference. |
| Control plane | Express API in a self-chaining **Windows** GitHub Actions session behind Cloudflare Tunnel, with optional Tailscale RDP. Frontend on Vercel. | Reuses the user's proven `Supabase-Actions` pattern; public repos keep Actions free. D: staging lives on this same runner. |
| Scaling | 20 bots × 50 req/s = ~1,000 req/s theoretical ceiling; real throughput lower. Queue + per-user quotas mandatory. | `X-RateLimit-*` and `Retry-After` must be parsed, never hardcoded. |
| ToS risk | Accepted for personal/experimental use. Multi-bot sharding must not be publicly marketed as a bypass. | Discord Developer Policy forbids circumventing limits; multiple legitimate bot apps are normal, but mass sharding is gray. |

## 3. Component diagram

```
Browser (Vercel / Cloudflare Pages)
  │  POST /user/api.php  (multipart, <=20 MiB)
  ▼
Cloudflare Worker "catbox-router"  (free)
  │  auth / quota / least-loaded node selection
  │  streams body to node tunnel
  ▼
Windows RDP node (node-1..18) — Gin server + cloudflared
  │  streams to D:\catbox_staging\<job_id>
  │  202 { job_id, status_url }
  │  background Discord uploader per bot/channel
  ▼
Discord (20 bots, 20 channels)
  │  attachment URL (signed, expiring)
  ▼
cdn.discordapp.com — Cloudflare edge

Control plane (separate):
  Express API on Actions behind tunnel
   + cloned Supabase (metadata) + Redis (rate buckets, job locks, URL cache)
```

## 4. Request flows

### 4.1 Upload (fileupload / litterbox)
1. Worker receives multipart, selects an alive node with lowest `pending` count, proxies the body.
2. Node streams body to `D:\catbox_staging\<job_id>`; returns `202 { job_id, status_url }`.
3. Node enqueues a job; worker picks a bot/channel using least-loaded selection.
4. Worker POSTs to `POST /channels/{channel_id}/messages?wait=true` with `payload_json` + `files[1]`, streaming from disk (never buffering the file in RAM).
5. On success: verify via message fetch, write `channel_id, message_id, attachment_id, cdn_url, cdn_expires_at, sha256, size` to Supabase, then **delete the staged file from D:**.
6. On failure: retry with parsed `Retry-After`; keep staged file; record journal row; orphan sweeper retries with backoff.

### 4.2 Download
`GET /files/:name` → look up row → `storage.resolve(row)` → `302` to fresh signed CDN URL. No bytes ever traverse the API.

### 4.3 Delete / expiry
`deletefiles` and the hourly purge call `storage.remove(row)` (Discord message delete) **before** deleting the metadata row. Failed deletes leave the row and a journal entry for retry.

### 4.4 URL refresh
Cached in Redis until `cdn_expires_at - 60s`. On miss, fetch message with the recorded bot and extract the attachment by `attachment_id`.

## 5. Metadata model (cloned Supabase)

```
users(id, username, email, password_hash, userhash, created_at)
sessions(token, user_id, expires_at)
files(name PK, owner_hash, original_name, mime, size, sha256,
      uploaded_at, expires_at,
      bot_id, channel_id, message_id, attachment_id, cdn_url, cdn_expires_at,
      status)                       -- queued | uploading | ready | failed
albums(short PK, owner_hash, title, description, created_at)
album_files(album_short, file_name, position)
messages(id, name, email, body, created_at)
upload_jobs(job_id PK, node_id, bot_id, channel_id, staged_path,
            status, attempts, last_error, created_at, updated_at)
discord_bots(bot_id PK, channel_id, enabled, health, last_used_at)
nodes(node_id PK, hostname, web_url, status, pending, active, last_heartbeat)
upload_journal(id PK, job_id, file_name, stage, error, attempts, resolved)
```

Redis keys:
- `rl:bot:{botId}` / `rl:channel:{channelId}` — token buckets from `X-RateLimit-*`
- `job:{jobId}` — state + progress
- `cdn:{messageId}` — signed URL cache
- `q:dicord` — (optional) BullMQ-style job queue

## 6. Rate limiting / queue

- One semaphore per `bot_id` and one per `channel_id` (bounded wait, e.g. 2 minutes).
- Global per-bot ceiling 50 req/s, enforced locally using `X-RateLimit-Limit/Remaining/Reset/Bucket`.
- On `429`: read `retry_after` (seconds) and `X-RateLimit-Global`; sleep, then retry with jitter. Never hardcode bucket sizes.
- On `401/403`: mark bot unhealthy, remove from rotation, alert; do not retry blindly.
- Per-user quotas in the Worker prevent one user from monopolising the queue.

## 7. Security

- Discord tokens live only on nodes (GitHub Secrets → `.env`), never in the Worker, frontend, or API responses.
- Worker uses a short-lived shared secret / signed header when calling node tunnels.
- Node tunnels keep existing Basic auth unless replaced by the signed header.
- `X-Content-Type-Options: nosniff` retained; `Content-Disposition` still uses the sanitized original name.
- Mock transport exists **only** for tests (`DISCORD_TRANSPORT=mock`) and is never selected in production.

## 8. Module map

Current app (this repo):
- `server.js` — routes; `/files/:name` becomes a 302 resolver; purge calls storage delete.
- `src/config.js` — `MAX_FILE_SIZE`, Discord/bot config, transport selection.
- `src/db.js` — schema + metadata helpers (SQLite shape preserved locally; Postgres adapter in phase 3).
- `src/api.js` — commitUpload/handleDeleteFiles become async and storage-backed.
- `src/storage/discord.js` — Discord REST client, queue, refresh, delete.
- `src/storage/mock.js` — test-only in-memory transport.
- `src/storage/index.js` — factory.
- `test/api.test.js` — runs with mock transport.

Planned infra (scaffolded in later phases):
- `workers/catbox-router/` — Cloudflare Worker proxy/router.
- `infra/supabase/schema.sql` — cloned metadata schema.
- `infra/actions/` — cloned docker-compose + self-chaining workflow.
- `node-worker/` — Gin/Go upload endpoint + background Discord uploader on each RDP.

## 9. Risks

- Discord ToS/Developer Policy: experimental/personal only; no public marketing.
- Signed URLs expire; refresh depends on bot permissions (`View Channel`, `Read Message History`).
- Node death mid-upload leaves staged bytes; journal + TTL sweep required.
- `D:` is staging, not durable storage; never delete staged bytes before metadata + Discord verification.
- Millions of simultaneous users remain infeasible under the no-card constraint; quotas and queues are the mitigation, not a solution.
