# Delivery architecture (Phase 3)

At-least-once delivery with idempotent progress. **Exactly-once delivery to
WhatsApp is never promised** (see "Residual duplicate risk" below).

## Flow

```text
Twilio POST /webhooks/whatsapp (signed)
  │ 1. validate → 2. INSERT inbound_events (ON CONFLICT DO NOTHING on MessageSid)
  │ 3. enqueue jobs(inbound_process, dedupe=MessageSid) → 4. return 200 <Response/>
  ▼
Worker loop (npm run worker, poll WORKER_POLL_MS):
  claim job (SELECT … FOR UPDATE SKIP LOCKED) + per-learner advisory lock
  ├─ inbound_process: CourseBot.handleMessage → create outbound_messages
  │   (idempotency_key inbound:<MessageSid>) → enqueue outbound_send →
  │   SEND INLINE under the same lock → record attempt → on confirmed send,
  │   execute DeliveryAction (begin/advance, compare-and-set, idempotent)
  └─ outbound_send (retry / scheduled / replay): load row → send or skip
Twilio POST /webhooks/whatsapp/status (signed): reconcile by MessageSid
```

The API process never sends and never runs the bot. The worker owns sending,
guarded centrally by `OptOutGuardSender`. No transaction or row lock is ever
held across a Twilio or LLM call; the per-learner advisory lock blocks only
same-learner processing, never queries.

## Tables

| Table | Key | Purpose |
| --- | --- | --- |
| `inbound_events` | `message_sid` UNIQUE | Raw accepted events; `received/processing/completed/failed` + `visible_at` |
| `jobs` | `(kind, dedupe_key)` UNIQUE | Durable queue; `queued/processing/completed/failed` + `run_at` (backoff) + `visible_at` (reclaim) |
| `outbound_messages` | `idempotency_key` UNIQUE | One row per logical send; monotonic status (see below) |
| `outbound_attempts` | append-only | Every attempt: Twilio sid, outcome, error code |
| `dead_letters` | — | Terminal failures (`open/replayed/discarded`) with reason + send context |
| `worker_heartbeat` | `worker_id` | Worker liveness (`/health` stays on the API) |

## Job lifecycle / state machine

`queued (run_at ≤ now)` → `processing (locked_by, visible_at = now + visibility)`
→ `completed` · `queued(run_at = now + backoff)` (retry) · `failed` (cap/poison →
dead letter). `processing` with `visible_at < now` is reclaimed (crash recovery).
`(kind, dedupe_key)` makes enqueue idempotent: same work = one row, even with
racing workers/ticks. Inbound handler sends inline under the learner lock, so a
read (bot) and its write (progress) are atomic per learner; a reclaimed job that
finds its message already `sent` only finishes the idempotent action — exactly
one logical progress update.

## Outbound status (monotonic, never regresses)

`queued → sending → sent → delivered → read`, plus `failed` (retryable),
`unknown` (uncertain — parked, never auto-resent), `dead_letter` (terminal).
Status callbacks move forward only (`delivered` can never go back to `sent`).

## Retry table (see `src/services/retry.ts`)

Base 30s, doubling, cap 1h, ±20% jitter, max 6 attempts: ~30s, ~1m, ~2m, ~4m,
~8m, ~16m. Transient (network, 429, 5xx, unknown codes) → retry. Permanent →
dead letter immediately, no retry:

| Permanent | Codes / hints |
| --- | --- |
| invalid number | `21211` |
| unsubscribed / not opted in | `21610`, `21614` |
| 24h-window template required | `63015`, `63016`, `63018` (business sends outside 24h must use an approved template; rejection is a visible failure, never retried endlessly) |
| blocked | `63007` |
| opted out | `opted_out_suppressed` (central guard) |

### Scheduled lessons outside the 24-hour window (A1)

A scheduled lesson checks the learner's last inbound time from `inbound_events`:

- **Window open** (inbound within 24h): the lesson is sent normally and progress advances.
- **Window closed + `TWILIO_CONTENT_SID_SCHEDULE` configured**: an approved Meta
  quick-reply template is sent instead of the lesson. No progress advance. The job
  completes. The lesson is delivered when the learner replies or taps the template
  button (payload maps to `NEXT`).
- **Window closed + no template**: permanent failure with reason `template_required`;
  the message is dead-lettered and never retried endlessly.

**One-pending-template cap:** at most one template message may be pending per enrollment
(status `queued`/`sending`/`sent`/`delivered`/`read`). No new template is created until the
learner replies.

**Meta template approval:** the template referenced by `TWILIO_CONTENT_SID_SCHEDULE` must be
a Meta-approved WhatsApp template (Content SID starting with `HX`). Approval happens in the
Twilio Console / Meta Business Manager; this application only references the configured SID.

Timeouts after the request left are `unknown`: parked + dead-lettered as
`unknown_outcome`, reconciled via status callback or Twilio lookup — retried
only when proven not delivered.

## Progress rule

Progress (`begin`/`advance` + certificate issue) commits ONLY after a confirmed
send, via the serializable `DeliveryAction` carried in the job payload (the
in-process `onDelivered` closure cannot survive a crash). Every branch is
idempotent, so replays/reclaims can never skip or double-advance a lesson.
A failed send is never recorded as success.

## Quiz answer feedback

Quiz items may store one optional `explanation` (trimmed, at most 1000 characters;
existing and imported items may remain NULL). After a valid answer, the bot appends
that text to the existing correct/incorrect feedback response and sends it through
the same outbound job, retry, and idempotency pipeline. It does not create a lesson
item or a second message. With NULL or blank explanation, the response is unchanged.
Recording the quiz answer does not change lesson positions or delivery progress.

## Residual duplicate risk

If the process dies after Twilio accepted a send but before we recorded it, the
reclaimed job parks the message as `unknown` instead of resending blindly —
but the learner may still receive that message twice if Twilio delivers the
first attempt after we later reconcile-and-retry. Mitigations: single-flight
per learner lock, attempt ledger, reconcile-before-retry, user-visible lesson
content (a repeated lesson is confusion, not corruption — progress is exact).

## Settings

`WORKER_POLL_MS` (2000), `WORKER_VISIBILITY_SECS` (300),
`WORKER_MAX_JOBS_PER_TICK` (50), `SCHEDULER_ENABLED`, `SCHEDULER_TICK_MS`,
`SCHEDULER_GRACE_HOURS` (fallback 6). See `.env.example`.
