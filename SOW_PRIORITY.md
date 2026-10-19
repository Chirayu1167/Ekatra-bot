# SOW Priority List — Remaining Work (strict audit)

Priority basis: what blocks staging acceptance and production release vs. nice-to-have doc/code hygiene.

## P0 — Blocks production acceptance (do in order)

### P0-1. WP0 — Verify reality and freeze release scope (operator + product owner)
Blocker for: staging acceptance, load test, production smoke, rollback/recovery targets.
- Record deployed SHA, host, provider, DB/migration state, worker topology, operational owners
- Establish supported-feature matrix from real customer usage; record active WhatsApp provider and deployment target
- Confirm course fixture, pilot cohort, roles, completion rules, traffic baseline, retention period, recovery targets (RPO ≤24h, RTO ≤4h)
- Create release backlog with dependency order and estimates; decision log; revised estimate
- Acceptance: client/product owner and developer agree release channel, exclusions, acceptance fixture, operating targets
- Owner: product owner + developer + operational owner

### P0-2. Select host → Docker/compose → staging deploy → smoke test
Blocker for: learning-journey gate, clean-build-on-staging gate, production gate.
- Select production hosting target (none selected; PHASE6: "No hosting provider was selected")
- Exercise Docker build + compose locally (never run; PHASE6: "Docker was not run locally")
- Deploy packaged API + worker to staging; verify UI reaches intended API
- Run `scripts/staging-smoke.ts` (already implemented; needs real staging target)
- Record deployed SHA/artifact reference
- Owner: developer

### P0-3. Load test suite + capacity report (built from nothing — genuinely missing)
Blocker for: capacity gate (p95 ≤1s webhook ack, zero lost accepted events, queue drains ≤5min after stubbed burst; report hardware + actual results).
- No load-test tooling exists (no k6/artillery/autocannon/loadtest anywhere). Must create test harness and scripts.
- Run agreed load profile in staging; report hardware and actual results.
- Owner: developer

### P0-4. Rollback demo + RPO/RTO restore rehearsal
Blocker for: recovery gate (restore of isolated backup with measured RPO/RTO; rollback demonstration; migration compatibility notes).
- No rollback procedure/procedure exists (AUDIT.md:157 marks "Rollback Plan FAIL"). `backup.sh`/`restore.sh` scripts exist but rollback of previous version is not documented.
- Demonstrate previous-version rollback; document schema compatibility constraints and maintenance steps.
- Owner: developer + operational owner

### P0-5. Alert wiring + test alert to named recipient
Blocker for: operations gate (readiness failure visible when DB/Redis unavailable; worker-down alert within 5 min; named owner receives test alert).
- `config/alerts.yml` exists (11 rules, placeholder owner `platform-oncall@example.com`) but no Alertmanager/receiver wiring, no test-alert evidence. HARDENING_PROGRESS and SOW_REMAINING still mark this open.
- Wire alerts to named recipient; fire a test alert to confirm delivery.
- Owner: developer + operational owner

### P0-6. Real-provider smoke test with pilot cohort
Blocker for: production gate (approved deploy; deployed SHA/artifact recorded; small real-provider smoke test; no unresolved release-blocking defects).
- Staging-smoke.ts exists but only does invalid-signature check; no real-provider delivery to approved cohort.
- Run staged journey end-to-end with real provider on approved pilot cohort; never message real learners.
- Owner: developer + client

## P1 — Code fixes (security/hygiene, low effort, high signal)

### ✅ P1-1. DONE — `errorHandler.ts:44` — mask phone in req.path
`maskPhone(req.path)` now applied before logging errors; prevents learner phone leakage in URL-encoded error paths.

### ✅ P1-2. DONE — Certificate resend opt-out pre-check (`admin.controller.ts:933-1002`)
Added `optOuts.isOptedOut(enr.user_id)` check before enqueuing certificate resend; throws 409 if opted out instead of dead-lettering silently.

### ✅ P1-3. DONE — `@ekatra/delivery` phantom claim
Removed from `DEVELOPER_SOW.md` task 1; `HARDENING_PROGRESS.md` WP1 row marked `[ ]` with note that no `@ekatra/delivery` package exists (delivery code lives in `src/`).

### ✅ P1-4. DONE — `PgIdempotencyStore` dead code
Deleted `src/services/idempotency.pg.ts` (never imported anywhere). Removed its `describe` block and import from `tests/infra.test.ts`. Dedupe remains handled by `inbound_events.message_sid UNIQUE` + `jobs (kind, dedupe_key) UNIQUE`.

### ✅ P1-5. DONE — `recordLlmTokens` wired
`LLMService.complete` now calls `recordLlmTokens(model, 'input', ...)` and `recordLlmTokens(model, 'output', ...)` with char-based token estimates.

### ✅ P1-6. DONE — `VERIFY.md` stale count
Updated "348 passed + 1 skip, 25 files" → "445 passed + 1 skip, 36 files".

### ⬜ P1-7. Twilio lookup reconciliation for `unknown` outcomes
`OutboundService.reconcileUnknown()` exists (`outbound.service.ts:377`) but has no caller. The Twilio client interface (`TwilioMessagesClient`) only types `messages.create` — adding `messages(sid).fetch()` lookup + a scheduler/admin endpoint to call `reconcileUnknown` is needed. Lower priority: dead-letter replay already covers manual handling of `unknown` rows.

## P2 — Handover and documentation (after all gates green)

### P2-1. Handover pack consolidation
- SOW handover checklist (lines 570-578): lockfile, release tag/SHA + artifact reference, feature/channel matrix, env var names, setup notes, architecture notes, migration ledger, deployment order, backup/restore + rollback instructions, test fixtures, CI logs, load/failure report, real-provider acceptance evidence, monitoring links, alert ownership, retry/replay + incident runbooks, tenant/role policy, opt-out/export/delete/retention procedures, secret management instructions, residual defects, deferred capabilities, operating costs, follow-up ownership.
- Owner: developer

### P2-2. Maintainer walkthrough + signed approval record
- Product owner / developer / operational owner sign-off on scope baseline, staging acceptance, production release dates.

### P2-3. Docs hygiene
- Mark conflicting historical plans superseded; keep one setup guide and one release runbook.

## Ready-now items (no external dependency)

These can start immediately while waiting for host/hosting access:
- P1-1 through P1-7 code fixes
- P2-1 handover pack assembly (draft)
- P0-1 WP0 preparation (backlog skeleton, feature-matrix draft)

## Estimate note
Code-level scope (WP2/WP3/WP4) is vetted as implemented with passing tests. All remaining effort is P0 ops/acceptance work plus P1 fixes. P0-3 (load tests) and P0-5 (alert wiring) have no existing code and are the biggest effort sinks after WP0 host selection.
