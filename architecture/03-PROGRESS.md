# Progress Tracker (handoff document)

Last updated: 2026-11-18 — **end of third implementation session**
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

## Handoff notes / gotchas
- Checkout directory is literally named `node_modules`; `bootstrap.js` sets `NODE_PATH` and must stay first in `server.js`.
- No production code writes permanent bytes to local disk. `data/tmp` and `D:\catbox_staging` are transient.
- `DISCORD_BOTS` tokens, tunnel tokens, Supabase keys and `NODE_UPLOAD_SECRET` must never be committed.
- Plain API clients still get synchronous 200 + plain-text URL. Async mode is opt-in via `X-Catbox-Async: 1`.
- The Worker quota is durable via `QUOTA_KV`; the in-memory map is only a local fallback.
- The Go worker is a scaffold; treat it as untested until compiled on a node.
- Keep `02-PHASES.md` and this file in sync at every phase boundary.
