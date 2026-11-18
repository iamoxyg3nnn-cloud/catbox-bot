# File sharing service

This is a self-hosted file-sharing service with a browser interface, a plain-text HTTP API, personal file libraries, albums, and temporary uploads.

> **Experimental storage backend.** Uploaded bytes are sent to **Discord** as
> bot message attachments and delivered back to browsers via signed CDN
> redirects. Local disk is used only as transient staging for an in-flight
> request and is deleted as soon as Discord confirms the upload. Do not use
> this for confidential or irreplaceable files. See `architecture/` for the
> full design, phase plan, and progress tracker.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite` module)
- A Discord bot token and a channel ID for live storage (the test suite uses an in-memory mock instead)

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

Optional environment variables:

| Variable             | Default              | Purpose                                                   |
| -------------------- | -------------------- | --------------------------------------------------------- |
| `PORT`               | `3000`               | HTTP port                                                 |
| `DATA_DIR`           | `./data`             | SQLite DB and in-flight upload temp files (not byte store) |
| `PUBLIC_BASE_URL`    | request origin       | Override the base URL returned in API responses           |
| `TRUST_PROXY`        | unset                | Set to `1` behind a reverse proxy                        |
| `MAX_FILE_SIZE`      | `20mb`               | Per-file limit (bytes or `20mb` / `20MiB`)                 |
| `DISCORD_BOT_TOKEN`  | unset                | Single-bot token for a quick live setup                   |
| `DISCORD_CHANNEL_ID` | unset                | Channel that single bot uploads into                      |
| `DISCORD_BOT_ID`     | `primary`            | Label for the single bot                                  |
| `DISCORD_BOTS`       | unset                | JSON array of `{id,token,channelId}` for the bot fleet    |
| `DISCORD_TRANSPORT`  | `discord`            | Set to `mock` only for tests                              |
| `DISCORD_API_BASE`   | Discord v10 REST URL | Override for testing                                      |
| `SUPABASE_URL`       | unset                | Enables cloned Postgres metadata backend                  |
| `SUPABASE_SERVICE_ROLE_KEY` | unset         | Service key for the cloned Supabase project               |
| `UPSTASH_REDIS_REST_URL` | unset             | Enables Redis counters + CDN URL cache (card-free free tier) |
| `UPSTASH_REDIS_REST_TOKEN` | unset           | Upstash REST token                                        |
| `NODE_UPLOAD_SECRET` | unset                | Shared secret for `/internal/files` and node `/upload`    |
| `NODE_REGISTRY`      | unset                | Worker-side JSON list of alive node tunnels               |

To start over, stop the server and delete the `data/` directory; it is
recreated (empty) on the next start.

## Endpoints

- `POST /user/api.php` — permanent uploads, account file management, and albums
- `POST /litterbox/api.php` — temporary uploads
- `GET /files/<name>` and `GET /i/<name>` — `302` redirect to a fresh signed Discord CDN URL
- `GET /api/config` — public runtime limits and transport metadata (no secrets)
- `GET /api/jobs/<id>` — status of an async upload (`queued`/`uploading`/`ready`/`failed`)
- `POST /internal/files` — node-worker metadata hook (requires `X-Catbox-Secret`)
- `GET /api/metrics` — queue depth, journal backlog, node health, Discord 429 rate, staged disk usage, uptime (no secrets)
- `GET /ops` — small dashboard charting the 429 rate and staged disk usage
- `GET /api/nodes` — live node registry consumed by the Cloudflare Worker
- `POST /internal/nodes/heartbeat` — node load heartbeat (requires `X-Catbox-Secret`)
- `POST /internal/journal` — report a Discord write whose metadata commit failed
- `POST /internal/journal/reconcile` — trigger a reconciliation pass manually
- Browser pages are served at `/`, `/litterbox.php`, `/faq.php`, `/tools.php`, `/legal.php`, `/contact.php`, `/user/login.php`, `/user/register.php`, `/user/forgotpassword.php`, `/user/index.php`, `/user/albums.php`, and `/a/<short>`.
- Account form actions remain available as plain-text POST endpoints: `/user/dologin.php`, `/user/doregister.php`, `/user/reset_password.php`; `GET /user/logout.php` ends a session.
- The signed-in library uses `GET /api/dashboard` for the current account's files and albums, and `GET /api/albums/<short>` for public album contents.

The regular and temporary upload pages cycle their corner artwork every 10 seconds
using `public/assets/waifu/manifest.json`. Images are preloaded before switching,
with no consecutive repeats. Cycling pauses in hidden tabs; reduced-motion
preferences disable the fade. If the manifest cannot load, the default artwork stays visible.

Successful API uploads answer with the bare URL as plain text; failures answer with a 4xx status and a plain-text reason.

### Request types

| `reqtype`         | Fields                                      | Response                 |
| ----------------- | ------------------------------------------- | ------------------------ |
| `fileupload`      | `fileToUpload`, `userhash` *(optional)*     | file URL                 |
| `urlupload`       | `url`, `userhash` *(optional)*              | file URL                 |
| `deletefiles`     | `userhash`, `files` (space separated)       | `Removed N file(s).`     |
| `createalbum`     | `userhash` *(optional)*, `title`, `desc`, `files` | album URL |
| `editalbum`       | `userhash`, `short`, `title`, `desc`, `files` | album URL |
| `addtoalbum`      | `userhash`, `short`, `files`                | status text              |
| `removefromalbum` | `userhash`, `short`, `files`                | status text              |
| `deletealbum`     | `userhash`, `short`                         | `Album deleted.`         |

Anonymous albums can be created without a `userhash`, but they cannot be
edited or deleted afterwards.

### Status codes

- `400` — missing/invalid parameter, or no file supplied
- `401` — a valid `userhash` is required
- `403` — blocked file type, or the album belongs to someone else
- `404` — no such album or file
- `412` — unknown/missing `reqtype`, or the URL could not be downloaded
- `413` — file or album too large
- `429` — upload rate limit hit
- `500` — storage error

### Examples

```bash
# Upload a file (anonymous -> permanent)
curl -F "reqtype=fileupload" -F "fileToUpload=@cutie.png" http://localhost:3000/user/api.php

# Upload from a URL into an account
curl -F "reqtype=urlupload" -F "userhash=YOURHASH" -F "url=https://example.com/pic.jpg" \
     http://localhost:3000/user/api.php

# Create an album
curl -F "reqtype=createalbum" -F "userhash=YOURHASH" -F "title=Wallpapers" \
     -F "desc=Nice ones" -F "files=abc123.png def456.jpg" http://localhost:3000/user/api.php

# Delete files
curl -F "reqtype=deletefiles" -F "userhash=YOURHASH" -F "files=abc123.png" \
     http://localhost:3000/user/api.php
```

Litterbox expects a `fileToUpload` file and `time` (`1h`, `12h`, `24h` or `72h`); it also accepts `reqtype=urlupload` with `url` and `time`. Files are served until they expire, then the Discord message is deleted first and the metadata row follows.

## Layout

```
server.js               HTTP wiring, API routes and download redirects
bootstrap.js            NODE_PATH shim for this oddly-named checkout directory
src/config.js           Ports, directories, limits, Discord bot config
src/db.js               node:sqlite schema (Discord metadata columns) and queries
src/util.js             Names, extensions, MIME sniffing, hashing, password hashing
src/api.js              API request types (async, storage-backed)
src/auth.js             Sessions, registration and password reset
src/storage/index.js    Storage transport factory
src/storage/discord.js  Bot-aware Discord REST client, streaming multipart, rate limits
src/storage/mock.js     In-memory transport used only by tests
src/dbAdapter.js        SQLite vs Supabase metadata factory
src/adapters/supabase.js PostgREST metadata adapter (no new npm deps)
src/cache.js            Redis/Upstash counters + signed-URL cache
src/jobs.js             Background upload job runner, reaper + journal sweep
public/                 Browser UI (202 polling, fetches /api/config)
test/api.test.js        API, async job, journal and internal-hook tests (mock transport)
test/discord.test.js    Discord transport unit tests (stubbed fetch)
test/worker.test.js     Cloudflare Worker routing tests (stubbed fetch)
test/verify-discord.test.js  Safety checks for the live Discord verifier
test/supabase-adapter.test.js  PostgREST request-shape contract tests (stubbed fetch)
architecture/           Full design, phase checklist, progress/handoff tracker
data/                   Created at runtime: SQLite DB and in-flight temp files only
workers/catbox-router/  Cloudflare Worker upload router (KV quota, live node registry)
infra/supabase/         Metadata schema for the cloned Supabase stack (P2)
infra/actions/          Separate Postgres/PostgREST/Redis stack + Actions/Tunnel scaffold
infra/RUNBOOK.md        Deployment, monitoring and recovery procedures (P6)
node-worker/            Go node worker scaffold: D: staging + Discord uploader (P4)
scripts/migrate-metadata.js  One-shot SQLite → Supabase metadata migration
scripts/loadgen.js       Synthetic async-upload load generator (no Discord needed)
scripts/verify-discord.js  Live one-bot-or-20-bot Discord verification (needs real tokens)
```

## Notes and limits

- Anonymous uploads are permanent; Litterbox uploads carry an expiry timestamp
  and an hourly sweep deletes the Discord message before the metadata row.
- Uploads over `MAX_FILE_SIZE` (default **20 MiB**) are refused, and a coarse
  per-IP throttle (40 requests per minute) protects the API.
- `SUPABASE_URL` selects the cloned PostgREST metadata backend. All callers now
  `await` DB operations so both adapters work; SQLite is the offline-tested
  default. Validate against a real cloned Supabase instance before production
  (see `architecture/03-PROGRESS.md`).
- The browser reads `/api/config` so its client-side check follows the server
  limit; the server always remains authoritative.
- No production code path writes permanent bytes to local disk. `data/tmp`
  holds only in-flight request bodies, which are removed after the Discord
  upload completes.
- Executables are rejected: the extensions in `config.blockedExtensions`
  (`.exe`, `.scr`, and configured document types) plus the `application/exe` /
  `application/x-msdownload` MIME types.
- Password hashes use `scrypt` with a per-user salt; the `userhash` is the
  long-lived token the file-sharing API expects.

## License

MIT.
