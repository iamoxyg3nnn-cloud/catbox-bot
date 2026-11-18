# catbox-node-worker (scaffold)

Runs on each Windows RDP node. Accepts streamed multipart uploads from the
Cloudflare Worker router, writes them to `D:\catbox_staging\<job_id>` with a
`<job_id>.json` metadata sidecar, uploads to Discord in the background, then
deletes both files.

> **Status:** scaffold. There is no Go toolchain in the current workspace, so
> this code has **not** been compiled. Run `go build ./...` on a node first.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `STAGING_DIR` | `D:\catbox_staging` | Transient staging directory |
| `NODE_UPLOAD_SECRET` | unset | Shared secret checked on `/upload` and `/internal/files` |
| `DISCORD_BOTS` | unset | JSON array of `{id,token,channelId}` |
| `MAX_FILE_SIZE` | `20mb` | Raw bytes or `<n>mb` |
| `CONTROL_PLANE_URL` | `http://127.0.0.1:3000` | Express API that records metadata |
| `UPLOAD_MAX_CONCURRENT` | `4` | Background uploader concurrency |
| `NODE_ID` | `node-local` | Reported by `/api/health` |
| `PORT` | `8080` | HTTP port behind the Cloudflare tunnel |
| `DISCORD_API_BASE` | Discord v10 | Override only for tests |

## Endpoints

- `POST /upload` — multipart (`fileToUpload`, optional `userhash`, `time`) → `202 {job_id,status_url}`
- `GET /api/jobs/:id` — `queued | uploading | ready | failed`
- `GET /api/health`, `GET /health` — includes `pending` / `active` for node selection

## Flow

1. Cloudflare Worker picks this node and POSTs the browser's multipart body here.
2. Body streams straight to `D:\catbox_staging\<job_id>` (never buffered whole).
3. A bounded worker pool picks a bot/channel and uploads via Discord REST with
   `files[1]`, parsing `X-RateLimit-*` and `retry_after` (no hardcoded buckets).
4. On success the worker POSTs metadata to `POST /internal/files` on the control
   plane with the same shared secret.
5. Only after Discord **and** the control plane succeed are the staged file and
   its sidecar deleted.
6. Failed jobs retry with backoff up to 3 attempts. A reaper removes failed and
   TTL-expired stages; at startup `recoverStale()` replays recent orphans using
   the sidecar (name/MIME/owner/expiry preserved). Orphans without a usable
   sidecar are discarded because they cannot be uploaded safely.

## Next steps before production

- Compile on a node and fix any Go version issues (no Go toolchain here).
- Heartbeats publish `pending`/`active` and staged disk usage to the control
  plane; confirm the Worker's node selection consumes them as expected.
