# Environment variables

Set values in a deployment secret manager or process environment. `.env.example` contains
placeholders only. Do not commit `.env`, paste keys into commands that are recorded, or print
environment values in logs.

## Runtime, webhook and credentials

| Variable | Required in staging / production | Default | Secret? | Placeholder / notes |
| --- | --- | --- | --- | --- |
| `PORT` | No / no | `3000` | No | `3000`; bind port for the API. |
| `NODE_ENV` | Yes / yes | `development` | No | Set `production` in both deployed processes. |
| `RUN_MIGRATIONS_ON_START` | No / No | `false` | No | Set `true` only for a deliberate production fallback. Normal release uses the one-shot migration job. Non-production always migrates on startup. |
| `TWILIO_ACCOUNT_SID` | Yes / yes | None | Yes | `AC<32-character-account-sid>`; Twilio account identifier. |
| `TWILIO_AUTH_TOKEN` | Yes / yes | None | Yes | `<twilio-auth-token>`; sends messages and validates signatures. |
| `TWILIO_WHATSAPP_FROM` | Yes / yes | None | No* | `whatsapp:+<sandbox-or-approved-sender-number>`; sender configured in Twilio. |
| `TWILIO_WEBHOOK_VALIDATE` | Yes / yes | `true` | No | Must remain `true` in staging/production. Production startup exits if false. |
| `PUBLIC_BASE_URL` | Yes / yes | None | No | `https://staging.example.invalid`; exact externally visible origin, no trailing slash. Pin it to avoid proxy-derived URL differences. |
| `ADMIN_API_KEY` | Bootstrap only / bootstrap only | Unset | Yes | `<generated-bootstrap-platform-admin-key>`; at least 16 chars. Remove from runtime environment after an admin user/key is provisioned if operationally appropriate. Admin API remains enabled when users exist. |
| `CERTIFICATE_SECRET` | Recommended / recommended | Derived from Twilio auth token | Yes | `<stable-certificate-hmac-secret>`; at least 16 chars if supplied. Changing it invalidates already-issued certificate links; use a stable independent secret. |
| `CERT_RESEND_COOLDOWN_MINUTES` | No / no | `10` | No | Integer `1..10080`; per-certificate resend cooldown. |
| `OPTOUT_HASH_SECRET` | Yes / yes | None in production | Yes | At least 32 random characters. Generate with `openssl rand -hex 32`; store and back it up with database backups. Losing/changing it makes existing HMAC opt-outs unmatchable and can re-enable sends. Secret rotation needs a dual-secret migration procedure; do not rotate ad hoc. |
| `MEDIA_DIR` | No / no | `./media` | No | `/app/media` in the container; public attachment directory. Never store secrets or personal exports here. |
| `CORS_ORIGINS` | Usually no / usually no | Unset | No | `https://console.example.invalid`; comma-separated allowlist. Unset disables CORS headers. |

`*` The sender number is not an authentication secret, but treat it as configuration that may
identify the account.

`PUBLIC_BASE_URL` is concatenated with Express `req.originalUrl` for signature verification.
When unset, the app derives the URL from `req.protocol` and `req.hostname`; `trust proxy` is set
to one hop so a directly connected TLS-terminating proxy's `X-Forwarded-Proto` and
`X-Forwarded-Host` are respected. Configure the proxy to overwrite forwarded headers and do not
expose the app port directly to untrusted clients. Set the exact public base URL in staging and
production whenever possible.

## PostgreSQL

| Variable | Required in staging / production | Default | Secret? | Placeholder / notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Yes / yes | None | Yes | `postgres://APP_USER:<password>@DB_HOST:5432/ekatra`; API/worker application connection. May use a managed transaction pooler if its transaction semantics are compatible with the app workload. |
| `MIGRATION_DATABASE_URL` | Yes for deploy migration job / yes for deploy migration job | Unset; runner falls back to `DATABASE_URL` | Yes | `postgres://MIGRATOR:<password>@DIRECT_DB_HOST:5432/ekatra`; direct/session connection only. Session advisory locks do not work through transaction-pooling proxies. |
| `DATABASE_SSL` | Yes (`require`) / yes (`require`) | `off` | No | `require` for hosted Postgres with TLS; certificate verification is enabled. |
| `DATABASE_POOL_MAX` | No / no | `10` | No | Integer `1..100`; size each API/worker pool. Must satisfy `2 * WORKER_MAX_JOBS_PER_TICK + 2 <= DATABASE_POOL_MAX`. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | No / no | `10000` | No | Integer `1000..300000`; API query timeout in milliseconds. Migration runner uses a dedicated pool with statement timeout disabled. |
| `DATABASE_IDLE_TIMEOUT_MS` | No / no | `30000` | No | Integer `1000..3600000`; idle pool-client timeout in milliseconds. |

Use separate least-privilege database identities: the migration role owns schema objects and
performs DDL; the app role has only `CONNECT`, schema `USAGE`, and required table/sequence
read/write grants. Never give the app role the migration credential.

## Twilio Content templates and request timeout

Every template SID is optional and must match `HX` plus 32 hexadecimal characters. Empty values
keep typed-command fallback behavior. Production WhatsApp templates must be approved and match
the code's expected variables/button payloads before use.

| Variable | Required in staging / production | Default | Secret? | Notes |
| --- | --- | --- | --- | --- |
| `TWILIO_CONTENT_SID_NAV` | No / no | Unset | No | Navigation quick replies. |
| `TWILIO_CONTENT_SID_RESUME` | No / no | Unset | No | Resume quick replies. |
| `TWILIO_CONTENT_SID_START_COURSE` | No / no | Unset | No | Start-course quick reply. |
| `TWILIO_CONTENT_SID_COURSES` | No / no | Unset | No | Course selection quick replies. |
| `TWILIO_CONTENT_SID_MAIN_MENU` | No / no | Unset | No | Main-menu quick replies. |
| `TWILIO_CONTENT_SID_CMDS_1` | No / no | Unset | No | Command help page one. |
| `TWILIO_CONTENT_SID_CMDS_2` | No / no | Unset | No | Command help page two. |
| `TWILIO_CONTENT_SID_QUIZ` | No / no | Unset | No | Quiz answer quick replies. |
| `TWILIO_CONTENT_SID_WELCOME` | No / no | Unset | No | Registration welcome; outside the 24-hour window it must be approved. |
| `TWILIO_CONTENT_SID_SCHEDULE` | No / recommended | Unset | No | Approved out-of-window scheduled-lesson quick reply. Its quick-reply button payload must be `NEXT`; that payload is mapped by the webhook to the existing `NEXT` command. Unset means closed-window delivery fails visibly rather than being silently lost. |
| `TWILIO_REQUEST_TIMEOUT_MS` | No / no | `10000` | No | Integer `1000..60000`; Twilio API call deadline in milliseconds. |

## Worker, scheduling, readiness and retention

All variables in this table are optional in staging and production and use the listed defaults.
They are not secrets.

| Variable | Default | Valid range / purpose |
| --- | --- | --- |
| `READINESS_HEARTBEAT_MAX_AGE_MS` | `60000` | `1000..3600000`; worker heartbeat age threshold reported by `/worker-status`. |
| `WORKER_POLL_MS` | `2000` | `500..60000`; worker loop delay in milliseconds. |
| `WORKER_VISIBILITY_SECS` | `300` | `30..3600`; reclaim horizon for work stuck in processing. |
| `WORKER_MAX_JOBS_PER_TICK` | `4` | `1..1000`; per-tick job cap, subject to pool-size formula above. |
| `SCHEDULER_ENABLED` | `true` | `true` or `false`; enable scheduler within worker. |
| `SCHEDULER_TICK_MS` | `60000` | `5000..3600000`; schedule cadence in milliseconds. |
| `SCHEDULER_GRACE_HOURS` | `6` | `1..72`; catch-up grace for missed slots. |
| `RATE_LIMIT_AUTH_FAILURES_PER_HOUR` | `100` | `10..100000`; per-IP failed-auth budget. |
| `PROCESSED_MESSAGE_RETENTION_DAYS` | `30` | `1..3650`; webhook de-duplication retention. |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | `1..3650`; audit retention, pruned only by `npm run cleanup`. |
| `JOB_RETENTION_DAYS` | `90` | `1..3650`; completed/failed jobs. |
| `ATTEMPT_RETENTION_DAYS` | `90` | `1..3650`; outbound attempt rows. |
| `INBOUND_EVENT_RETENTION_DAYS` | `90` | `1..3650`; completed/failed inbound event rows. |
| `DEAD_LETTER_RETENTION_DAYS` | `90` | `1..3650`; completed/discarded dead letters. |

Retention jobs do not remove opt-outs, active enrollments, certificates, or learner profiles.
Confirm local privacy/legal retention policy before changing the defaults.

## Optional course Q&A (Ollama)

These variables are optional in staging/production, non-secret, and have safe defaults. If the
model is unavailable or times out, the learner receives the fixed fallback and lesson delivery
continues.

| Variable | Default | Valid range / purpose |
| --- | --- | --- |
| `LLM_MODEL` | `qwen2.5:1.5b-instruct-q4_k_m` | Non-empty model name. |
| `LLM_BASE_URL` | `http://localhost:11434` | Valid URL for the Ollama-compatible service. |
| `LLM_TIMEOUT_MS` | `10000` | `1000..60000`; hard request timeout. |
| `LLM_MAX_TOKENS` | `250` | `50..2000`; generation bound. |
| `LLM_TEMPERATURE` | `0.2` | `0..2`; generation randomness. |
| `LLM_QUESTIONS_PER_HOUR` | `20` | `1..500`; in-memory per-learner question budget. |

Production startup guards and sizing rules are exercised by `tests/env.test.ts` and
`tests/ingress.test.ts`: required Twilio/database config, production opt-out secret, production
signature validation, and worker concurrency versus pool capacity. Do not set fake credentials or
disable signature validation in a public environment.
