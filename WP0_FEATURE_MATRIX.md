# WP0 — Supported Feature Matrix

Verified from codebase + SOW + phase reports. Items marked `[CUSTOMER]` require product owner confirmation.
Items marked `[NOT IMPLEMENTED]` are explicitly out of Stage 1 scope.

## Core learning journey

| Feature | Status | Evidence |
|---|---|---|
| Create course (draft) | Implemented | POST /admin/courses |
| Edit course title/description | Implemented | PATCH /admin/courses/:id |
| Append lesson | Implemented | POST /admin/courses/:id/lessons |
| Replace lesson | Implemented | PUT /admin/courses/:id/lessons/:lessonId |
| Delete lesson (refused if enrolled) | Implemented | DELETE /admin/courses/:id/lessons/:lessonId |
| Publish course | Implemented | POST /admin/courses/:id/publish |
| Unpublish course | Implemented | POST /admin/courses/:id/unpublish |
| Delete course (refused if enrolled) | Implemented | DELETE /admin/courses/:id |
| Lesson media (image/document/video/audio/link) | Implemented | lesson_items kind CHECK |
| Quiz items with correct answer | Implemented | lesson_items kind 'quiz', options JSONB |
| Quiz explanation (nullable, max 1000 chars) | Implemented | migration v5, types/course.ts |
| Enroll learner with consent | Implemented | POST /admin/enrollments, registration |
| Start course / receive lesson 1 | Implemented | courseBot START command |
| Next lesson | Implemented | courseBot NEXT command |
| Pause / Resume | Implemented | courseBot PAUSE/RESUME, admin pause/resume |
| Progress tracking (last_delivered_position) | Implemented | enrollments table |
| Completion (completed_at, one record) | Implemented | enrollments.completed_at, certificates UNIQUE |
| Certificate PDF + resend | Implemented | certificate.service.ts, /admin/certificates/:id/resend |
| Certificate cooldown | Implemented | CERT_RESEND_COOLDOWN_MINUTES |
| STOP / START opt-out | Implemented | optout.service.ts, OptOutGuardSender |
| Opt-out suppresses all future sends | Implemented | OptOutGuardSender wraps all send paths |
| Bounded course Q&A (tutor) | Implemented | CourseTutor, 3-layer scope gate |
| AI fallback (timeout/unavailable/limit) | Implemented | CourseTutor returns refusal/unavailable |
| AI questions per learner per hour | Implemented | LLM_QUESTIONS_PER_HOUR (default 20) |
| Quiz answers never given to model | Implemented | courseTutor.ts excludes quiz items |

## Scheduling

| Feature | Status | Evidence |
|---|---|---|
| Course schedule (daily/custom) | Implemented | course_schedules table, SchedulerService |
| Enrollment schedule override | Implemented | enrollment_schedules table |
| Org defaults (timezone, daily time, grace) | Implemented | organisations.default_* columns |
| IANA timezone support | Implemented | Intl.DateTimeFormat, isValidTimezone |
| Daily time (HH:MM) | Implemented | TIME_RE validation |
| Custom slots (dow + time) | Implemented | CustomSlot interface |
| Catch-up after downtime (max 1 lesson/tick) | Implemented | evaluateDue, claimSlot |
| Grace window (expired slots consumed) | Implemented | evaluateDue skip action |
| 24-hour window (template outside window) | Implemented | processor.ts handleScheduledLesson |
| Schedule template (TWILIO_CONTENT_SID_SCHEDULE) | Implemented | env.ts, scheduling.md |

## Delivery & reliability

| Feature | Status | Evidence |
|---|---|---|
| Durable inbound receipt (persist before ack) | Implemented | InboundEventService, whatsapp.controller |
| Webhook idempotency (MessageSid dedupe) | Implemented | processed_messages, inbound_events.message_sid UNIQUE |
| Duplicate webhook → one progress update | Implemented | durable-inbound.test.ts |
| Per-learner serialization (advisory lock) | Implemented | keyedMutex, lockNamespaces (learner=3) |
| Outbound attempt tracking | Implemented | outbound_messages, outbound_attempts |
| Per-item sent markers (retry from first unsent) | Implemented | outbound_message_items (migration v3) |
| Uncertain send outcome (unknown state) | Implemented | retry.ts classifySendError, outbound_messages.status |
| Capped retry/backoff (30s→1h, 6 attempts) | Implemented | retry.ts backoffMs, RETRY_MAX_ATTEMPTS |
| Dead-letter queue | Implemented | dead_letters table, DeadLetterService |
| Controlled replay (with time-of-replay guards) | Implemented | DeadLetterService.replay |
| Controlled discard (with reason) | Implemented | DeadLetterService.discard |
| Audit log for replay/discard | Implemented | failures.controller.ts audit calls |
| Worker crash recovery (reclaim stuck jobs) | Implemented | worker.ts reclaimStuck, visibility timeout |
| Worker heartbeat | Implemented | worker_heartbeat, /worker-status |
| Queue depth metrics | Implemented | metrics.service.ts, worker loop |
| /ready endpoint (DB + migration check) | Implemented | src/app.ts |
| /worker-status endpoint (heartbeat staleness) | Implemented | src/app.ts |
| /health endpoint | Implemented | src/app.ts |

## Security & access control

| Feature | Status | Evidence |
|---|---|---|
| Organisations | Implemented | organisations table, org-scoped routes |
| Admin users (platform_admin, org_admin, instructor) | Implemented | admin_users table, role CHECK |
| API keys (hash stored, plaintext shown once) | Implemented | admin_api_keys table |
| Bootstrap key (ADMIN_API_KEY) | Implemented | adminAuth.service.ts |
| Per-user keys | Implemented | rotateUserKey, revokeUserKey |
| Key recovery (platform_admin) | Implemented | recoverUserKey |
| Tenant isolation (cross-org = 404) | Implemented | resolveOrgFromPrincipal, org-scoped queries |
| Role enforcement | Implemented | requireRole middleware |
| Instructor read-only learners | Implemented | readLearners role, navigation restrictions |
| Twilio signature validation (default on) | Implemented | validateTwilioSignature.ts, TWILIO_WEBHOOK_VALIDATE |
| Production refuses to start with validation off | Implemented | assertProductionIngress |
| Auth failure rate limiting | Implemented | authFailureLimiter (security.ts) |
| Bounded payloads (256kb JSON) | Implemented | express.json({ limit: '256kb' }) |
| CORS allow-list | Implemented | corsIfConfigured, CORS_ORIGINS |
| Log redaction (no tokens/credentials) | Implemented | logger, errors.ts |
| Phone masking in admin UI | Implemented | learners-screen, operations-screens |
| Explicit admin-only phone reveal | Implemented | learner detail reveal |
| Opt-out hash (HMAC-SHA-256, keyed) | Implemented | optout.service.ts, OPTOUT_HASH_SECRET |
| Opt-out survives learner deletion | Implemented | forgetPhone, phone_hash retained |
| Learner export (org-scoped) | Implemented | learner.controller.ts exportLearner |
| Learner delete (org-scoped) | Implemented | learner.controller.ts deleteLearner |
| Retention pruning (jobs, attempts, inbound, dead letters) | Implemented | cleanup.ts, retention env vars |
| Opt-outs/enrollments/certificates/learners never pruned | Implemented | cleanup.ts |

## Admin UI (React console)

| Screen | Status | Evidence |
|---|---|---|
| Dashboard (courses list + status) | Implemented | admin-ui/src/routes/dashboard.tsx |
| Courses (create/edit/publish/unpublish/delete) | Implemented | admin-ui/src/routes/courses.tsx |
| Lessons (media/quiz editing, preserved IDs) | Implemented | courses-screen.tsx |
| Learners (list, detail, masked phone, reveal) | Implemented | admin-ui/src/routes/learners.tsx |
| Enrollments (create, pause, resume) | Implemented | admin routes + UI |
| Schedules (course + enrollment + org defaults) | Implemented | admin-ui/src/routes/schedules.tsx |
| Delivery (list, filter, pagination, attempt detail) | Implemented | admin-ui/src/routes/delivery.tsx |
| Failures (list, counts, inspect, replay, discard) | Implemented | admin-ui/src/routes/failures.tsx |
| Certificates (list, resend, cooldown) | Implemented | admin-ui/src/routes/certificates.tsx |
| Users & API keys (create, rotate, revoke, recover) | Implemented | admin-ui/src/routes/users.tsx |
| Audit (read-only viewer) | Implemented | admin-ui/src/routes/audit.tsx (via navigation) |
| Status (readiness + worker heartbeat) | Implemented | admin-ui/src/routes/status.tsx |
| Strict CSP for /console | Implemented | src/app.ts console serving |
| Instructor nav: Courses + Learners only | Implemented | navigation.ts, navigation.test.tsx |

## Explicitly NOT in Stage 1 (out of scope)

| Feature | Status | Reason |
|---|---|---|
| Telegram delivery | [NOT IMPLEMENTED] | Stage 2A |
| Learner web + OTP | [NOT IMPLEMENTED] | Stage 2B |
| Offline mobile + sync | [NOT IMPLEMENTED] | Stage 2C |
| Meta Cloud API adapter | [NOT IMPLEMENTED] | Stage 2D |
| GramIQ WhatsApp adapter | [NOT IMPLEMENTED] | Stage 2D |
| Multi-agent orchestration | [NOT IMPLEMENTED] | Deferred (SOW) |
| Knowledge graphs / mastery prediction | [NOT IMPLEMENTED] | Deferred (SOW) |
| Voice/IVR, image/video generation | [NOT IMPLEMENTED] | Deferred (SOW) |
| Billing/subscriptions | [NOT IMPLEMENTED] | Deferred (SOW) |
| Self-service tenant signup | [NOT IMPLEMENTED] | Deferred (SOW) |
| Enterprise SSO | [NOT IMPLEMENTED] | Deferred (SOW) |
| Static admin retirement | [NOT IMPLEMENTED] | Pending WP0 parity check |
| Visual FSM editor redesign | [NOT IMPLEMENTED] | Scoped back (SOW) |

## Customer dependencies to confirm

| Item | Status | Needed from |
|---|---|---|
| Active WhatsApp provider confirmed | [CUSTOMER] Twilio (code), production account needed | Product owner |
| Production hosting target | [CUSTOMER] Not selected | Product owner |
| Approved representative course | [CUSTOMER] TBD | Product owner |
| Pilot cohort (test learners) | [CUSTOMER] TBD | Product owner |
| Test users from two organizations | [CUSTOMER] TBD | Product owner |
| Provider templates approved | [CUSTOMER] TBD | Product owner + Twilio |
| WhatsApp template (welcome, schedule) | [CUSTOMER] TBD | buttons:setup + Meta approval |
| Recovery targets (RPO/RTO) | [CUSTOMER] SOW proposes RPO ≤24h, RTO ≤4h | Product owner confirm |
| Traffic baseline | [CUSTOMER] SOW proposes 1,000 learners, 100 concurrent, 10 webhook/s | Product owner confirm |
| Retention period | [CUSTOMER] Defaults: 90 days delivery, 365 days audit, 30 days dedupe | Product owner confirm |
| Languages supported | [CUSTOMER] TBD | Product owner |
| Completion rules | [CUSTOMER] TBD | Product owner |
