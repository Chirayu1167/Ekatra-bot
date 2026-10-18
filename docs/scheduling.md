# Scheduling (Phase 3)

Per-enrollment schedules with an IANA timezone. `09:30` means `09:30` in the
**learner's** timezone, never UTC. Learners without a schedule (and everyone
via `NEXT`) stay self-paced — scheduling only adds sends, never removes manual
control.

## Data

- `organisations`: `default_timezone` (default `Asia/Kolkata`),
  `default_daily_time` (nullable `HH:MM`), `grace_hours` (default 6).
- `course_schedules`: one row per course (`daily` + `daily_time`, or `custom`
  `slots: [{dow 0–6 (Sun=0), time HH:MM}]`, plus `timezone`).
- `enrollment_schedules`: one row per enrollment (`timezone`, `daily_time`,
  `slots`, `enabled`, `last_slot_key`). Created lazily with defaults.
- Precedence: enrollment schedule wins over course schedule wins over org
  defaults. Within one schedule, custom slots replace daily (same wall time
  collapses to one slot — daily/custom overlap never double-sends).

## How "due" is computed (`evaluateDue`, pure — fixtures in `tests/scheduler.test.ts`)

1. Candidate slots from the last 2 days + today, evaluated with `Intl`
   wall-clock math in the enrollment timezone (DST-safe; a nonexistent wall
   time such as 02:30 on spring-forward day resolves deterministically).
2. A slot is due when it has passed, is still inside the grace window
   (`now - slot ≤ grace_hours`, default 6, configurable per org), and is newer
   than `last_slot_key` (the cursor only moves forward).
3. **At most ONE slot per enrollment per tick**: the newest due one.
4. Slots whose window fully passed are reported as `skip`: the tick advances
   `last_slot_key` past them **without sending** (documented grace policy).
5. Tick gates (re-checked again at SEND time): active enrollment, enabled
   schedule, published course, not opted out, lessons remaining. Paused,
   opted-out, completed, deleted and unpublished-course learners are never sent.

The tick claims the slot (`last_slot_key`, first writer wins), enqueues exactly
one `outbound_send` job (`dedupe = sched:<enrollment>:<slot>`, same slot = one
job across racing ticks/workers/restarts), and the worker renders the lesson
fresh at send time (content edits land) with all guards re-checked.

## Catch-up policy (after downtime)

- One missed lesson per enrollment per tick, never a burst.
- Missed windows older than grace are skipped silently (cursor advances).
- The next in-window slot resumes normal delivery; `NEXT` always works.

## Scheduler loop

One worker leads each tick via `pg_try_advisory_lock('ekatra_scheduler_tick')`;
others skip. Cadence `SCHEDULER_TICK_MS` (60s); disable with
`SCHEDULER_ENABLED=false`. Single-leader + idempotent enqueue + slot claim =
two schedulers/workers can never create duplicate jobs (tested).

## Admin API (org-scoped, audited as `schedule.set` / `schedule.delete`)

| Route | Roles |
| --- | --- |
| `PUT/GET/DELETE /admin/courses/:id/schedule` `{kind, dailyTime?, slots?, timezone?}` | any admin role (course config) |
| `PUT/GET /admin/enrollments/:id/schedule` `{timezone?, dailyTime?, slots?, enabled?}` | `platform_admin` + `org_admin` |
| `PUT/GET /admin/schedule-defaults` `{timezone?, dailyTime?, graceHours?}` | `platform_admin` + `org_admin` |

Invalid timezone / malformed `HH:MM` / bad `dow` → 400. Cross-org ids → 404.

## 24-hour WhatsApp window (A1)

WhatsApp only permits free-form (session) messages within 24 hours of the learner's last
inbound message. Outside that window, only an approved WhatsApp template may be sent.

- **Window open** (learner has an inbound event within the last 24h): the scheduled lesson
  is sent normally and progress advances.
- **Window closed + template configured** (`TWILIO_CONTENT_SID_SCHEDULE`): an approved
  quick-reply template whose button payload maps to `NEXT` is sent instead of the lesson.
  No progress is advanced. The job completes. The lesson is delivered when the learner
  replies or taps the template button.
- **Window closed + no template**: a visible, permanent failure with reason
  `template_required`; the message is dead-lettered. Never retried endlessly.

### One-pending-template cap

At most one template message may be pending per enrollment. If a template is already
queued/sending/sent/delivered/read for the enrollment, no new template is created until the
learner replies (which clears the pending state and delivers the lesson).

### Meta template approval requirement

The template referenced by `TWILIO_CONTENT_SID_SCHEDULE` must be a Meta-approved WhatsApp
template (Content SID starting with `HX`). Template creation and approval happen in the
Twilio Console / Meta Business Manager, not in this application. An unapproved or missing
template SID means closed-window scheduled lessons fail with `template_required`.
