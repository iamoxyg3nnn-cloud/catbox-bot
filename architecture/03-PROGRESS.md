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
- **Live GitHub E2E passed 9/9** against `https://api.mew-pocket.de5.net`: config endpoint, Supabase backend, Discord storage, sync upload (plain-text URL), sync byte round-trip, async `202` + `status_url`, job reaching `ready`, async byte round-trip, artifact cleanup. All test Discord messages and metadata rows were deleted afterwards (tables verified empty).

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

## Handoff notes / gotchas
- Checkout directory is literally named `node_modules`; `bootstrap.js` sets `NODE_PATH` and must stay first in `server.js`.
- No production code writes permanent bytes to local disk. `data/tmp` and `D:\catbox_staging` are transient.
- `DISCORD_BOTS` tokens, tunnel tokens, Supabase keys and `NODE_UPLOAD_SECRET` must never be committed.
- Plain API clients still get synchronous 200 + plain-text URL. Async mode is opt-in via `X-Catbox-Async: 1`.
- The Worker quota is durable via `QUOTA_KV`; the in-memory map is only a local fallback.
- The Go worker is a scaffold; treat it as untested until compiled on a node.
- Keep `02-PHASES.md` and this file in sync at every phase boundary.
