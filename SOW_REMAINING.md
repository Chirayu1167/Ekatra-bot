# Remaining Work: SOW vs Codebase

Strict comparison of `Ekatra_Project_Scope_and_SOW_v1.4.md` against the current codebase (all of D:\Ekatra).

## Status legend

- [ ] Not started
- [-] Partially done (operator task / documentation gap)
- [x] Complete (code implemented and tested)

## Code-level work packages

All five SOW work packages are implemented in code with passing gates (root: 445 passed / 1 skipped / 0 failed; admin-ui: 48 passed / 0 failed; typecheck, lint, build green).

| Work package | Scope | Status |
|---|---|---|
| WP0 | Scope/discovery | [-] Operator tasks not yet executed |
| WP1 | Build/deployment | [-] Host not selected; Docker not exercised locally |
| WP2 | Security/ingress | [x] Tenant/role isolation, signature validation, opt-out suppression |
| WP3 | Delivery/recovery | [x] Durable inbound/outbound, retry/replay, scheduling |
| WP4 | Learner/admin journey | [x] Full journey, React admin console, bounded AI |
| WP5 | Operate/validate/handover | [-] Alerts, backup/restore proof, load test, production release, handover |

## Remaining items

### 1. Missing SOW-referenced documents

The SOW references three source documents that do not exist in the repo (SOW lines 36-37, 234-237). Create or update SOW references:

- [ ] `HARDENING_PROGRESS.md` — completed implementation, test evidence, remaining developer work
- [ ] `PRODUCTION_SCOPE.md` — baseline for the SOW
- [ ] `DEVELOPER_SOW.md` — work packages, acceptance tests, estimate assumptions, handover

### 2. WP0 — Verify reality and freeze release scope (operator + product owner)

- [ ] Record repository/branch state, deployed SHA, active URLs, host, provider, database/migration state, worker topology, operational owners
- [ ] Inspect existing local changes; identify which changes belong to this release
- [ ] Establish supported-feature matrix from current customer usage; record the active WhatsApp provider and deployment target; preserve working customer behavior
- [ ] Confirm course fixture, pilot cohort, languages already supported, roles, completion rules, traffic baseline, retention period, recovery targets (RPO ≤ 24 hours, RTO ≤ 4 hours)
- [ ] Create release backlog with dependency order and estimates; identify required provider templates/credentials without exposing secrets
- [ ] Deliverables: deployment inventory; agreed feature matrix; decision log; ranked backlog; revised estimate
- [ ] Acceptance: client/product owner and developer agree release channel, exclusions, acceptance fixture, operating targets

### 3. WP1 — Make builds and deployment reproducible

- [ ] Select a production hosting target (currently omitted; PHASE6: "No hosting provider was selected")
- [ ] Add host-specific deployment configuration / deploy command
- [ ] Exercise Docker build + compose locally (not yet run; PHASE6: "Docker was not run locally")
- [ ] Confirm production database migration state (currently UNKNOWN per PHASE4)
- [ ] Validate packaged API and worker in staging; validate container API/worker start; UI reaches intended API
- [ ] Pin supported Node/pnpm versions consistently; use lockfile installs
- [ ] Establish safe environment validation and secret handling; inspect tracked source/history for exposed secrets; coordinate rotation of confirmed exposures
- [ ] Define compiled-artifact policy and prevent generated files from polluting source
- [ ] Acceptance: from a clean checkout, documented commands install, test, and build every shipped package; container API and worker start; repeat migration run is safe; failed migration cannot silently pass; no production database modified during verification

### 4. WP5 — Operate, validate and hand over

- [ ] Configure actionable alerts with named recipients (worker-down alert triggers within 5 minutes; named owner receives test alert) — SOW release acceptance row "Operations"
- [ ] Install `pg_dump`/`pg_restore` on verification host and complete the skipped backup/restore proof (`tests/backup.test.ts` is currently skipped) — SOW release acceptance row "Recovery"
- [ ] Demonstrate previous-version rollback
- [ ] Document schema compatibility constraints and maintenance steps
- [ ] Run the agreed load profile in staging: webhook acknowledgment p95 ≤ 1s, zero lost accepted events, queue drains within 5 minutes after the stubbed burst; report hardware and actual results — SOW release acceptance row "Capacity"
- [ ] Run failure/replay suite and a small real-channel acceptance journey
- [ ] Deliver operational/developer documentation and train the maintainer
- [ ] Acceptance: all release gates pass; client accepts staging evidence; production deployment authorized; post-deploy smoke checks pass; designated maintainer can follow the runbook

### 5. Production release acceptance

- [ ] Approved deploy; deployed SHA/artifact recorded
- [ ] Small real-provider smoke test with the approved pilot cohort (never real learners)
- [ ] Confirm no unresolved release-blocking defects (unauthorized access, lost/corrupted learner progress, inability to complete the core journey, persistent delivery/scheduling failure, inability to deploy/recover safely)
- [ ] Record selected provider, hosting target, and approved pilot cohort before the acceptance journey begins

### 6. Handover

- [ ] Handover checklist:
  - Merged/reviewed source and dependency lockfile; release tag/SHA and artifact reference
  - Supported-feature/channel matrix, environment variable names, local/staging setup and architecture notes
  - Migration ledger, deployment order, backup/restore and rollback instructions
  - Test fixtures, CI logs, load/failure report and real-provider acceptance evidence
  - Monitoring links, alert ownership, retry/replay and incident runbooks
  - Tenant/role policy, opt-out/export/delete/retention procedures and secret management instructions
  - Residual defects, deferred capabilities, operating costs observed during testing and ownership of follow-up work
  - Maintainer walkthrough and completed acceptance record
- [ ] Approval record signed: product owner, developer, operational owner

## Documented residual risks (to track, not necessarily block)

- [ ] Uncertain-send duplicates: crash after Twilio accepted but before recording → possible double delivery on reconcile+retry; progress stays exact; content may repeat
- [ ] No automated Twilio status-callback reconciliation poller for `unknown` messages; operator lookup needed
- [ ] No dual-secret transition for `OPTOUT_HASH_SECRET` rotation; losing/changing the secret silently re-enables messaging to opted-out numbers
- [ ] CourseTutor rate limit is in-memory `Map`; not durable across restarts or shared across instances
- [ ] Backup/restore proof skipped until `pg_dump`/`pg_restore` installed on verification host
- [ ] Docker, managed-Postgres role grants, actual release publication, browser CSP, sandbox join, STOP/START, real handset order/delivery require operator verification

## Release acceptance matrix (SOW gates) — gate-by-gate status

| Gate | Required evidence | Status |
|---|---|---|
| Clean build | Successful CI from fresh checkout including backend, worker, frontend, shared packages | [x] |
| Access isolation | Automated role/tenant denial tests plus valid-user positive cases | [x] |
| Ingress | Valid/invalid signature fixtures; inactive ingress rejection; event acknowledgment after durable receipt | [x] |
| Delivery recovery | Duplicate/restart/concurrency and failed-send replay tests with stable learner progress | [x] |
| Scheduling | Non-hour send time, timezone boundary, restart catch-up, overlap and opt-out test results | [x] |
| Learning journey | Recorded staging run of approved course and automated deterministic journey tests | [-] Needs production host |
| AI fallback | Timeout/unavailable/limit cases; lessons still progress; generated content remains draft | [x] |
| Capacity | Agreed load profile completes; p95 ≤1s; zero lost accepted events; queue drains ≤5 min; report hardware and actual results | [ ] |
| Operations | Readiness failure visible when required DB/Redis unavailable; worker-down alert within 5 min; named owner receives test alert | [ ] |
| Recovery | Restore of isolated backup with measured RPO/RTO; rollback demonstration; migration compatibility notes | [-] Backup test skipped |
| Production | Approved deploy; deployed SHA/artifact recorded; small real-provider smoke test; no unresolved release-blocking defects | [ ] |
