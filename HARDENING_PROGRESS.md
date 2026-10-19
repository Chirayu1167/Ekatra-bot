# Ekatra — Stage 1 Hardening Progress

Implementation evidence for the Stage 1 WhatsApp learning platform SOW (`Ekatra_Project_Scope_and_SOW_v1.4.md`).
Maintained as the source of truth for completed implementation, test evidence, and remaining developer work.

## Baseline

- Repository: `github.com/iabheejit/ekatra-platform` (main branch)
- Local working copy: `/Users/Shared/Scripts/ekatra-master/active/ekatra-platform`
- Stack: TypeScript/Express backend, React admin console, PostgreSQL 18, Redis-backed worker, Twilio WhatsApp
- Node: 24.16.0 (see `.nvmrc`)

## Implementation coverage (15 September 2026)

Approximately 25-30% of the Stage 1 implementation foundations are covered, based on engineering judgment.
This is an engineering estimate, not a measured task-weighted percentage, a payment milestone, or production acceptance.
No complete work package has passed its full SOW acceptance gate yet.

Recorded evidence: 445 passing unit/regression tests (1 skipped), 48 admin-ui tests (0 skipped/failed),
one separately verified migration integration test, clean-source build, clean typecheck, clean lint.
Latest course-editor follow-up passed all six frontend tests and frontend TypeScript checks.
These are cumulative local results, not hosted CI or production acceptance.
No production deployment or real-learner verification has been performed.

## Work package status

### WP0 — Scope/discovery

| Item | Status | Evidence |
|---|---|---|
| Minor release boundary agreed | [x] | SOW v1.4, Stage 1 confirmed for <4 weeks |
| Repository assessed | [x] | Codebase reviewed; ~25-30% foundations |
| Deployed SHA recorded | [ ] | Not yet — hosting provider not selected |
| Host/provider recorded | [ ] | Not yet — WP0 operator task |
| Operational owners recorded | [ ] | Not yet — WP0 operator task |
| Customer dependencies inventoried | [ ] | Not yet — WP0 operator task |
| Acceptance fixture confirmed | [ ] | Not yet — WP0 operator task |

### WP1 — Build/deployment

| Item | Status | Evidence |
|---|---|---|
| Clean build (backend, worker, frontend, shared packages) | [x] | `npm run build` passes |
| Shared delivery package extracted | [ ] | No `@ekatra/delivery` package exists; delivery code lives in `src/` — claim in SOW docs is stale |
| Configuration aligned | [x] | Zod env validation in `src/config/env.ts` |
| Migration runner | [x] | `src/scripts/migrate.ts` with checksum/advisory locking |
| Deployable package assembly | [x] | Multi-stage Dockerfile, docker-compose, GHCR release workflow |
| Container/staging exercised | [ ] | Docker not run locally (PHASE6) |
| Full-schema migration verification | [ ] | Isolated PostgreSQL regression passing; full application-schema acceptance open |
| Secret/artifact policy checks | [x] | `.gitignore`, `.dockerignore`, tracked source/history scan |

### WP2 — Security

| Item | Status | Evidence |
|---|---|---|
| Admin token validation | [x] | `ADMIN_API_KEY`, per-user keys, `adminAuth.service.ts` |
| Signed webhook ingress | [x] | `validateTwilioSignature.ts`, `TWILIO_WEBHOOK_VALIDATE=true` default |
| Protected health actions | [x] | `/ready`, `/worker-status`, route inventory |
| Tenant/role isolation | [x] | Organisations, admin_users, org-scoped routes, cross-org 404 |
| Provisioning/revocation | [x] | User/key management, rotate, revoke, recover |
| Disabled-route policy | [x] | Learner-web routes disabled; mock OTP cannot activate in production |
| Opt-out persistence | [x] | `OptOutService`, `OptOutGuardSender`, HMAC phone hash |
| Data controls | [x] | Export/delete/runbook, retention config, cleanup script |
| Rate limiting | [x] | Auth failure limiter, bounded payloads, CORS allow-list |
| Log redaction | [x] | No tokens/credentials in logs; phone masking in admin UI |

### WP3 — Delivery/recovery

| Item | Status | Evidence |
|---|---|---|
| Worker initialization | [x] | `src/worker.ts`, reclaim stuck, poll loop, heartbeat |
| Redis configuration | [x] | Production Redis required; explicit degraded local dev mode |
| Failed-send reporting | [x] | Dead letters, failures list/inspect/replay/discard |
| Durable inbound receipt | [x] | `InboundEventService`, persist before acknowledgment, correlation IDs |
| Duplicate/concurrency safety | [x] | MessageSid dedupe, per-learner advisory lock, CAS progress updates |
| Outbound attempts | [x] | `outbound_messages`, `outbound_attempts`, monotonic status |
| Correct scheduling | [x] | `SchedulerService`, timezone-aware `evaluateDue`, grace window, catch-up |
| Controlled replay | [x] | `DeadLetterService.replay`, time-of-replay guards, audit trail |
| Capped retry/backoff | [x] | `retry.ts`, 30s base, doubling, 1h cap, ±20% jitter, max 6 attempts |
| Dead-letter inspection | [x] | `/admin/failures` list, counts by reason code |
| Worker crash recovery | [x] | `reclaimStuck`, visibility timeout, heartbeat staleness |

### WP4 — Product journey

| Item | Status | Evidence |
|---|---|---|
| API/UI contracts and mapping | [x] | Admin API routes, type fixes |
| Lesson-ID-preserving course edits | [x] | `PUT /admin/courses/:id/lessons/:lessonId` |
| Transactional/concurrency-aware saves | [x] | Enrollment CAS, row locks |
| Server-side deletion safeguards | [x] | Delete refused once learners enrolled |
| Full learner journey | [x] | Create→publish→enroll→schedule→deliver→quiz→pause/resume→complete→certificate |
| Certificates | [x] | One certificate per enrollment, HMAC code, resend cooldown |
| Bounded AI | [x] | `CourseTutor` three-layer scope gate, fallback, timeout, rate limit |
| Unsupported-control cleanup | [x] | Telegram/web learner/Stripe/etc. hidden from admin UI |

### WP5 — Operations

| Item | Status | Evidence |
|---|---|---|
| CI configuration | [x] | `.github/workflows/ci.yml`, `.github/workflows/release.yml` |
| Dependency readiness | [x] | `npm ci`, lockfile installs, `--legacy-peer-deps` |
| Setup documentation | [x] | README, VERIFY.md, docs/ |
| Hosted CI/lint | [x] | GitHub Actions runs typecheck/lint/test/build |
| Tested artifact deployment | [x] | Docker build, GHCR publication with digest |
| Monitoring/alerts | [x] Metrics | `metrics.service.ts`, `/metrics`, queue depth, heartbeat |
| Monitoring/alerts | [ ] Alerts | Actionable alerts with named recipients not configured |
| Load tests | [ ] | Not run; no load test code |
| Restore/rollback | [ ] | Backup test skipped (no `pg_dump`/`pg_restore`); rollback not demonstrated |
| Live acceptance | [ ] | No production deployment or real-provider smoke test |
| Handover | [ ] | Not yet delivered |

## Remaining developer work (per SOW)

1. Create `PRODUCTION_SCOPE.md` (SOW baseline)
2. Create `DEVELOPER_SOW.md` (work packages, acceptance tests, estimates)
3. Complete WP0 operator tasks (deployed SHA, host/provider, owners, customer dependencies, acceptance fixture)
4. Exercise Docker build + compose locally
5. Complete full-schema migration verification on isolated copy
6. Configure actionable alerts with named recipients
7. Run load profile in staging and report hardware/actual results
8. Complete backup/restore proof (install `pg_dump`/`pg_restore`)
9. Demonstrate rollback
10. Production deploy + real-provider smoke test
11. Handover pack and maintainer training

## Residual risks (documented, tracked)

- Uncertain-send duplicates: crash after Twilio accepted but before recording → possible double delivery on reconcile+retry. Progress stays exact; content may repeat.
- No automated Twilio status-callback reconciliation poller for `unknown` messages; operator lookup needed.
- No dual-secret transition for `OPTOUT_HASH_SECRET` rotation; losing/changing the secret silently re-enables messaging to opted-out numbers.
- CourseTutor rate limit is in-memory `Map`; not durable across restarts or shared across instances.

## Gates not yet passed

No complete work package has passed its full SOW acceptance gate. Release acceptance gates (clean build, access isolation, ingress, delivery recovery, scheduling, learning journey, AI fallback, capacity, operations, recovery, production) remain outstanding pending WP0–WP5 completion above.
