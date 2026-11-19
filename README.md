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
| `DATA_DIR`           | `./data`             | SQLite DB (not byte store)                                |
| `STAGING_DIR`        | `<DATA_DIR>/tmp`     | Local disk for in-flight upload bodies (production: `D:\catbox_staging`) |
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
| `ADMIN_TOKEN`        | unset                | Enables token exchange for the `/admin` operator console  |
| `ADMIN_ALLOWED_ORIGINS` | Vercel + API origins | Comma-separated HTTPS origins allowed to mutate admin state |
| `ADMIN_ALLOWED_IPS`  | unset                | Optional comma-separated IPs/CIDRs allowed to reach `/admin` |
| `ADMIN_OTP_SECRET`   | unset                | Optional Base32 TOTP secret for operator step-up MFA       |
| `ADMIN_MFA_REQUIRED` | `0`                  | Set to `1` to require TOTP for all admin writes            |
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
- `GET /admin` — operator console (requires an admin account or `ADMIN_TOKEN`; Vercel rewrites here from its own `/admin`)
- Browser pages are served at `/`, `/litterbox.php`, `/faq.php`, `/tools.php`, `/legal.php`, `/contact.php`, `/user/login.php`, `/user/register.php`, `/user/forgotpassword.php`, `/user/index.php`, `/user/albums.php`, and `/a/<short>`.
- Account form actions remain available as plain-text POST endpoints: `/user/dologin.php`, `/user/doregister.php`, `/user/reset_password.php`; `GET /user/logout.php` ends a session.
- The signed-in library uses `GET /api/dashboard` for the current account's files and albums, and `GET /api/albums/<short>` for public album contents.

## Admin console

Open `/admin` on the API origin. The console accepts either a normal signed-in
account whose `users.role` is `admin`, or an `ADMIN_TOKEN` exchange that issues
a signed `__Host-` cookie (Secure, HttpOnly, SameSite=Strict, Path=/) with a
30-minute idle timeout and a 12-hour absolute lifetime. The cookie is bound to
the underlying account session, so signing out invalidates admin access too.
Admin accounts sign in at `/user/login.php` and return to `/admin`; no second
token is needed. The token is never written to disk or localStorage. From
there an operator can:

- review live counts, runtime config, Discord 429 rate and journal backlog;
- browse and search every metadata table (users, sessions, files, albums,
  messages, upload jobs, nodes, Discord bots, orphan journal);
- delete files, albums, contact messages and journal entries, with file
  deletion removing the Discord message **before** the metadata row;
- delete an account and purge every file it owns;
- edit safe fields (user role, file status, album text, job state, bot
  health/enabled, node draining, journal resolution);
- requeue or fail stuck upload jobs, reconcile the orphan journal;
- pause/resume all uploads for maintenance and run Supabase/edge/bot health checks;
- review the in-console audit log of recent operator actions.

Security layers (based on the OWASP Session Management, Authentication, CSRF
Prevention and HTTP Headers cheat sheets):

- every admin mutation requires a session-bound, signed double-submit CSRF token
  in `X-CSRF-Token`, plus a `Sec-Fetch-Site` / `Origin` / `Referer` check;
- a strict Content-Security-Policy (no external scripts, frames or plugins),
  `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `no-store` and HSTS are set
  on the console and every admin API response;
- login is throttled per account and per IP with exponential backoff, and the
  account session is rotated on sign-in to prevent session fixation;
- admin role is rechecked against the database on every request, and the last
  administrator cannot be demoted or deleted;
- optional TOTP step-up via `ADMIN_OTP_SECRET` (set `ADMIN_MFA_REQUIRED=1` to
  enforce it), and an optional IP/CIDR allow-list via `ADMIN_ALLOWED_IPS`
  (set `TRUST_PROXY=1` behind Vercel/Cloudflare).

The Vercel frontend rewrites `/admin` to the API origin so the admin cookie is
same-origin. Session tokens are excluded from the public metrics endpoint, and
password hashes are stripped from all admin responses.

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

## Deployment

The production workflow (`.github/workflows/catbox-bot.yml`) runs on a
`windows-latest` GitHub-hosted runner. It is dispatched only by other runs via
a `catbox-session` concurrency chain; there is no cron schedule. Each session:

- stages upload bodies on the runner's local `D:\catbox_staging` (~150 GiB of
  ephemeral disk). A body stays there while Discord receives it and is deleted
  only after Discord confirms the attachment and Supabase records the metadata;
  a failed Discord upload is retried from the same local file;
- exposes the session over **Tailscale** for operator RDP when the
  `TAILSCALE_AUTH_KEY` secret is set (Tailscale gives network access only, not
  storage); RDP failure never stops the control plane;
- starts `node server.js` and a named Cloudflare tunnel, waits for both the
  local and public `/api/config` to answer, then holds the session for 330
  minutes before queueing a healthy successor;
- builds `DISCORD_BOTS` from `DISCORD_BOT_TOKEN` and `DISCORD_BOT_2_TOKEN` …
  `DISCORD_BOT_5_TOKEN`, all posting to `DISCORD_CHANNEL_ID`. The storage layer
  rotates through the fleet, fails over within a single upload when a bot
  returns 401/403, and retires that bot with exponential backoff until it is
  fixed in Discord (then it rejoins automatically). The same fleet is seeded
  into the `discord_bots` table for the admin console.
  Every bot must be invited to the Discord server and allowed to post, read and
  delete in that channel; bot tokens cannot grant themselves those permissions.

### One repository per bot (hub and spokes)

Each bot now lives in its own repository so it has an independent runner, tunnel
and token:

- `mew-pocket/catbox-bot` is the **hub**: public API, admin console, download
  proxy, job runner, metadata mirror and the `/api/nodes` registry. It keeps all
  five bot tokens so it can resolve and delete any file.
- `mew-pocket/catbox-bot-1` … `catbox-bot-5` are **spokes**. Each runs with
  `NODE_MODE=node`, exactly one Discord token, its own transient
  `D:\catbox_staging`, and a per-session Cloudflare quick tunnel. A spoke skips
  the admin console, job runner and metadata mirror because those assume a
  single writer. It heartbeats its public URL to the hub every 15 seconds.

The hub streams each synchronous upload to the least-loaded healthy spoke and
returns the spoke's plain-text URL unchanged. If no spoke is healthy, it falls
back to its own bots, so a dead spoke never causes downtime. Stale spokes (no
heartbeat for 60s) are reaped automatically. See `PLAN.md` for the full design.

Supabase + Redis remain in the separate, unmodified `mew-pocket/Supabase-Actions`
repository with their own tunnel. This repository owns only the control plane.

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
- No production code path writes permanent bytes to local disk. `<DATA_DIR>/tmp`
  (or `STAGING_DIR`, i.e. `D:\catbox_staging` in production) holds only in-flight
  request bodies, which are removed after the Discord upload completes. The
  runner's D: drive is transient: when a session ends, any still-staged body is
  gone and its job fails terminally instead of being silently retried forever.
- Executables are rejected: the extensions in `config.blockedExtensions`
  (`.exe`, `.scr`, and configured document types) plus the `application/exe` /
  `application/x-msdownload` MIME types.
- Password hashes use `scrypt` with a per-user salt; the `userhash` is the
  long-lived token the file-sharing API expects.

## License

MIT.
