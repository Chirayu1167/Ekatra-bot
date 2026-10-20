# WP0 — Decision Log

Decisions made during Stage 1 scoping and implementation. Each decision records context, rationale, and owner.

## D-001: WhatsApp provider selection

**Decision:** Use Twilio as the active WhatsApp provider for Stage 1.

**Context:** The codebase is built around Twilio (REST API, webhook signatures, Content Templates, sandbox). SOW v1.4 allows preserving the provider used by current customers unless discovery identifies a blocker.

**Rationale:** Existing implementation, tests, and documentation all target Twilio. Switching providers would require new adapter work (Stage 2D scope).

**Owner:** Product owner  
**Date:** 15 September 2026  
**Status:** Confirmed (code-level), pending production credential confirmation

## D-002: Deployment path

**Decision:** Maintain one production deployment path (Docker + GHCR) and one local development path (docker compose / local dev). Do not support competing Azure/Railway/AWS narratives.

**Context:** SOW "Overdone: simplify these" table requires a single production deployment path.

**Rationale:** Reduces operational complexity and maintenance burden. Host selection pending (WP0 task 8).

**Owner:** Developer + Product owner  
**Date:** 15 September 2026  
**Status:** Approved in principle, host TBD

## D-003: Admin frontend

**Decision:** Use the existing React admin console as the maintained Stage 1 interface. Do not build a new admin frontend or port the static dashboard.

**Context:** SOW requires the React admin as part of Stage 1. Static admin retirement only after WP0 confirms replacement parity and usage.

**Rationale:** React admin is implemented and tested across 10 screens. Building a second frontend would duplicate effort.

**Owner:** Developer  
**Date:** 15 September 2026  
**Status:** Implemented

## D-004: AI scope

**Decision:** Keep AI assistance bounded to available course content with explicit fallback. AI failure must not stop deterministic lesson delivery.

**Context:** SOW requires AI to remain optional to deterministic delivery. CourseTutor implements a three-layer scope gate.

**Rationale:** Prevents unpredictable LLM behavior from affecting lesson delivery. Cost and abuse bounded by per-learner hourly limits.

**Owner:** Developer  
**Date:** 15 September 2026  
**Status:** Implemented

## D-005: Certificate semantics

**Decision:** Treat certificates as completion records only; no mastery or accreditation claims.

**Context:** SOW required safeguard. README confirms "A certificate records completion only, not mastery."

**Rationale:** Avoids legal/accreditation implications. Matches existing customer expectations.

**Owner:** Product owner + Developer  
**Date:** 15 September 2026  
**Status:** Implemented

## D-006: Opt-out hash

**Decision:** Use keyed HMAC-SHA-256 for opt-out phone hashes when OPTOUT_HASH_SECRET is configured; required in production.

**Context:** PHASE3_CLOSEOUT_REPORT upgraded opt-out hashing to HMAC. Losing/changing the secret silently re-enables messaging to opted-out numbers.

**Rationale:** Security requirement. Secret must be backed up; rotation needs dual-secret transition (not yet built — residual risk).

**Owner:** Developer  
**Date:** 15 September 2026  
**Status:** Implemented; dual-secret rotation is a residual risk

## D-007: Migration strategy

**Decision:** Append-only migrations with checksum verification. Never edit shipped migrations. Production startup migrations disabled by default; `npm run migrate` is the pre-deploy step.

**Context:** SOW requires migration safety. PHASE3_CLOSEOUT_REPORT and PHASE6_REPORT confirm this pattern.

**Rationale:** Prevents silent schema corruption. Enables safe repeat runs and isolated testing.

**Owner:** Developer  
**Date:** 15 September 2026  
**Status:** Implemented

## D-008: Unsupported features

**Decision:** Default unsupported features off; show only supported actions in production. Hide Telegram, learner web, Stripe, flow builder, template manager, analytics, demo auth from admin UI.

**Context:** SOW required safeguard. PHASE5_REPORT confirms removal of unsupported dashboard features.

**Rationale:** Prevents confusion and partial capability exposure. Aligns with "treated as disabled capabilities, not dashboard promises."

**Owner:** Developer  
**Date:** 15 September 2026  
**Status:** Implemented

## D-009: WhatsApp message fields

**Decision:** Exclude `whatsappLessonIntro` and `whatsappCompletionMessage` from Stage 1. Use fixed Twilio copy. Warn on import without logging authored values.

**Context:** PHASE4_STATUS records this decision. Ekatra uses fixed Twilio copy.

**Rationale:** Avoids scope creep on message customization. Import safety (no silent data loss).

**Owner:** Product owner + Developer  
**Date:** 15 September 2026  
**Status:** Implemented (import warnings)

## D-010: Quiz explanation mapping

**Decision:** Store quiz explanation as nullable TEXT (max 1000 chars) on the quiz item, not as a new lesson item. Preserve positions, idempotency, progress, retries, completion/certificate behavior.

**Context:** PHASE4_STATUS records this decision. Migration v5 implemented.

**Rationale:** Minimal schema change, no impact on delivery logic.

**Owner:** Developer  
**Date:** 15 September 2026  
**Status:** Implemented

## Pending decisions (require product owner input)

| Decision | Context | Needed by |
|---|---|---|
| Production hosting provider | Select one host; add host-specific deploy config | Week 1 (WP1) |
| Approved representative course | Course fixture for acceptance journey | WP0 task 6 |
| Pilot cohort | Test learners for acceptance demonstration | WP0 task 6 |
| Recovery targets | Confirm RPO ≤24h, RTO ≤4h or adjust | WP0 task 6 |
| Traffic baseline | Confirm 1,000 learners / 100 concurrent / 10 webhook/s | WP0 task 6 |
| Retention period | Confirm 90/365/30 day defaults or adjust | WP0 task 6 |
| Operational owner | Name the person responsible for alerts/backup/incident triage | Before release (SOW) |
| Provider templates | Confirm welcome + schedule templates approved | WP0 task 5 |
