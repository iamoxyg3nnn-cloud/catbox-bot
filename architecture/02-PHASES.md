# Work Breakdown — Phases and Task Checklist

This file is the authoritative "what remains to be built" list. Update `03-PROGRESS.md` with status; keep this file stable unless scope changes.

---

## P0 — Documentation and handoff scaffolding
- [x] Create `architecture/` with 3 markdown files.
- [x] Record approved architecture, decisions, constraints.
- [x] Record all phases and acceptance criteria.
- [x] Record progress/handoff tracker.
- [x] Verify docs still match code at each phase boundary.

## P1 — Core storage refactor (this repo, local, testable)
- [x] `src/config.js`: env-driven `MAX_FILE_SIZE` default 20 MiB; Discord/transport config.
- [x] `src/storage/discord.js`: bot-aware upload, resolve, remove; header-driven rate limiting; streaming multipart.
- [x] `src/storage/mock.js` + `src/storage/index.js`: test-only transport and factory.
- [x] `src/db.js`: new file columns + migration + expired-file helpers; no disk unlink in db layer.
- [x] `src/api.js`: async storage-backed commit/delete; 20 MiB messages.
- [x] `server.js`: 302 download resolver; mock CDN route; purge via Discord delete; no permanent disk writes.
- [x] `test/api.test.js` + `test/discord.test.js`: mock transport, unit tests, async jobs, internal hook.
- [x] `bootstrap.js`: NODE_PATH shim for the oddly-named checkout directory.
- [x] `npm test`: green with mock transport (now **42/42** including P3 Worker tests).
- [ ] Manual live verification with one real bot (upload → refresh → delete). **Needs real token.**
- [ ] Manual live verification with 20 bots/channels. **Needs 20 real tokens/channels.**

**Acceptance:** `npm test` green with `DISCORD_TRANSPORT=mock`; no production code path writes permanent bytes; `/files/:name` returns 302 when metadata has a CDN URL.

## P2 — Cloned metadata backend
- [x] `infra/supabase/schema.sql` — full metadata model + atomic `claim_upload_job()` RPC + RLS + `nodes.draining` + journal metadata.
- [x] `src/adapters/supabase.js` — PostgREST adapter matching the `db.js` function surface (no new npm deps).
- [x] `src/dbAdapter.js` — selects SQLite or Supabase by env.
- [x] All callers (`server.js`, `api.js`, `auth.js`, `jobs.js`) now `await` DB calls; `asyncRoute()` + Express error handler added. SQLite path verified (42/42 tests, 40/40 loadgen smoke); 8 adapter contract tests added.
- [x] `test/supabase-adapter.test.js` — 8 offline contract tests for headers, filters, upsert, RPC, boolean `draining`, `in` syntax, missing jobs and errors; three latent adapter bugs fixed.
- [ ] Run the full flow against a real cloned Supabase instance (RLS and real `claim_upload_job()` concurrency) before enabling `SUPABASE_URL` in production.
- [x] `src/cache.js` — Upstash Redis REST (card-free) with in-memory fallback; used for `cdn:*` URL cache.
- [x] Signed-URL cache invalidation on delete.
- [x] `infra/actions/docker-compose.yml` — separate Postgres + PostgREST + Redis stack (no existing Supabase).
- [x] `infra/actions/workflow.yml.example` — self-chaining Actions + CF Tunnel scaffold.
- [x] `scripts/migrate-metadata.js` — one-shot SQLite → Supabase metadata migration (no bytes).
- [ ] Create separate public `catbox-actions` GitHub repo from `Supabase-Actions` and apply the workflow.
- [ ] Apply schema + seed 20 `discord_bots` rows (IDs/channels only, no tokens).
- [ ] Configure GitHub Secrets: `CF_TUNNEL_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_*`, `NODE_UPLOAD_SECRET`, Discord tokens.
- [ ] Tunnel hostnames: `api.catbox.<domain>`, `db.catbox.<domain>`.

**Acceptance:** Express runs against cloned Postgres+Redis with no SQLite dependency; control plane reachable via tunnel.

## P3 — Cloudflare Worker router
- [x] `workers/catbox-router/index.js` — auth/quota, least-loaded node selection, streamed body proxy.
- [x] `workers/catbox-router/wrangler.toml.example` — KV quota binding, dynamic control-plane registry, no tokens committed.
- [x] Durable per-IP quota via `QUOTA_KV` with in-memory fallback for local tests.
- [x] `GET /api/nodes` + node heartbeats supply the live registry (static `NODE_REGISTRY` is the fallback).
- [x] `test/worker.test.js` — 4 tests: health, least-loaded routing, 20 MiB rejection, no-nodes 503.
- [ ] Create the `QUOTA_KV` namespace and deploy with `wrangler deploy`; point frontend `API_BASE` at Worker.
- [ ] Verify CORS/security headers in a real browser.

**Acceptance:** Browser upload reaches a node's `D:` disk without CORS errors; node URLs never exposed.

## P4 — Node fleet worker (Windows RDPs)
- [x] `node-worker/main.go` — streaming `POST /upload` to `STAGING_DIR` (`D:\catbox_staging`), `GET /api/jobs/:id`, `/api/health` with pending/active and staged disk usage, reaper + stale recovery via `<job_id>.json` sidecars.
- [x] `node-worker/discord.go` — `files[1]` upload, header-driven rate buckets, 429 `retry_after`, URL expiry parsing, `Verify()` helper.
- [x] `POST /internal/files` control-plane hook with shared secret (tested).
- [x] Per-channel semaphores alongside per-bot serialisation.
- [x] `Verify()` called before deleting staged bytes.
- [x] Heartbeat POST to control-plane `/internal/nodes/heartbeat` every 15s.
- [x] Idempotent `recordFile()` so lost acknowledgements replay safely.
- [x] `upload_journal` + `POST /internal/journal` + sweep in `src/jobs.js` for "Discord succeeded, metadata failed".
- [x] Go worker journals metadata when the control plane is briefly unreachable instead of orphaning the message.
- [ ] Compile with `go build ./...` on a node (no Go toolchain in this workspace).
- [ ] Roll out to node-1..node-15/18.

**Acceptance:** 1,000 queued uploads spread across nodes; staged files disappear after success; killed node jobs are retried.

## P5 — Frontend, UX and hardening
- [x] API response shapes preserved for plain clients (`/files/:name` URL).
- [x] `X-Catbox-Async: 1` + `202 {job_id,status_url}` + polling UI (queued → uploading → ready).
- [x] `GET /api/config` mirrors `MAX_FILE_SIZE`; limit text corrected to 20 MB.
- [x] Experimental-storage notice in FAQ and legal pages.
- [x] Per-user/IP coarse quota in Worker scaffold (durable KV binding wired).
- [x] `scripts/loadgen.js` — 1,000 synthetic async uploads with bounded concurrency + status polling (no Discord needed).
- [ ] Run the synthetic load test before any live bot test.
- [ ] Final CORS/security-header verification (covered by worker tests, needs real browser).

## P6 — Deployment and operations
- [x] `infra/RUNBOOK.md` — secrets inventory, setup, live verification, alerts, recovery.
- [x] `scripts/verify-discord.js` — automated one-bot/all-bot live Discord verification.
- [x] `GET /api/metrics` — queue depth, journal backlog, node health, uptime (no secrets).
- [ ] Create/public repos, secrets, tunnels, Worker deploy, frontend deploy, fleet rollout.
- [x] 429/retry counters in the Discord transport + `discord.*` metrics; staged
  bytes/files reported by node heartbeats and aggregated as `staging.*`.
- [x] `/ops` dependency-free dashboard charts the 429 rate and staged disk usage.
