# Ekatra — Developer Statement of Work

Work packages, acceptance tests, estimate assumptions, and handover for the Stage 1 WhatsApp learning platform.
Supports `Ekatra_Project_Scope_and_SOW_v1.4.md` and `PRODUCTION_SCOPE.md`.

## Engagement baseline

- Duration target: less than four calendar weeks from an unblocked kickoff.
- Staffing assumption: one experienced full-time developer.
- Prerequisites: immediate access to a usable staging environment, active WhatsApp provider account, rapid product decisions, existing implementation that can be hardened rather than rebuilt.
- External access or approval delays move the acceptance date unless scope is explicitly reduced.

## Work packages

### WP0 — Verify reality and freeze release scope

**Objective:** Establish the deployment inventory, feature matrix, and release backlog before implementation begins.

**Tasks:**
1. Record repository/branch state, deployed SHA, active URLs, host, provider, database/migration state, worker topology, and operational owners.
2. Inspect existing local changes and preserve them; identify which changes belong to this release.
3. Establish a supported-feature matrix from current customer usage. Record the active WhatsApp provider and deployment target; preserve working customer behavior.
4. Confirm course fixture, pilot cohort, languages already supported, roles, completion rules, traffic baseline, retention period, and recovery targets.
5. Create release backlog with dependency order and estimates; identify required provider templates/credentials without exposing secrets.

**Deliverables:** Deployment inventory; agreed feature matrix; decision log; ranked backlog; revised estimate.

**Acceptance:** Client/product owner and developer agree the release channel, exclusions, acceptance fixture, and operating targets. Unknown production state is explicitly recorded, not presented as verified.

**Gate milestone:** A = WP0–WP1 at end of Week 1.

---

### WP1 — Make builds and deployment reproducible

**Objective:** From a clean checkout, documented commands install, test, and build every shipped package; container API and worker start; UI reaches intended API; repeat migration run is safe; failed migration cannot silently pass; no production database modified during verification.

**Tasks:**
1. Review and accept the implemented kickoffAuthored.ts fix; both pass the clean-source build. Verify the packaged API and worker in staging.
2. Validate corrected Docker packaging, runtime imports, provider variable names, JWT settings, and frontend build-time API URL in the selected environment. Local production bundles assembled; containers remain to be exercised.
3. Pin supported Node/pnpm versions consistently; use lockfile installs.
4. Establish safe environment validation and secret handling; inspect tracked source/history for exposed secrets; coordinate rotation of confirmed exposures.
5. Validate the implemented migration ledger/order/checksums and transaction failure behavior against the complete application schema. Reconcile a reviewed ledger baseline for existing databases; test upgrade on an isolated copy; synthetic PostgreSQL regression coverage already passing.
6. Define compiled-artifact policy and prevent generated files from polluting source.

**Deliverables:** Passing clean build; usable local/staging setup; configuration reference; repeatable migrations.

**Acceptance:**
- From a clean checkout, documented commands install, test, and build every shipped package.
- Container API and worker start; UI reaches intended API.
- Repeat migration run is safe; failed migration cannot silently pass.
- No production database is modified during verification.

**Gate milestone:** A = WP0–WP1 at end of Week 1.

---

### WP2 — Close access and ingress gaps

**Objective:** Authorization policy; automated negative tests; enabled-route inventory; learner data/control runbook.

**Tasks:**
1. Enforce tenant membership and required roles across courses, learners, schedules, analytics, users, FSMs, messages, and certificate-related operations.
2. Review token issuance/validation and admin provisioning/recovery. Prevent cross-use of learner/admin tokens and client-selected privilege escalation.
3. Require valid signatures/secrets for enabled provider endpoints, using raw request bytes where required by the selected provider. Disable unused ingress explicitly.
4. Keep learner-web routes disabled for this release; ensure mock OTP cannot become active in production. Document their unfinished status.
5. Apply bounded payloads and appropriate rate limiting; redact tokens/credentials and unnecessary learner data in logs; validate configurable origins.
6. Add learner opt-out persistence and suppression checks to every scheduled/broadcast send path. Provide controlled export/deletion workflow and retention configuration/runbook.

**Deliverables:** Authorization policy; automated negative tests; enabled-route inventory; learner data/control runbook.

**Acceptance:**
- Test accounts in two organizations cannot read/write each other's resources.
- Lower roles cannot perform restricted actions.
- Invalid signatures rejected.
- Disabled endpoints cannot trigger processing.
- Production mock auth unavailable.
- Opt-out prevents future scheduled sends without erasing required state unexpectedly.

**Gate milestone:** B = WP2–WP3 at end of Week 3.

---

### WP3 — Make inbound processing and scheduling recoverable

**Objective:** Durable inbound/outbound processing; corrected scheduling; operational replay procedure/tool.

**Tasks:**
1. Persist accepted inbound events before acknowledgment; process with durable retries and correlation IDs.
2. Make learner progress updates safe under duplicate events, retries, and concurrent messages; distinguish received/processing/completed/failed outcomes.
3. Track outbound attempts and provider identifiers. Handle uncertain send outcomes explicitly; do not promise universal exactly-once external delivery.
4. Fix custom schedule due-time evaluation, timezone handling, missed ticks, and daily/custom overlap.
5. Require production Redis/worker dependencies. Handle worker crashes and failed sends without marking failures successful.
6. Provide capped retry/backoff, dead-letter inspection, and controlled replay; define replay permissions and audit trail.

**Deliverables:** Durable inbound/outbound processing; corrected scheduling; operational replay procedure/tool.

**Acceptance:**
- Repeated inbound event advances state once.
- Crash after acceptance recovers.
- Concurrent events do not corrupt progress.
- 09:30 and timezone-boundary fixtures deliver at intended times.
- Restart catches up according to documented policy.
- Opt-out/paused learners are excluded.
- Failed work remains visible and replayable.

**Gate milestone:** B = WP2–WP3 at end of Week 3.

---

### WP4 — Finish the supported learner and admin journey

**Objective:** Working supported UI; canonical course fixture; lifecycle integration tests; short acceptance demo.

**Tasks:**
1. Verify create/import → validate → draft → publish → enroll → schedule → deliver → quiz → pause/resume → complete → certificate.
2. Make the supported React admin's course, learner, progress, history/status, and failure views use correct APIs; show accurate loading/error/empty states.
3. Hide controls unsupported in the minor release, including learner web, Telegram, and inactive provider controls. Retire static admin only after WP0 confirms replacement parity and usage.
4. Ensure text, required image/document media, and certificates are accessible through production URLs with suitable access/lifetime rules and no unintended learner data exposure.
5. Keep course progression independent of AI availability. Bound Q&A context, timeout, and per-user usage; record model usage where available and provide clear fallback.
6. Preserve existing required behavior without introducing new agent frameworks or retrieval infrastructure.

**Deliverables:** Working supported UI; canonical course fixture; lifecycle integration tests; short acceptance demo.

**Acceptance:**
- A new authorized learner completes the fixture on the chosen provider.
- Progress survives restart.
- Errors do not appear as success.
- One logical completion produces a consistent certificate record.
- Publication requires admin action.
- AI timeout does not block subsequent lessons.
- Unsupported controls are absent or clearly unavailable.

**Gate milestone:** C = WP4–WP5 before the four-week deadline.

---

### WP5 — Operate, validate and hand over

**Objective:** CI/release workflow; test report; monitoring/alert evidence; recovery evidence; handover pack.

**Tasks:**
1. CI checks all shipped builds/typechecks, meaningful lint, and unit/integration tests. Fix the current lint baseline; do not disable rules globally to obtain a green result.
2. Produce one traceable deployable artifact and deploy that tested artifact to staging/production through the agreed process.
3. Add dependency-aware readiness, worker heartbeat, queue depth/age, failed delivery, API error/latency, and AI usage visibility. Configure actionable alerts with named recipients.
4. Prove backup/restore and previous-version rollback; document schema compatibility constraints and maintenance steps.
5. Run the agreed load profile in staging, failure/replay suite, and a small real-channel acceptance journey.
6. Deliver operational/developer documentation and train the maintainer.

**Deliverables:** CI/release workflow; test report; monitoring/alert evidence; recovery evidence; handover pack.

**Acceptance:**
- All release gates pass.
- Client accepts staging evidence.
- Production deployment is authorized.
- Post-deploy smoke checks pass.
- The designated maintainer can follow the runbook.

**Gate milestone:** C = WP4–WP5 before the four-week deadline.

## Release acceptance matrix

| Gate | Required evidence |
|---|---|
| Clean build | Successful CI from a fresh checkout including backend, worker, frontend, and shared packages |
| Access isolation | Automated role/tenant denial tests plus valid-user positive cases |
| Ingress | Valid/invalid signature fixtures; inactive ingress rejection; event acknowledgment after durable receipt |
| Delivery recovery | Duplicate/restart/concurrency and failed-send replay tests with stable learner progress |
| Scheduling | Non-hour send time, timezone boundary, restart catch-up, overlap, and opt-out test results |
| Learning journey | Recorded staging run of approved course and automated deterministic journey tests |
| AI fallback | Timeout/unavailable/limit cases; lessons still progress; generated content remains draft |
| Capacity | Agreed load profile completes; proposed webhook acknowledgment p95 ≤1s, zero lost accepted events, queue drains within 5 minutes after the stubbed burst; report hardware and actual results |
| Operations | Readiness failure visible when required DB/Redis unavailable; worker-down alert triggers within proposed 5 minutes; named owner receives test alert |
| Recovery | Restore of isolated backup with measured RPO/RTO; rollback demonstration; migration compatibility notes |
| Production | Approved deploy; deployed SHA/artifact recorded; small real-provider smoke test; no unresolved release-blocking defects |

**Note:** Numbers in the capacity/operations rows are proposed acceptance targets, to be finalized in WP0. Full response latency with real AI/messaging providers is reported separately and must not be represented by stubbed-load results.

**Release-blocking defect definition:** Unauthorized access, lost/corrupted learner progress, inability to complete the core journey, persistent delivery/scheduling failure, or inability to deploy/recover safely. Cosmetic defects may be accepted only in a documented residual backlog.

## Four-week delivery sequence

| Period | Primary outcome | Work packages |
|---|---|---|
| Days 1–3 | Reality verified, scope frozen, active provider/host recorded, clean-build blockers identified | WP0; WP1 starts |
| Week 1 | Reproducible build, configuration, migrations, staging baseline | WP1; CI foundation |
| Week 2 | Tenant/role enforcement, verified webhook ingress, opt-out and data controls | WP2; WP3 starts |
| Week 3 | Durable processing, scheduling, retry/replay, and core admin/learner journey | WP3; WP4 |
| Final week | Acceptance suite, monitoring, restore/rollback evidence, production release, handover | WP4; WP5 |

**WP0 must produce a task-level forecast within the first three working days.** If verified effort exceeds available four-week capacity, the product owner must defer non-critical breadth while retaining security, data-isolation, progress-integrity, deployment, and recovery gates.

## Responsibilities and dependencies

**Client/product owner provides:** Environment/account access, provider test number and required messaging templates, representative approved course/media, test users from two organizations, active-customer feature requirements, decisions on host/provider/retention/roles, staging acceptance, authorization for production release.

**Developer provides:** Implementation, migration safety, tests/evidence, estimates and progress reporting, early escalation of blockers, release/rollback procedure, handover. Use test data and isolated resources for validation; never message real learners or migrate production incidentally during tests.

**Operational owner provides/accepts:** Alert destination, backup ownership, incident triage, ongoing hosting/provider costs. Name this person before release.

## Change control and implementation constraints

- Preserve current customer behavior and existing local work until its ownership/scope is established.
- Submit reviewable changes by work package, with tests and rollout impact. Avoid unrelated refactors and dependency churn.
- Adding Telegram, learner web, offline mobile, Meta Cloud API, or GramIQ certification to the minor release requires a written transfer from the larger scope with stated effort, schedule, and acceptance impact.
- A new host, any additional provider/channel, broad historical migration, or AI architecture expansion requires an explicit scope change containing effort, schedule, and acceptance impact.
- Do not destructively clean archives, delete production data, rotate credentials, or deploy without the relevant owner coordinating the action.
- Treat unavailable features as disabled capabilities, not dashboard promises.
- Do not perform production verification by sending unsanctioned messages or incurring unbounded AI spend.
- Maintain one current setup guide and one release runbook; mark conflicting historical plans superseded.

## Handover checklist

- Merged/reviewed source and dependency lockfile; release tag/SHA and artifact reference.
- Supported-feature/channel matrix, environment variable names, local/staging setup and architecture notes.
- Migration ledger, deployment order, backup/restore and rollback instructions.
- Test fixtures, CI logs, load/failure report and real-provider acceptance evidence.
- Monitoring links, alert ownership, retry/replay and incident runbooks.
- Tenant/role policy, opt-out/export/delete/retention procedures and secret management instructions.
- Residual defects, deferred capabilities, operating costs observed during testing and ownership of follow-up work.
- Maintainer walkthrough and completed acceptance record.

## Approval record

Product owner: ______ Developer: ______ Operational owner: ______

Stage 1 — WhatsApp learning platform: WhatsApp learner delivery, web admin, and required operating platform; less than four weeks (confirmed 15 September 2026)
Stage 2 — Full multi-channel product: separately estimated Telegram, learner web, offline mobile, and direct Meta Cloud API/GramIQ WhatsApp milestones
Selected provider: ______ Hosting target: ______ Pilot cohort: ______
Confirmed traffic/recovery targets: ______ Fee/start date/support terms: ______
Scope baseline accepted on: ______ Staging accepted on: ______ Production release accepted on: ______
