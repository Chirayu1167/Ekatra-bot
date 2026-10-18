# Hardening changes

## Task 1 — Durable inbound acceptance

- Made inbound-event acceptance and job enqueue transactional, including duplicate-webhook repair.
- Added a recovery sweep for accepted inbound events without an inbound job.
- Regression coverage: `tests/durable-inbound.test.ts`.

## Task 2 — Atomic job claiming

- Replaced read-then-claim with one atomic `UPDATE … RETURNING` claim using `FOR UPDATE SKIP LOCKED`.
- Regression coverage: `tests/durable-inbound.test.ts` exercises concurrent claimers.

## Task 3 — Scheduler locking and slot durability

- Kept the advisory lock and unlock on the same dedicated PostgreSQL client.
- Made each schedule-slot claim and its job insertion transactional.
- Regression coverage: `tests/scheduler.test.ts`.

## Task 4 — Tenant-isolated learner data

- Added append-only migration v6, `learner-export-organisation-scope`, to attribute historical
  inbound events only when a learner has enrollments in exactly one organization.
- Scoped learner export and deletion to the caller's organization; shared profiles are preserved
  when the learner remains enrolled elsewhere.
- Regression coverage: `tests/pg.foundation.test.ts` and `tests/learner.data.test.ts`.

## Task 5 — Confirmed-send progress retries

- Retry progress actions after an already-confirmed delivery without resending the message.
- Write a replayable dead letter when progress-action retries are exhausted.
- Regression coverage: `tests/durable-outbound.test.ts`.

## Task 6 — Poison inbound work

- Dead-letter generic inbound processing failures and associate outbound retry exhaustion with the
  originating inbound event.
- Regression coverage: `tests/durable-inbound.test.ts` and `tests/durable-outbound.test.ts`.

## Task 7 — Instructor course read-only access

- Guarded course and lesson create, edit, delete, publish, and unpublish routes for
  `org_admin`/`platform_admin`; course reads remain available to instructors.
- Hid course mutation controls from instructors while retaining read-only course content.
- Updated instructor fixtures to create test courses using an admin key.
- Regression coverage: `tests/admin.rbac.test.ts`, `tests/admin.step1.test.ts`, and
  `admin-ui/src/components/console/screens.test.tsx`.

## Task 8 — Reproducible admin UI install

- Aligned `@eslint/js` to ESLint 9 and upgraded `@testing-library/react` to a release whose peer
  range supports React 19. Regenerated the admin UI lockfile.
- Removed the ESLint-config compatibility workaround.
- Verified clean `npm ci --prefix admin-ui` without peer-resolution override flags.

## Task 9 — Unified scripts

- Added `ci:all`, `typecheck:all`, `lint:all`, `test:all`, and compiled `start:worker` scripts.

## Task 10 — Container and environment configuration

- Added the readiness heartbeat setting to `.env.example` and corrected the certificate-secret
  production guidance to match the actual fallback behavior.
- Confirmed Docker ignore rules exclude references, archives, environment files, generated output,
  dependencies, and data.
- Validated `docker-compose.yml` syntax. Docker itself was not run.

## Verification and limitations

- Focused results during implementation: `tests/admin.rbac.test.ts` 11 passed,
  `tests/admin.step1.test.ts` 53 passed, and admin UI `screens.test.tsx` 18 passed.
- Combined root gate passed: typecheck, lint, and build; 455 passed, 1 skipped, 0 failed across
  36 test files.
- Admin UI gate passed: typecheck, lint, and build; 49 passed, 0 skipped, 0 failed across 8 test
  files.
- A clean `npm ci --prefix admin-ui` completed without peer-resolution override flags. The Compose
  file parsed as valid YAML; Docker was not run.
- This folder has no Git metadata, so the requested per-task commits could not be created.
- No real Twilio messages were sent. Container runtime behavior remains unverified.

## File manifest

- Backend: `src/controllers/whatsapp.controller.ts`, `src/services/inboundEvents.service.ts`,
  `src/services/jobs.service.ts`, `src/worker/processor.ts`, `src/services/scheduler.service.ts`,
  `src/db/migratePg.ts`, `src/services/enrollment.service.ts`,
  `src/controllers/learner.controller.ts`, `src/services/learner.service.ts`,
  `src/routes/admin.ts`.
- Tests: `tests/durable-inbound.test.ts`, `tests/scheduler.test.ts`,
  `tests/learner.data.test.ts`, `tests/pg.foundation.test.ts`, `tests/durable-outbound.test.ts`,
  `tests/admin.rbac.test.ts`, `tests/admin.step1.test.ts`.
- Admin UI: `admin-ui/src/components/console/courses-screen.tsx`,
  `admin-ui/src/components/console/screens.test.tsx`, `admin-ui/eslint.config.js`,
  `admin-ui/package.json`, `admin-ui/package-lock.json`.
- Runtime/project configuration: `package.json`, `.env.example`, `CHANGES.md`.
- Documentation and support: `README.md`, `scripts/check-admin-ui-deps.cjs`.
