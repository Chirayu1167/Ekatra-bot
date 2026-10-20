# WP0 — Ranked Backlog

Ranked by dependency order. Estimates are in developer-days (1 experienced full-time developer).
Items marked `[CUSTOMER]` require product owner confirmation before work can start.

## Rank 1 — WP0: Scope/discovery (Days 1–3)

| ID | Task | Estimate | Dependency | Status |
|---|---|---|---|---|
| WP0-1 | Record repository/branch state, deployed SHA, URLs, host, provider, DB/migration state, worker topology, operational owners | 0.5 day | None | In progress (this document) |
| WP0-2 | Inspect existing local changes; identify which belong to this release | 0.5 day | None | Complete (19 staged admin-ui files) |
| WP0-3 | Establish supported-feature matrix from current customer usage; record active provider and deployment target | 1 day | None | In progress (WP0_FEATURE_MATRIX.md) |
| WP0-4 | Confirm course fixture, pilot cohort, languages, roles, completion rules, traffic baseline, retention period, recovery targets | 1 day | [CUSTOMER] Product owner input | Not started |
| WP0-5 | Create release backlog with dependency order and estimates; identify required provider templates/credentials (no secrets) | 0.5 day | WP0-4 | This document |
| WP0-6 | Deliverables: deployment inventory, feature matrix, decision log, ranked backlog, revised estimate | 0.5 day | WP0-1–5 | This document |

**WP0 subtotal: 4 days**

**Acceptance:** Client/product owner and developer agree release channel, exclusions, acceptance fixture, operating targets. Unknown production state explicitly recorded.

**Gate milestone:** A = WP0–WP1 at end of Week 1.

## Rank 2 — WP1: Build/deployment (Week 1)

| ID | Task | Estimate | Dependency | Status |
|---|---|---|---|---|
| WP1-1 | Select production hosting target | [CUSTOMER] 0 day (decision) | WP0-3 | Not started |
| WP1-2 | Add host-specific deployment configuration / deploy command | 1 day | WP1-1 | Not started |
| WP1-3 | Exercise Docker build + compose locally | 0.5 day | None | Not started |
| WP1-4 | Confirm production database migration state | 0.5 day | None | Not started |
| WP1-5 | Validate packaged API and worker in staging | 1 day | WP1-2, staging access | Not started |
| WP1-6 | Validate container API/worker start; UI reaches intended API | 0.5 day | WP1-5 | Not started |
| WP1-7 | Pin Node/pnpm versions; lockfile installs | 0.25 day | None | Not started |
| WP1-8 | Safe environment validation and secret handling; inspect for exposed secrets; coordinate rotation | 1 day | None | Not started |
| WP1-9 | Validate migration ledger/order/checksums against complete schema; test upgrade on isolated copy | 1 day | None | Not started |
| WP1-10 | Define compiled-artifact policy; prevent generated files from polluting source | 0.5 day | None | Not started |

**WP1 subtotal: 6.25 days**

## Rank 3 — WP2: Security/ingress (Week 2)

| ID | Task | Estimate | Dependency | Status |
|---|---|---|---|---|
| WP2-1 | Enforce tenant membership and required roles across all admin operations | 0.5 day | None | Code complete; verify tests |
| WP2-2 | Review token issuance/validation; prevent cross-use and privilege escalation | 0.5 day | None | Code complete; verify tests |
| WP2-3 | Require valid signatures/secrets for enabled provider endpoints; disable unused ingress | 0.5 day | None | Code complete; verify tests |
| WP2-4 | Keep learner-web routes disabled; mock OTP cannot activate in production | 0.25 day | None | Code complete; verify |
| WP2-5 | Apply bounded payloads, rate limiting, secret redaction in logs, validate CORS origins | 0.5 day | None | Code complete; verify tests |
| WP2-6 | Add opt-out persistence and suppression checks to every send path; export/deletion workflow; retention runbook | 0.5 day | None | Code complete; verify tests |

**WP2 subtotal: 2.75 days**

## Rank 4 — WP3: Delivery/recovery (Week 3)

| ID | Task | Estimate | Dependency | Status |
|---|---|---|---|---|
| WP3-1 | Persist accepted inbound events before acknowledgment; durable retries; correlation IDs | 0.5 day | None | Code complete; verify tests |
| WP3-2 | Make progress updates safe under duplicates, retries, concurrency; distinguish outcomes | 0.5 day | None | Code complete; verify tests |
| WP3-3 | Track outbound attempts and provider IDs; handle uncertain send outcomes explicitly | 0.5 day | None | Code complete; verify tests |
| WP3-4 | Fix schedule due-time evaluation, timezone handling, missed ticks, daily/custom overlap | 0.5 day | None | Code complete; verify tests |
| WP3-5 | Require production Redis/worker dependencies; handle crashes without marking failures successful | 0.5 day | None | Code complete; verify tests |
| WP3-6 | Capped retry/backoff, dead-letter inspection, controlled replay; replay permissions and audit trail | 0.5 day | None | Code complete; verify tests |

**WP3 subtotal: 3 days**

## Rank 5 — WP4: Learner/admin journey (Week 3–4)

| ID | Task | Estimate | Dependency | Status |
|---|---|---|---|---|
| WP4-1 | Verify full journey: create→publish→enroll→schedule→deliver→quiz→pause/resume→complete→certificate | 1 day | WP2, WP3 | Code complete; staging test needed |
| WP4-2 | Admin views use correct APIs; accurate loading/error/empty states | 0.5 day | None | Code complete; verify tests |
| WP4-3 | Hide unsupported controls (learner web, Telegram, inactive provider) | 0.25 day | None | Code complete; verify |
| WP4-4 | Media/certificates accessible via production URLs; no unintended learner data exposure | 0.5 day | [CUSTOMER] PUBLIC_BASE_URL | Not started |
| WP4-5 | Course progression independent of AI; bounded Q&A; fallback; record model usage | 0.5 day | None | Code complete; verify tests |
| WP4-6 | Preserve existing behavior; no new agent frameworks or retrieval infra | 0.25 day | None | Code complete |

**WP4 subtotal: 3 days**

## Rank 6 — WP5: Operate/validate/handover (Final week)

| ID | Task | Estimate | Dependency | Status |
|---|---|---|---|---|
| WP5-1 | CI checks all builds/typechecks/lint/tests; fix lint baseline | 0.5 day | None | Code complete; verify |
| WP5-2 | Produce traceable deployable artifact; deploy to staging/production | 1 day | WP1-5, host selected | Not started |
| WP5-3 | Add readiness, heartbeat, queue depth, failed delivery, API error/latency, AI usage visibility | 0.5 day | None | Code complete (metrics) |
| WP5-4 | Configure actionable alerts with named recipients | 0.5 day | [CUSTOMER] Operational owner named | Not started |
| WP5-5 | Prove backup/restore; previous-version rollback; document schema compatibility | 1 day | [CUSTOMER] pg_dump/pg_restore | Not started |
| WP5-6 | Run load profile in staging; failure/replay suite; real-channel acceptance journey | 1 day | [CUSTOMER] Staging + provider | Not started |
| WP5-7 | Deliver operational/developer documentation; train maintainer | 0.5 day | All above | Not started |

**WP5 subtotal: 5 days**

## Total estimate

| Work package | Days |
|---|---|
| WP0 | 4 |
| WP1 | 6.25 |
| WP2 | 2.75 |
| WP3 | 3 |
| WP4 | 3 |
| WP5 | 5 |
| **Total** | **24** |

**Available capacity:** <4 calendar weeks (~20 working days)  
**Variance:** +4 days over capacity if all items executed

## Deferral guidance (per SOW)

If verified effort exceeds four-week capacity, the product owner must defer non-critical breadth while retaining:
- Security (WP2)
- Data isolation (WP2)
- Progress integrity (WP3)
- Deployment (WP1)
- Recovery (WP5)

Suggested deferral order (lowest impact first):
1. WP5-7 (training can be async) — 0.5 day
2. WP4-4 (media URLs — needs PUBLIC_BASE_URL anyway) — 0.5 day
3. WP1-7 (version pinning — already in .nvmrc) — 0.25 day
4. WP2-4 (learner-web disabled — already done) — 0.25 day

**Total deferrable: 1.5 days → revised estimate 22.5 days**

Still exceeds 20-day capacity. Further deferral would require cutting from security/isolation/integrity/deployment/recovery gates, which the SOW prohibits.

## Customer confirmation needed

| Item | Why it affects estimates |
|---|---|
| Hosting provider | WP1-2 effort depends on host |
| Staging access | WP1-5, WP5-6 require staging environment |
| Provider credentials | WP5-6 real-channel test needs provider access |
| Operational owner | WP5-4 alerts need named recipient |
| pg_dump/pg_restore | WP5-5 backup proof needs these tools |
| Recovery targets | WP0-4 confirms RPO/RTO; affects WP5-5 |
| Traffic baseline | WP0-4 confirms load profile; affects WP5-6 |
