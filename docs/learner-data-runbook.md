# Learner data runbook (Phase 2)

Who can do what: `org_admin` and `platform_admin` only (scoped to the caller's org;
`platform_admin` may name another org explicitly). `instructor` gets 403 on everything
below. Every action is audit-logged (`learner.export`, `learner.delete`).

## Opt-out (STOP / START)

- Learner sends `STOP` → one confirmation message, active courses in every org pause,
  progress kept. Afterwards the number gets **silence**: lessons, tutor answers,
  certificates, menus — nothing goes out (the only exception is the STOP confirmation
  itself). `START` opts back in (then `RESUME` continues).
- Enforcement is the central `OptOutGuardSender` wrapping the only sender
  (`src/services/optOutGuard.ts`): any send path that slips past the bot still throws
  instead of messaging. No new send path can bypass it.
- Opt-out is global per phone (one WhatsApp sender) and persistent: it survives restarts
  (Postgres table) and learner deletion (kept as a `phone_hash`, number erased).
- Hashing: `OPTOUT_HASH_SECRET` controls the hash. When set, new opt-outs store HMAC-SHA-256
  of `optout:<phone>` using the secret; checks match both HMAC and legacy plain SHA-256
  rows. When unset (dev/test default), plain SHA-256 is used.
- **Known limit:** a learner deleted before this change keeps a legacy plain SHA-256 hash
  until the number is next seen (e.g. another STOP/START), at which point the row is
  rewritten to HMAC. Rows for fully deleted learners (`anon:` user_id) keep their legacy
  hash permanently unless re-seen.
- **Secret loss:** losing or changing `OPTOUT_HASH_SECRET` silently re-enables messaging to
  opted-out numbers (their HMAC no longer matches). Back up the secret. Rotating requires a
  dual-secret transition (not built yet): accept both old and new HMACs during overlap.

## Export (one learner, JSON)

`GET /admin/learners/<whatsapp:+...>/export` → `{ learner, organisation, optOut,
enrollments[], certificates[], storedMessages[] }`. The bot stores no message contents,
so `storedMessages` is always empty (stated explicitly in the response). Unknown learner
→ 404. Use for access requests and pre-delete review.

## Delete (right to erasure)

`DELETE /admin/learners/<whatsapp:+...>` erases, in the caller's org only:

1. the learner's certificates, then enrollments (quiz answers cascade),
2. the raw phone number from the opt-out table — the **block stays as a hash**, so the
   number can never be messaged again,
3. the profile row, but only when no enrollments remain in any other org.

Response reports `{ enrollments, certificates, profileDeleted, optOutRetained }`.
Unknown learner → 404. This is irreversible; export first if a record is needed.

## Retention

| Data | Retention | Mechanism |
| --- | --- | --- |
| Webhook de-dup ids (`processed_messages`) | `PROCESSED_MESSAGE_RETENTION_DAYS` (default 30) | pruned at every startup + `npm run cleanup` |
| Audit log | `AUDIT_LOG_RETENTION_DAYS` (default 365) | `npm run cleanup` only (never at startup) |
| Data | Retention | Mechanism |
| --- | --- | --- |
| Webhook de-dup ids (`processed_messages`) | `PROCESSED_MESSAGE_RETENTION_DAYS` (default 30) | pruned at every startup + `npm run cleanup` |
| Audit log | `AUDIT_LOG_RETENTION_DAYS` (default 365) | `npm run cleanup` only (never at startup) |
| Opt-outs, enrollments, certificates, learner profiles | indefinite | never pruned; only explicit per-learner delete |
| Jobs (`jobs`) | `JOB_RETENTION_DAYS` (default 90) | `npm run cleanup`: completed/failed only, never in-flight |
| Send attempts (`outbound_attempts`) | `ATTEMPT_RETENTION_DAYS` (default 90) | `npm run cleanup`: older rows only |
| Inbound events (`inbound_events`) | `INBOUND_EVENT_RETENTION_DAYS` (default 90) | `npm run cleanup`: completed/failed only, never processing |
| Dead letters (`dead_letters`) | `DEAD_LETTER_RETENTION_DAYS` (default 90) | `npm run cleanup`: completed/discarded only, never open |

Runbook: `npm run cleanup` (or `npm run cleanup:prod` from `dist/`) after backups.
It prints `{ processedMessages, auditLog }` counts. Test on a scratch copy first
(see `tests/learner.data.test.ts` → retention case).
