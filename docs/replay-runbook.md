# Replay runbook (Phase 3)

Failures are visible first, actionable second. Nothing here sends to real
learners without an explicit operator action, and every action is audit-logged.

## Finding failures

`GET /admin/failures` (`platform_admin` + `org_admin`, org-scoped) returns
`{ failures, counts }` — open dead letters with reasons plus counts by
`reason_code`, ready for the later React admin. Filters: `?kind=inbound|outbound`,
`?status=open|replayed|discarded`, `?limit=`. Inbound rows carry no org, so they
are visible to `platform_admin` only. `GET /admin/failures/:id` inspects one
failure with its full attempt chain (Twilio sids, error codes) or raw event.

## Common reasons

| `reason_code` | Meaning | Action |
| --- | --- | --- |
| `21610` / `21614` | not opted in / unsubscribed | Do NOT replay to the same number; fix consent first |
| `21211` | invalid number | Fix the number, discard with a reason |
| `63015` / `63016` | template required (24h window) | Send via an approved template flow, then replay or discard |
| `retry_cap` | transient, 6 attempts failed | Safe to replay once the provider recovered |
| `unknown_outcome` | uncertain send (timeout/crash) | Reconcile FIRST (see below), then replay or discard |
| `chatbot_error` | inbound processing threw | Fix the bug, then replay the event |

## Uncertain sends (`unknown_outcome`)

The message may or may not have reached the learner. Never replay blindly:

1. Look up the Twilio MessageSid (attempt ledger, provider console).
2. If the provider confirms delivery, post (or wait for) the status callback —
   the worker auto-reconciles: pending progress runs once, dead letter resolves.
3. Only when proven NOT delivered: `POST /admin/failures/:id/replay`.

## Replay

`POST /admin/failures/:id/replay` (`{note?}`) creates a NEW attempt chain on
the same idempotent row (attempts reset, same idempotency key/message) and
marks the dead letter `replayed`. Replay-time guards (refused with 409, still
open, nothing sent):

- learner opted out → refused everywhere;
- scheduled lesson whose enrollment is not active, or whose course is not
  published → refused (pause/resume or republish, then replay);
- already `replayed`/`discarded` → refused.

## Discard

`POST /admin/failures/:id/discard` requires `{reason}` (400 without it), marks
`discarded` with the note. Audit actions: `failure.replay`, `failure.discard`
(actor + `failure:<id>`, visible in `GET /admin/audit`).

## Safety properties

- Replay/discard are org-scoped (cross-org ids are 404) and role-gated
  (`platform_admin` + `org_admin`; instructors get 403).
- Replay never bypasses opt-out, pause, or publish state — checks run at replay
  time AND again at send time.
- At-least-once reminder: a replayed send can theoretically duplicate a message
  the provider already delivered (see `docs/delivery-architecture.md`); progress
  itself stays exact (compare-and-set).
