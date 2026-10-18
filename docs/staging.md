# Staging deploy (prepared, NOT deployed)

PostgreSQL 18 is the system of record. Progress writes are row-locked, so more than one app
replica can run, but start with one replica + one managed database (simplest durable setup).
No hosting provider has been selected; keep deployment wiring host-neutral. The host comparison
below is informational only. See `docs/environment.md` for the complete environment variable
inventory, defaults, secret classification, and production requirements.

## 1. Required environment variables

Copy `.env.example` only as a starting template; replace all placeholders in a secret manager or
process environment. Production requires Twilio credentials/from-number, `PUBLIC_BASE_URL`,
`DATABASE_URL`, `DATABASE_SSL=require`, `OPTOUT_HASH_SECRET`, and signature validation enabled.
`ADMIN_API_KEY` is needed only for bootstrap; see `docs/environment.md`.

## 2. Database, volumes, least-privilege role

| Volume | Purpose |
| --- | --- |
| `ekatra-pgdata` (local compose only) | PostgreSQL 18 data dir. Back up with `pg_dump` (see §5). |
| `ekatra-media` | Lesson attachments served at `/media`. |

`docker-compose.yml` wires PostgreSQL 18, a one-shot `migrate` job, API, and worker. API and worker
wait for migration job success. On a managed host, use its PostgreSQL service and run the same
standalone migration command as a pre-deploy job. No host-specific files are created until a
provider is selected.

Use separate least-privilege runtime and migration roles. The migration role owns schema objects
and has DDL rights; the app role has only data access:

```sql
CREATE ROLE ekatra_migrator LOGIN PASSWORD '<managed-secret>';
CREATE ROLE ekatra_app LOGIN PASSWORD '<separate-managed-secret>';
GRANT CONNECT ON DATABASE ekatra TO ekatra_app;
GRANT CONNECT ON DATABASE ekatra TO ekatra_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO ekatra_migrator;
GRANT USAGE ON SCHEMA public TO ekatra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ekatra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ekatra_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ekatra_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ekatra_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ekatra_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ekatra_app;
```

`DATABASE_URL` uses `ekatra_app`; `MIGRATION_DATABASE_URL` uses `ekatra_migrator`. The migration
role must own existing objects it alters. On managed Postgres, verify it can create/alter schema
objects and acquire advisory locks. Migration URLs must be direct/session connections, never a
transaction-pooling PgBouncer URL. Keep restore/sequence-repair credentials with the database
operator and out of the API/worker environment.

## 3. Public URL + Twilio webhook

- App: `https://<staging-host>/health` → `{"status":"ok"}`; `https://<staging-host>/register` → registration page.
- Webhook (Twilio → app): `POST https://<staging-host>/webhooks/whatsapp`.
- Status callback receiver: `POST https://<staging-host>/webhooks/whatsapp/status`. The current
  outbound sender does not set a per-message Twilio `statusCallback`, so status events are not
  automatically subscribed to yet; see [the Twilio setup runbook](twilio-setup.md).
- In Twilio console → Messaging → Senders → WhatsApp sender → "When a message comes in": method `POST`, URL = webhook above. Set `PUBLIC_BASE_URL` to `https://<staging-host>` and restart so signatures verify. If relying on the proxy-derived fallback, the direct one-hop proxy must overwrite `X-Forwarded-Proto` and `X-Forwarded-Host`.

## 4. Twilio sandbox setup (staging tests only, no real learners)

1. Console → Messaging → Try it out → Send a WhatsApp message. Note the sandbox number + `join <code>`.
2. Set `TWILIO_WHATSAPP_FROM=whatsapp:+<sandbox-number>`.
3. From a test phone, send `join <code>`.
4. Point the sandbox "When a message comes in" at the staging webhook URL (POST). The app honors
   one directly connected TLS proxy hop for `X-Forwarded-Proto` and `X-Forwarded-Host`; pin
   `PUBLIC_BASE_URL` to the exact external origin.
5. Send `hi` → expect menu; `COURSES` → list; `START <slug>` → lesson 1.

## 5. Backup / restore

- Backup (online, safe while running — `pg_dump` custom format, compressed):
  `DATABASE_URL=<url> sh scripts/backup.sh ./backups/ekatra-$(date +%Y%m%d-%H%M%S).dump`
- Restore proof into an isolated empty database (never over live data first):
  `createdb verify_restore && sh scripts/restore.sh ./backups/<file>.dump <verify-url>`
- Restoring over live data: stop the app first (`--clean` drops objects before recreating).
- Pre-deploy migrations: `npm run migrate` (tsx) or `npm run migrate:prod` after `npm run build`.
  Set `MIGRATION_DATABASE_URL` to the direct migrator connection; if unset, migration falls back
  to `DATABASE_URL`. The runner uses a session advisory lock and no statement timeout, applies
  checksum-verified migrations atomically, and performs idempotent opt-out HMAC backfill using
  the same `OPTOUT_HASH_SECRET` as runtime. The command is safe to repeat and exits non-zero on a
  failed migration. Never edit a shipped migration; append only.
- Production API and worker skip startup migrations by default. Development/test retain startup
  migration behavior. `RUN_MIGRATIONS_ON_START=true` is an explicit production override; normal
  deployment runs the one-shot job before the new API/worker version. Backups/restores and
  sequence repairs remain database-operator tasks. Point-in-time recovery (WAL archiving) is a
  managed-hosting decision beyond dump files — see PHASE2_5_REPORT.md.

## 6. Smoke-test checklist (staging, test numbers only)

- [ ] `GET /health` → `{"status":"ok"}` (also Docker `HEALTHCHECK`).
- [ ] `GET /register` → 200, registration form renders.
- [ ] `POST /register` with test name/number/course+consent → 200 pending; no welcome sent outside 24h window.
- [ ] Sandbox `hi` → Start Course prompt; `START COURSE` → lesson 1.
- [ ] `NEXT` → lesson 2; `PAUSE` → paused; `NEXT` while paused → no lesson; `RESUME` → active.
- [ ] Finish course → exactly one `certificates` row; `CERTIFICATE` re-sends, never duplicates.
- [ ] `STOP` → exactly one confirmation, then silence; `START` → subscribed again.
- [ ] Bad/missing `X-Twilio-Signature` → 403 `invalid_signature`, no send, no DB change.
- [ ] Set `BASE_URL` and `ADMIN_KEY` from the operator's environment and run `npm run staging:smoke`.
- [ ] Stop Ollama (or unset `LLM_BASE_URL`) → lessons still send; question → fixed fallback.
- [ ] Backup script runs; restore proof into an isolated DB verifies (see Phase 2.5 report).

## 7. Host comparison (app + managed Postgres 18)

| Host | Cost (approx) | Ease | Limits |
| --- | --- | --- | --- |
| **Fly.io** (app + managed Postgres) | ~$5–7/mo app + ~$7/mo 1 GB PG | Good: `fly.toml`, healthchecks, any region. | Smallest PG class is plenty (KBs of data). |
| **Render** (web service + managed Postgres) | ~$7–12/mo service + ~$6/mo PG | Easiest: dashboard + `render.yaml`; free TLS, deploys on push. | Check current terms — avoid free tier for staging. |
| **Hetzner Cloud VPS** (CX22 + Docker) | ~€4–5/mo (2 vCPU, 4 GB RAM, 40 GB disk) | Most manual: VM + compose up (app + `postgres:18`), Caddy for TLS. | Cheapest; you own updates/backups/firewall. No built-in healthchecks. |

Recommendation: **Fly.io** for staging — managed Postgres 18 removes backup/PITR operations,
one app machine is enough to start, and extra replicas are possible later (row locks already
serialise progress). **Do not deploy until you choose.** No infrastructure has been provisioned.
