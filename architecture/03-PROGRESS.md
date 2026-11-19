# Progress Tracker (handoff document)

Last updated: 2026-11-19 — **hub-and-spoke fleet live**
Next agent: read `01-ARCHITECTURE.md` and `02-PHASES.md` first, then continue from "Remaining".

## Overall status

| Phase | Status | Notes |
|---|---|---|
| P0 Documentation | ✅ Done | 3 architecture files kept in sync. |
| P1 Core storage refactor | ✅ Done (code + tests + live) | `verify-discord.js` passed 1/1 with bot `primary` (token → upload → CDN → refresh → delete → 404). |
| P2 Cloned metadata backend | ✅ Live | `mew-pocket/Supabase-Actions` tunneled at `supabase.mew-pocket.de5.net`; schema applied; service-role adapter verified (sync + async uploads). |
| P3 Cloudflare Worker router | ✅ Code + tests done | Wrangler deploy + real KV namespace pending. |
| P4 Node fleet worker | 🟡 Scaffolded + hardened | Go code not compiled here; rollout pending. |
| P5 Frontend / UX / hardening | ✅ Mostly done | Synthetic load test pending. |
| P6 Deployment / operations | 🟡 Runbook + metrics + `/ops` dashboard done | Actual deployment still pending. |

## What has been done

### Session 1 — core Discord storage
- `src/storage/discord.js`: bot rotation, per-bot/per-channel rate buckets from `X-RateLimit-*`, `Retry-After`, streaming multipart, documented URL refresh, message delete.
- `src/api.js` / `server.js`: hash → Discord → metadata → staging unlink; 302 downloads; expiry deletes message first.
- `src/db.js`: Discord metadata columns + migration; no disk unlinking in DB layer.
- `src/config.js`: `MAX_FILE_SIZE` default 20 MiB, single-bot or 20-bot config.
- `src/storage/mock.js`, `test/discord.test.js`, `bootstrap.js`, README/`.env.example`.

### Session 2 — async UX, adapters, node worker
- `src/db.js`: `upload_jobs` table + helpers with exponential backoff.
- `src/jobs.js`: background runner, stale-job recovery, staging cleanup.
- `src/api.js`: `X-Catbox-Async: 1` → `202 {job_id,status_url}`; plain API clients keep 200 + text URL.
- `server.js`: `GET /api/jobs/:id`, `POST /internal/files`, `jobs.start()`.
- `public/app.js`: async polling for all three upload paths + storage notices.
- `src/adapters/supabase.js` + `src/dbAdapter.js`: full PostgREST adapter behind the DB interface. All handlers in `server.js`, `api.js`, `auth.js` and `jobs.js` now `await` DB calls, so both sync SQLite and async Supabase adapters are supported.
- `src/cache.js`: Upstash Redis REST with local fallback; signed URL cache.
- `node-worker/` Go scaffold (staging sidecars + crash recovery); `infra/RUNBOOK.md`.

### Session 3 — routing, registry, reconciliation, monitoring
- `src/db.js` + Supabase adapter: `nodes` table + `upsertNode/getNode/listNodes`; `upload_journal` + `addJournal/unresolvedJournal/resolveJournal/journalStats`.
- `recordFile()` is now idempotent (`INSERT OR IGNORE` / PostgREST upsert) so replay after a lost ack is safe.
- `server.js`: `GET /api/nodes`, `POST /internal/nodes/heartbeat`, `GET /api/metrics`, `POST /internal/journal`, `POST /internal/journal/reconcile`; `/internal/files` journals on transient metadata failure.
- `src/jobs.js`: 60s journal reconciliation sweep; `reconcileJournal({force})` for manual/test runs.
- `workers/catbox-router/index.js`: durable `QUOTA_KV` quota, live `/api/nodes` registry with static fallback, least-loaded node selection, streamed proxy, CORS headers.
- `wrangler.toml.example`: KV binding + control-plane URL.
- `test/worker.test.js`: 4 tests (health, routing, 413 ceiling, 503 no-nodes).
- `infra/actions/docker-compose.yml` + `workflow.yml.example`: separate Postgres/PostgREST/Redis + self-chaining Actions/Tunnel scaffold.
- `scripts/migrate-metadata.js`: one-shot metadata migration.
- `scripts/loadgen.js`: synthetic async-upload load generator (smoke-tested at 30/30 ready).
- `scripts/verify-discord.js`: one-command live verification of token, upload,
  CDN bytes, refresh, delete and 404 for one bot or all 20 (`--all`).
- `test/supabase-adapter.test.js`: 8 contract tests for auth headers, eq filters,
  idempotent upsert, `claim_upload_job()` RPC, boolean `draining`, parenthesised
  `in` filter, missing-job tolerance and error shape.
- Monitoring: Discord 429/retry counters, node `staged_bytes`/`staged_files` in
  heartbeats (SQLite + Postgres schemas), `discord.*`/`staging.*` in `/api/metrics`,
  and a dependency-free `/ops` chart page.
- `infra/supabase/schema.sql`: fixed `nodes.draining`, journal `metadata jsonb`.
- Go worker: per-channel semaphores, `Verify()` before delete, 15s heartbeat, journal-on-control-plane-outage.
- **Tests: 42/42 passing** (`npm test`, includes 4 Worker + 8 Supabase adapter contract tests).

### Session 4 — live bot + metadata backend (2026-11-18)
- Bot token found in local `.env`; channel ID resolved from the Discord backup webhook object (`channel_id=1555968938540666926`, guild `1555968929023664208`). No token is stored in any repository.
- Applied `infra/supabase/schema.sql` to the live cloned Supabase via the repo's `remote.sh`; all eight metadata tables plus `claim_upload_job()` are present and service-role accessible.
- Fixed schema drift: added `upload_jobs.owner_hash/original_name/mime/size/expires_at/file_name` (the adapter's `createJob`/`finishJob` need them). Async uploads now reach `ready`.
- Live checks passed: bot token, Discord upload, signed CDN bytes, around-message refresh, message delete + 404; sync upload returns plain-text URL with `200`; async `X-Catbox-Async: 1` returns `202` + `status_url` and completes to `ready`; download `302`s to signed Discord CDN.
- Fixed two Supabase linter WARNs by re-applying the repo's own `009-security-linter-fixes.sql` via `untrack` + `push`: `anon`/`authenticated` can no longer execute the `SECURITY DEFINER` auth hook; `supabase_auth_admin` still can. The `rls_enabled_no_policy` INFO on `_schema_migrations` is intentional per upstream README.
- All verification artifacts (Discord messages + metadata rows) were deleted afterwards.

### Session 5 — GitHub deployment of the bot (2026-11-18/19)
- Created private repo `mew-pocket/catbox-bot` from this checkout. `.gitignore` excludes `.env`, `data/`, `node_modules/`, `.opencode/`, logs — no tokens/keys are tracked.
- Added `.github/workflows/catbox-bot.yml` (`workflow_dispatch`, 6h timeout). It writes runtime env, waits for the separate Supabase workflow, applies `infra/supabase/schema.sql`, seeds `discord_bots`, starts `npm start` + cloudflared, and holds the LIVE window.
- All 7 runtime secrets set on the repo (never in code): `PUBLIC_BASE_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NODE_UPLOAD_SECRET`, `CF_TUNNEL_TOKEN`.
- **Tunnel separation**: both workflows initially shared one tunnel token; two cloudflared instances on one tunnel made Cloudflare load-balance requests, so Supabase's tunnel health checks got 502 and the run self-terminated. Fixed by creating a dedicated `catbox-api` tunnel (`070c0a03-133e-445d-910e-dee323d856a9`), repointing the `api.` CNAME to it with `cloudflared tunnel route dns --overwrite-dns`, removing `api.` from the `catbox-supabase` ingress, and giving catbox-bot its own token. `supabase-host.yml` was left unmodified.
- Workflow fixes pushed: pass secrets into the server **process** (the app reads `process.env`, not `.env`), and wait for Supabase readiness before applying schema (avoiding a startup race 502).
- **Live GitHub E2E passed 9/9, then 8/8 after the chaining rewrite** against `https://api.mew-pocket.de5.net`: config endpoint, Supabase backend, Discord storage, sync upload (plain-text URL), sync byte round-trip, async `202` + `status_url`, job reaching `ready`, async byte round-trip, artifact cleanup. All test Discord messages and metadata rows were deleted afterwards (tables verified empty).
- **Mercy-bot session discipline adopted**: `workflow_dispatch` only, `concurrency: catbox-session` (`cancel-in-progress: false`), early-insurance + end-of-run self-dispatch with `triggered_by=session-chain:<n>`, 5-link retry budget, readiness gate, 330-min keep-alive with live log streaming and process-death detection, `SESSION_COMPLETE` reset signal, failure artifact + `ALERT_WEBHOOK_URL` alert. Verified steady state: exactly one `in_progress` run plus one `pending` successor (same shape as `mercy-discord-bot`), one cloudflared connector. `supabase-host.yml` already uses the identical pattern in its own repo.

## Remaining (ordered)

1. ~~**Live Discord verification** with one bot~~ ✅ Done (2026-11-18): `verify-discord.js` passed 1/1. Channel ID `1555968938540666926` was resolved from the Discord backup webhook's `channel_id`; the webhook itself remains backup-only. Next scale-out: 20 bots/channels via `infra/RUNBOOK.md` §3.
2. **Compile the Go worker on a node** (`go build ./...`) and fix any issues; no Go toolchain here.
3. ~~**P2 infra**~~ ✅ Done: real upstream `Supabase-Actions` repo used unchanged (custom `catbox-actions` removed), tunnel hostnames configured, metadata schema applied via `remote.sh`, `discord_bots` seeded with `primary`. `infra/supabase/schema.sql` was extended with `upload_jobs.owner_hash/original_name/mime/size/expires_at/file_name` required by the Supabase adapter.
4. **P3 deploy**: create `QUOTA_KV`, `wrangler deploy`, set `API_BASE` in the frontend.
5. **P4 rollout**: roll Go worker to node-1..15/18; monitor `pending`/`active` and journal backlog.
6. **P5**: synthetic load test (1,000 jobs) before live bot traffic.
7. **P6**: monitoring dashboard (chart 429 rate + staged disk usage) + go-live.

## Key commands
- Project: `C:\Users\basud\OneDrive\Desktop\catbox clone\node_modules`
- Tests: `npm test` (mock transport, no network) — now also runs `test/worker.test.js`
- Config template: `.env.example`
- Metadata migration: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/migrate-metadata.js`
- Go worker: `cd node-worker && go build ./...` (on a node)

## Supabase adapter wiring (resolved locally, live test still needed)
`src/adapters/supabase.js` uses `fetch` and returns Promises. All DB call sites
(`server.js`, `api.js`, `auth.js`, `jobs.js`) are now `async` and `await` every
DB operation, with `asyncRoute()` + an error handler in `server.js` so rejected
promises return 500 instead of hanging. `await` is a no-op on SQLite's sync
values, so the SQLite path is unchanged (40/40 tests, 40/40 loadgen smoke).
Both adapters export the identical function surface. Request shapes and error
handling now have 8 offline contract tests; three latent bugs were fixed
(`in` filter syntax, boolean `draining`, missing job row during finish). **Still required before production:**
run the full flow against a real cloned Supabase instance — RLS policies and
the actual `claim_upload_job()` concurrency behaviour cannot be validated offline.

## Frontend on Vercel
- Deployed `public/` as a static site to Vercel project `mew-pocket` (account `mewpocketbackend-4060`).
- Production URL: `https://mew-pocket.vercel.app`.
- `public/vercel.json` rewrites backend routes (`/api/*`, `/user/api.php`, `/litterbox/api.php`, `/files/*`, `/i/*`, `/ops`, contact/auth endpoints) to `https://api.mew-pocket.de5.net`, so the browser stays same-origin and no CORS changes were needed on the control plane. Static assets are served directly; the catch-all rewrite maps SPA/browser pages to `/index.html`.
- Live checks through the Vercel domain all passed: `/`, `/api/config`, `/api/metrics`, `/styles.css`, `/assets/mewpocket.svg`, `/ops`, small upload + byte round-trip, 5 MiB upload + byte round-trip, and the full 20 MiB upload + byte round-trip. All test Discord messages and metadata rows were deleted (`files` and `upload_jobs` verified empty).
- Vercel is now Git-connected: account `mewpocketbackend-4060` has a GitHub Login Connection and the Vercel GitHub App is installed on `mew-pocket/catbox-bot`. Project `mew-pocket` is linked to `mew-pocket/catbox-bot` on branch `master` with **Root Directory = `public`** and Output Directory = `.`.
- Auto-deploy verified: an empty commit pushed to `master` produced a new READY production deployment (`dpl_9ZGbyKrvYJV5JB1aQfT7vZzHeL15` for `fc5e611`) and `https://mew-pocket.vercel.app` kept serving the app with working rewrites (`/api/config` 200, `/user/api.php` 412 = backend reached).
- `public/.gitignore` ignores Vercel's local `.vercel` metadata. Manual fallback remains `npx vercel@latest deploy public --prod --yes --token $VERCEL_TOKEN`.

## Hybrid CDN rotation (Vercel + Cloudflare)
- Both edges serve the identical app: `https://mew-pocket.vercel.app` (Vercel CDN) and `https://api.mew-pocket.de5.net` (Cloudflare edge + tunnel). The frontend keeps using same-origin rewrites on whichever edge serves the page, so sessions/cookies and CORS are unaffected.
- `public/cdn-rotation.js` steers each tab session at page load: probes `/ping.txt` (edge latency) and `/api/config` (API health) on both origins with a 2.5 s timeout, keeps an EWMA of latency, fails over immediately when the current edge is unhealthy, prefers an edge that is >250 ms faster, and deterministically sends 15% of new home-page sessions to the other edge so both CDNs carry real traffic.
- Sticky state lives in `sessionStorage`; a one-per-tab redirect guard makes loops impossible. `?cdn=vercel` / `?cdn=cloudflare` forces an edge for testing. `document.documentElement.dataset.cdn` and `#cdn-status` expose the decision; `ops.html` shows a live CDN card.
- Design rationale from research: do **not** proxy Vercel through Cloudflare (Vercel warns about lost client IP/geo, degraded bot rules, and two stale caches). Client-side steering at page load avoids that while still using both CDNs. Limitation: it cannot rescue the initial HTML if one hostname is fully down — both URLs are valid entry points.
- Health probes use `mode: 'no-cors'`, so no CORS changes or secrets are needed in the browser module. No tokens or credentials are ever placed in it.

## File links keep our own domain
- `/files/:name` and `/i/:name` previously answered `302` to the signed Discord CDN URL, so clicking a share link changed the address bar to `cdn.discordapp.com`. They now **stream the signed storage bytes through this origin** (`FILE_DELIVERY=proxy`, the default), so the address bar and copied link stay on `api.mew-pocket.de5.net/files/...` (or the Vercel origin via the existing rewrite).
- The proxy forwards safe headers (`Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`), supports Range/HEAD for media, sets `Cache-Control: public, max-age=300`, and never exposes the signed URL. Discord remains the only durable byte store; no bytes are written to disk. `FILE_DELIVERY=redirect` restores the old behaviour if ever needed.
- Upload responses and dashboard/album URLs already used `publicUrl(req, '/files/<name>')`, so they were correct — the Discord URL only appeared because the browser followed the redirect.

## Interrupted-upload recovery
- Research confirmed the main hang causes: no browser deadline or progress watchdog, one long multipart request that can outlive Cloudflare's 125 s proxy read timeout, partial temp files left by aborted multer requests, jobs stranded in `uploading` by a dead runner, and Discord retries creating duplicate messages.
- Browser uploads now use `POST /api/uploads` → signed capability token → `PUT` 4 MiB chunks → `POST /api/uploads/:id/complete`. Each request has a 15–60 s deadline, a mismatched offset returns `409 { received }` so the client resumes, and a repeated `complete` returns the same job id. The token is HMAC-signed with `NODE_UPLOAD_SECRET` (or an ephemeral in-memory key when it is unset, never an empty key) and expires after 30 min. The job id is derived from the upload id, so even a completion-marker write failure cannot enqueue a duplicate job. No new DB table or permanent local storage is introduced; plain API clients keep the original `/user/api.php` contract.
- Client polling (`pollJob`) now bounds each status probe at 15 s, retries transient failures with backoff, handles 404 as a lost upload, and gives an actionable timeout message. A Cancel button aborts the active upload.
- Server hardening: multer aborts/errors delete partial temp files; queued jobs release their staged body before the 202 response; `requestTimeout` is bounded; abandoned jobs are requeued every 30 s; orphaned tmp files older than 30 min are swept while queued/uploading bodies are protected; a missing staged body fails terminally instead of burning retries; a successful commit no longer fails the job on a transient metadata read.
- Queued jobs pass a stable Discord `nonce` (`enforce_nonce: true`) derived from the job id, so an at-least-once retry returns the existing message instead of duplicating an attachment.
- All recovery knobs are env-configurable (`STALE_JOB_AFTER_MS`, `JOB_RECOVERY_SWEEP_MS`, `TEMP_MAX_AGE_MS`, `TEMP_SWEEP_MS`, `UPLOAD_BODY_TIMEOUT_MS`). Tests: 44/44, including resumable offsets, idempotent completion, and the Discord nonce.

## UI button fixes
- **Home button on the account dashboard:** on wide screens the header is absolutely positioned while the main panel is relative; both sat at `z-index:1`, so the later-painted main panel covered the Home link and swallowed clicks. Raised `.classic-dashboard > .legacy-page-header` to `z-index:5`.
- **Upload nav link:** clicking "Upload" while already on My files only changes the URL hash, so the one-time init check never re-ran and the upload panel stayed closed. Added a `hashchange` listener that opens the panel.
- Audited every button/link across all pages (Home, nav, sign out, upload panel open/close/cancel/copy, album create/cancel, theme toggle, auth/contact forms): all have live handlers. `npm test` 45/45.

## Album ownership and empty state
- Album/file mutations now use the authenticated session's userhash first and fall back to the body field only for plain reference-style API clients. A valid session can no longer create an album under a stale or bogus `userhash`, which previously made it invisible on the Albums page.
- Chunk-upload sessions reject non-string `userhash` values instead of stringifying them into `[object Object]`, which would silently orphan a file from its owner.
- The Albums empty state is now actionable: with library files it offers **Create your first album**; without files it links to the signed-in upload panel. Creating an album keeps the browser on the Vercel frontend instead of jumping to the API origin.
- Tests: 45/45, including session-owned album creation and non-string userhash rejection.

## Supabase public URL / 401 clarification
- `https://supabase.mew-pocket.de5.net/` serves **Supabase Studio**, not the REST API. Kong applies `basic-auth` to the Studio catch-all route, so an anonymous `GET /` correctly returns **401** with `WWW-Authenticate: Basic realm="service"`. This is a login gate, not an outage.
- Login works with username `supabase` and the `DASHBOARD_PASSWORD` secret: `/` → `307` → `/project/default` → `200`. Browsers cache the Basic credential for the origin.
- `/rest/v1/` and `/auth/v1/` anonymously return 401 "No API key found in request" — also correct. With `apikey: $SUPABASE_ANON_KEY`, `GET /auth/v1/health` returns **200**; use that for uptime/monitoring checks instead of `/`.
- `Supabase-Actions` stays verbatim; no Kong config or workflow changes were made, so no service restart was needed.

## Restart data-loss mitigation
- Root cause investigation: Supabase runs on an ephemeral `actions/cache`-backed runner. `supabase-host.yml` drops every non-system schema with `CASCADE` on each restore and replays `supabase-state.tar.gz`. A stale/empty archive passes the upstream guards (a ~220 KB dump is mostly Supabase system schemas), and the bot then re-applies the idempotent `schema.sql` — so an empty restored DB looks healthy with zero rows. That is the "all database got flushed on restart" symptom. No application code issues `DROP`/`TRUNCATE`; all deletes are key-scoped.
- Added `src/metadataMirror.js`: every 60 s it snapshots the account/file/album/album-file/message tables from Supabase, encrypts them with AES-256-GCM using `NODE_UPLOAD_SECRET`, and publishes the JSON as an attachment in the durable Discord channel. It keeps the newest 10 snapshots and prunes older ones.
- On startup it loads the newest *non-empty* snapshot and restores only when `users` is empty and the target table is also empty. It never overwrites live rows, and it refuses to publish an empty account snapshot over a good mirror. A restore sends an alert through `ALERT_WEBHOOK_URL` so a silent upstream flush is visible.
- `server.js` now starts the mirror before the job runner and publishes a final snapshot on SIGTERM/SIGINT. The bot workflow passes `ALERT_WEBHOOK_URL` and fails fast if any Supabase/Discord/secret value is blank, preventing the silent SQLite fallback that would also lose metadata on a fresh runner.
- `Supabase-Actions` remains verbatim; no upstream workflow or schema was touched. Tests: 51/51, including mirror encryption, empty-snapshot skipping, guarded restore and pruning.
- Login persistence: the `catsess` cookie only works while its row survives in `sessions`, which points at `users.id`. The mirror now snapshots `sessions` too and relinks each `user_id` by userhash after accounts are restored with regenerated identity ids. Accounts no longer need to be recreated, and existing session cookies keep working after a flush.
- If Supabase empties while the bot is already running, `tick()` now calls `restoreOnce()` immediately instead of waiting for the next bot session to boot (was up to a 330-minute gap). Restores are serialised so a concurrent startup/tick/shutdown cannot double-write.
- Outage hardening: the bot's Supabase readiness probe used to accept any code except 502/503/000, so Cloudflare's 530 ("Tunnel error") was mistaken for a healthy backend. The schema POST then failed with 530 and the session chain burned its five-retry budget in seconds. The probe now accepts only real 2xx-4xx answers.
- The upstream Supabase workflow currently ends its session with "Next run: managed by Cloudflare Worker (node-watchman)", but no such watcher exists in this workspace. When that session ends, both tunnels return 530 and the bot cannot start. Until an external watcher exists, Supabase must be restarted manually via its `workflow_dispatch` before the bot.
- Login bounce fix: the hybrid CDN steering probed both edges on every page load and applied latency/failover redirects to account pages too. Cookies are scoped to one origin, so a signed-in user on the Cloudflare edge could be `location.replace()`d to the Vercel edge mid-login; `/api/dashboard` then answered 401 and `app.js` sent them back to the sign-in form. Auto-steering is now limited to anonymous visits to `/`, and the home nav shows "My files / Albums" once the `userhash` cookie is present.

## Admin console
- Added a dedicated operator surface at `GET /admin`, served from the API origin. Vercel redirects its own `/admin` and `/admin.html` to that origin so the admin cookie stays same-origin; the regular CDN steering script is deliberately not loaded on the console.
- Auth is a single high-entropy `ADMIN_TOKEN` env/GitHub secret exchanged for a 12-hour HMAC-signed `catadmin` HttpOnly + SameSite=Strict + Secure cookie. Online guessing is throttled per IP; the token itself is never persisted in the browser.
- `src/adminApi.js` implements a whitelisted table API over all ten metadata tables. Both adapters gained `adminQuery/adminCount/adminDelete/adminUpdate` with fixed table, search-column, key and field allow-lists; password hashes are stripped from user rows.
- Moderation actions: file delete (Discord message first, then metadata row, with failed purges left in place for the hourly sweep), account delete (all owned files, albums, sessions, then user), album/message/journal deletion, safe field edits, job requeue/fail, journal reconciliation, node drain toggles and Discord bot enable/health toggles.
- Operations actions: live overview counters, Supabase/edge/bot health probes, runtime config viewer and an in-memory `uploadsPaused` maintenance switch that blocks only upload writes.
- Admin UI is a dependency-free dense dashboard in `public/admin.html` with keyboard-accessible search, pagination, native confirm/edit dialogs, focus return and `aria-live` status toasts.
- Admin accounts: `users.role` (`user` | `admin`) is in both schemas with an idempotent upgrade for existing databases. A normal signed-in session with `role = admin` is accepted by `/api/admin/*`; the optional `ADMIN_TOKEN` cookie flow remains as a fallback. The console UI detects which method is active and links to the normal login page for account admins.
- The Vercel frontend serves `/admin` through a rewrite (not a redirect) so the host-only `catsess` cookie from a frontend login reaches the console; `/api/dashboard` now exposes `user.role` and the account nav shows an Admin link to signed-in admins.
- Fixed a resumable-upload race: a fast retry of `/api/uploads/:id/complete` could get a 409 (staged bytes already consumed by the worker) instead of the queued job. The cached `.done` job is now returned before the byte-count check.
- Tests: 61/61 passing, including admin auth gating, account-role access, hidden password hashes, byte-purging file deletion, the maintenance switch, and PostgREST search/filter shapes. Supabase adapter read checks passed on all live tables, including wrapped `or(...)` search and exact `and=(...)` filters. `ADMIN_TOKEN` was generated locally and set as a GitHub Actions secret; it is not committed.
- Deep security hardening (OWASP Session Management / Authentication / CSRF Prevention / HTTP Headers cheat sheets, fetched directly because web search was unavailable):
  - `src/adminSecurity.js` adds strict CSP (inline script/style allowed only by computed hash), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `no-store`, HSTS, Permissions-Policy, origin/Referer/Sec-Fetch-Site guard, optional IP/CIDR allow-list and a 250-event structured audit ring buffer with an in-console Audit tab.
  - `src/adminAuth.js` moves to a `__Host-catadmin` cookie (Secure, HttpOnly, SameSite=Strict, Path=/) with 30-minute idle / 12-hour absolute lifetime, account-session binding, token verification in constant time, a session-bound signed CSRF token, optional TOTP step-up and shared brute-force throttling.
  - `src/bruteForce.js` adds per-account + per-IP lockout with exponential backoff after the fourth failure; used by both admin token login and `/user/dologin.php`.
  - `src/auth.js` rotates the account session on sign-in to prevent session fixation; `src/adminApi.js` rechecks `users.role` against the database on every request and blocks demotion/deletion of the last administrator.
  - All admin writes now require `X-CSRF-Token`; the console fetches it from `/api/admin/status`. Added tests for CSRF rejection, bad-origin rejection and CSP hash correctness. 62/62 tests passing.

## Deployment: Windows runner + Tailscale (this session)
- Audited the reference backend (`C:\Users\basud\OneDrive\Desktop\chuglii\backend`, read-only). It does **not** gain durable storage from RDP/Tailscale: `.github/workflows/secure-rdp.yml:57-58` runs an ephemeral `windows-latest` VM for at most 355 minutes; Tailscale only exposes it for `mstsc` (`scripts/parallel-setup.ps1:242-397`). The "~150 GiB" is just that runner's D: drive (`fleet-sweep.log:2-16`); it disappears when the job ends. Local `D:\videos` is a staging buffer deleted after successful remote upload (`channel/channel_upload.go:264-275`). `.freebuff` is a 37-byte UUID and `.audit` is <22 KB of JSON backups - neither supplies capacity.
- Rewrote `.github/workflows/catbox-bot.yml` for `runs-on: windows-latest` while preserving the self-dispatch chain (`catbox-session`, 5-retry budget, early insurance + session-end steps, `SESSION_COMPLETE`, Discord alert). All steps now use `pwsh`; cloudflared is the Windows binary; the keep-alive still holds 330 minutes under the 360-minute job cap.
- Added a Tailscale/RDP step gated on the `TAILSCALE_AUTH_KEY` secret (installs Tailscale, enables TermService/firewall, creates a one-session local admin, prints `mstsc` details, and falls back to userspace networking). RDP failure is non-fatal; a missing secret only emits a warning so the bot stays up. **The secret must be added in GitHub for RDP to be available.**
- Added `STAGING_DIR` in `src/config.js`; production sets `STAGING_DIR=D:\catbox_staging`, so in-flight bodies live on the runner's D: drive instead of `./data/tmp`. `commitUpload()` still unlinks the staged file only after Discord confirms and Supabase records the metadata; a failed Discord upload keeps the local body for the job retry.
- Validated the rewritten workflow with a YAML parser (15 steps, `windows-latest`) and parsed all 11 inline PowerShell blocks with the PowerShell parser - no syntax errors.

## Discord bot fleet (5 bots)
- Stored four additional valid bot tokens as GitHub secrets `DISCORD_BOT_2_TOKEN` … `DISCORD_BOT_5_TOKEN` (verified via Discord `/users/@me`: `mewpocket - 2` … `mewpocket - 5`); no token is committed or printed.
- The workflow now builds `DISCORD_BOTS` (primary first, then bot2..bot5) from those secrets plus the existing `DISCORD_CHANNEL_ID`, exports it through `GITHUB_ENV`, requires all five secrets to be present, and seeds all five rows into Supabase `discord_bots`. `parseBots()` already supports this JSON array and the storage layer round-robins while retiring bots that return 401/403.
- Discord-side check: `mewpocket - 3/4/5` are **not** members of the configured guild `New Server` (`1555968929023664208`); only `primary` and `mewpocket - 2` are members. The user must invite bots 3/4/5 and grant the required channel permissions in Discord - bot tokens cannot self-grant Administrator.
- Failover hardening in `src/storage/discord.js`: `upload()` now tries a sibling bot within the same request when one returns 401/403 (the staged file is re-streamed per attempt; nonce/idempotency is unchanged). A retired bot is put back on probation after an exponential backoff (60s → 120s → … → 60m) and permanently recovers on its first success, so inviting a missing bot needs no redeploy. Two new unit tests cover sibling failover and backoff recovery; 64/64 tests pass.
- Fix (commit `02aa23c`): the registry seed initially failed with Postgres `23505` because `discord_bots.channel_id` was `unique`, so five bots sharing one upload channel could not all be registered. Dropped that constraint in `infra/supabase/schema.sql` and applied the same `ALTER TABLE ... DROP CONSTRAINT IF EXISTS discord_bots_channel_id_key` to the live Supabase database. Verified `pg_constraint` now contains only `discord_bots_pkey`, the seed step passes, all five rows exist, and the control plane is healthy again.

## One repository per bot (hub and spokes)
- Decided on a hub-and-spoke topology after research: five full Express stacks would race on (1) the global `claim_upload_job()` (a repo can claim a job whose staged bytes live on another runner), (2) the single-writer Discord metadata mirror, and (3) the one tunnel/domain configuration. See `PLAN.md`.
- `catbox-bot` stays the hub (API, admin, downloads, jobs, mirror, `/api/nodes`). New repos `catbox-bot-1` … `catbox-bot-5` are spokes: `NODE_MODE=node`, one bot token each, per-session quick tunnel, 15s heartbeat. Spokes do not run admin, jobs, mirror or expiry purge.
- Added `src/nodeRouting.js`: `pickNode()` (least-loaded, ignores stale/down/draining), `forwardUpload()` (streams the hub's staged multipart file to a spoke), and `startHeartbeat()` (spoke registers/retires its URL). Hub forwards in `server.js` and falls back locally on any error; forwarded staged bytes are deleted after success.
- Hardened spokes with `X-Catbox-Secret` check on the upload routes so a discovered tunnel URL cannot be used directly. Fixed the Tailscale step's PowerShell backslash-continuation bug (line 121) so RDP setup can actually run.
- Added 4 unit tests (`test/nodeRouting.test.js`); full suite is 68/68 green.

## Spoke rollout and final verification (2026-11-19)
- Populated all five spoke repos from the hub source; each has exactly one workflow (`catbox-spoke.yml`) and no `.env`/secrets in git. Each repo holds only its own bot token, seeded without printing values.
- Fixed three rollout-blocking bugs in `deploy/catbox-spoke.yml.template`:
  1. The keep-alive step did not export `DISCORD_BOT_TOKEN`; combined with PowerShell unrolling a one-element `DISCORD_BOTS` array into an object, `parseBots()` returned an empty fleet and every spoke upload returned `500`.
  2. The readiness gate filtered the `/api/nodes` wrapper object instead of `nodes`, so every session self-terminated after 180s. It now reads `$nodes.nodes`.
  3. Spoke Discord identities are `primary`, `bot2`…`bot5` (matching the hub's resolver) while node ids remain `bot-1`…`bot-5`. Files uploaded by a spoke are therefore downloadable through the hub.
- Added round-robin tie-breaking in `pickNode()` because all spokes report zero in-flight work; without it the hub pinned every upload to `bot-1`. Full suite is 69/69 green.
- Hub pushed through `8461d52`; spoke template fix through `973f0ed`; temporary `bootstrap-secrets.yml` and the powerful `BOOTSTRAP_TOKEN` secret were removed after seeding.
- All five spokes registered `up` in `/api/nodes` and stayed healthy past the old 180s failure point. Six consecutive hub uploads resolved to `bot2`, `bot3`, `bot4`, `bot5`, `primary`, `bot2` — all five bots carry live traffic; staged bytes returned to `0/0`.
- Live checks passed: API and Vercel origins return `200` for `/admin`, `/api/nodes`, `/api/metrics` and browser pages; Vercel `/admin` and `/api/:path*` are rewrites (no redirects); sync upload returns a plain-text URL; async `X-Catbox-Async: 1` returns `202` + job id and reaches `ready`; downloaded bytes match; contact messages persist in `messages`; admin `ADMIN_TOKEN` exchange issues a session with CSRF, overview/audit load, and a write without `X-CSRF-Token` is rejected `403`; a temporary normal account registered and logged in without gaining admin, then was removed.
- **Note:** the "user asked about 6 bots" was the hub plus five spokes (six running app instances), not six Discord accounts. There are still exactly five Discord bots; `catbox-bot` is the hub and must not be deleted.

## Windows RDP + D: design copied to every spoke (2026-11-19)
- Reference repo `chuglii/backend` was investigated read-only. Its "150+ GB" is per-runner free D: scratch (134–216 GiB across 18 ephemeral `windows-latest` runners in `fleet-sweep.log`), **not** a pooled volume and **not** durable; RDP-over-Tailscale is operator access, and bytes actually persist on external hosts + a Supabase journal. There is no literal "150 GB" string in that repo.
- The user's requirement — copy the design so all bots run as GitHub Actions Windows RDP sessions using local D: as staging for the life of the run — is now implemented on the hub **and** all five spokes.
- `deploy/catbox-spoke.yml.template` now mirrors the hub: job-level `TAILSCALE_AUTH_KEY`, the `Enable Tailscale RDP access` step (MSI install, RDP user + firewall, `tailscale up`, userspace fallback, RDP credentials printed per session), disk-free logging, and a no-key warning step. `__NODE_ID__` is included in the Tailscale hostname so each spoke is distinguishable on the tailnet.
- `TAILSCALE_AUTH_KEY` was seeded into all five spokes with a temporary bootstrap workflow, then the workflow and the high-scope `BOOTSTRAP_TOKEN` secret were removed. No secret values were printed or committed.
- Verified live: all five spoke workflows run with `staging=success` and `rdp=success`; spoke-1's log showed `D: free=147GB` and a Tailscale RDP IP; six consecutive hub uploads landed on all five bots (`bot3, bot4, bot5, primary, bot2, bot3`), all `ready`.
- D: bytes remain transient: staged files are deleted only after Discord confirms the attachment and Supabase records the metadata. RDP/Tailscale do not change that lifecycle.

## Concurrent load testing and hardening (2026-11-19)
- Added reproducible `scripts/loadtest-concurrent.js` (N accounts, N × 20 MiB simultaneous uploads, node monitoring, Supabase metadata verification) and `scripts/loadtest-cleanup.js` (deletes test files via the public `deletefiles` API so Discord messages and metadata rows both go away).
- Baseline 20/20 × 20 MiB succeeded but p50 was ~40s. Diagnosis: `Bucket` fully serialised every Discord request even with zero 429s; four uploads to one spoke took ~4× a single upload. Fixed with bounded concurrency (`DISCORD_REQUEST_CONCURRENCY`) plus adaptive tuning — a bucket halves concurrency on a 429 and grows one step at a time while `X-RateLimit-Remaining` shows headroom (`src/storage/discord.js`, `src/config.js`).
- Spoke heartbeats now publish real in-flight upload counts; `startHeartbeat(stats)` accepts a stats callback and `server.js` tracks active uploads. `pickNode()` already breaks zero-load ties round-robin, so all five spokes carry traffic evenly.
- Per-IP upload throttle was hardcoded at 40/min, which made any single-source scale test impossible. It is now `UPLOAD_MAX_PER_MIN` (production default unchanged at 40) wired as a repo variable so a controlled test can raise it without a code change.
- Every upload previously did its own live `listNodes()` Supabase read; 80 concurrent uploads meant 80 concurrent reads and starved `/api/nodes` and `/api/metrics`. Added a 3s node-registry snapshot (`getNodeRegistry()`) with stale-on-error fallback; heartbeats invalidate it. Control-plane endpoints now stay responsive during bursts.
- **Results (20 MiB each):** 5/5, 20/20, 40/40 and 80/80 all reached `ready` with zero 429s, zero staging leaks and even bot distribution. `npm test` 73/73 green.
- First 150-user run: 78 succeeded, 72 failed at the connection layer (`fetch failed`) with one Cloudflare `524`; all 78 uploaded files were `ready`. Root cause was tunnel/concurrency saturation, not Discord rate limiting. Mitigations deployed: three cloudflared connectors on the dedicated API tunnel (instead of one) and per-bot private Discord channels for bots 2–5 (primary keeps the original channel so the metadata mirror is unaffected). All five bots verified uploading to their channels; a 150-user re-test is in progress.
- **150-user diagnosis:** two identical 150-user × 20 MiB runs both produced exactly 78 successes / 72 client-side `fetch failed` (plus one Cloudflare `524`), with zero Discord 429s and near-idle spokes. The mitigations above did not move that ceiling, so they were not the cause. A control run of **150 concurrent users × 1 MiB succeeded 150/150** in 55.7 s with all five bots used. Conclusion: the 20 MiB ceiling is the single load generator's upstream bandwidth (150 × 20 MiB = 3 GB from one Windows machine), not a hub/spoke/Discord limit. Real 150-user traffic arrives over 150 separate uplinks.
- Cleanup harness deletes both the Discord messages (via public `deletefiles`) and the throwaway user rows (via service-role Supabase). All 496 test files and 640 test users from nine runs were removed; no load-test residue remains.
- **Multi-file batch queue:** the UI only accepted one file at a time and the legacy load harness fired every upload simultaneously, which hit a ~78-connection ceiling and the restored 40/min per-IP throttle. Added `public/upload-queue.js`, a bounded-concurrency queue (5 files in flight, 2 retries with backoff, cancel support, aggregate progress) that feeds each file through the existing resumable 4 MiB chunk uploader (`/api/uploads`) and its durable `upload_jobs` runner. Wired into both home and My-files dropzones with `multiple` file inputs and per-file progress lists. Verified live with **100 × 1 MiB files → 100/100 ready in 72.7s, zero failures**, sampled downloads `206`, all five bots used evenly (20 each). `scripts/loadtest-batch.js` reproduces the test. This is the supported way to upload a large batch; plain single-file API clients keep their synchronous 200 + URL contract.
- Free proxy harvesting was evaluated and rejected: it would route bot tokens through untrusted servers, invite Discord bans, add latency to an already bandwidth-bound path, and solve a problem (429s) that has not appeared in any test.

## Handoff notes / gotchas
- Checkout directory is literally named `node_modules`; `bootstrap.js` sets `NODE_PATH` and must stay first in `server.js`.
- No production code writes permanent bytes to local disk. `STAGING_DIR` (`D:\catbox_staging` in production) and `data/tmp` locally are transient.
- `DISCORD_BOTS` tokens, tunnel tokens, Supabase keys and `NODE_UPLOAD_SECRET` must never be committed.
- Plain API clients still get synchronous 200 + plain-text URL. Async mode is opt-in via `X-Catbox-Async: 1`.
- The Worker quota is durable via `QUOTA_KV`; the in-memory map is only a local fallback.
- The Go worker is a scaffold; treat it as untested until compiled on a node.
- Keep `02-PHASES.md` and this file in sync at every phase boundary.
