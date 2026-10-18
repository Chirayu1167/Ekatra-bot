# Admin authorization policy (Phase 2)

## Principals

| Principal | How | Scope |
| --- | --- | --- |
| Bootstrap key (`ADMIN_API_KEY`) | Shared secret, constant-time compare | `platform_admin` (no org). Use it to create the first organisation and users, and to recover a lost org_admin key. |
| Per-user API key (`ek_live_…`) | 256-bit random, **SHA-256 hash stored only**, constant-time compare | The key owner's `role` + `org_id`. Shown once at creation/rotation; never stored or logged. |

Unknown, revoked or expired credentials → **401**. Cross-org access → **404** (never 403, so
existence is not revealed). Authenticated but insufficient role → **403**.

## Roles

- `platform_admin` — no org (or the bootstrap key). Creates orgs and users anywhere, acts on a
  named org explicitly via `?org=<slug>` (resolved server-side; unknown → 404), recovers lost keys.
- `org_admin` — full control inside their own org: courses, users/keys of that org, learner
  export/delete, own-org audit. A `?org=` naming another org is 404.
- `instructor` — manages courses/lessons/publish **in their own org**. Cannot manage users or
  keys, cannot export/delete learner data, cannot read the audit log. Instructors may read
  learner lists, learner detail/progress, and enrollment lists for their org; phone numbers are
  always masked. This includes every learner in the org because there is no per-course
  assignment. Adding that restriction would require a migration and is not implemented.
  Instructors cannot view or change schedules, deliveries, failures, certificates, users, keys,
  or audit records. The Status screen is not in instructor navigation; `/ready` and
  `/worker-status` remain public health endpoints and expose no learner or message content.

## Permission matrix

| Action | platform_admin | org_admin (own org) | instructor (own org) |
| --- | --- | --- | --- |
| Course/lesson CRUD, publish/unpublish | any org via `?org=` | yes | yes |
| Create/list organisations | yes | 403 | 403 |
| Create/list users, issue/rotate/revoke keys | any org | own org only | 403 |
| Recover a lost key (`POST /users/:id/recover`) | yes | 403 | 403 |
| Learner export / delete | any org (scoped) | own org (scoped) | 403 |
| Read audit log | all (`?org=` filters) | own org | 403 |
| Session (`GET /admin/session`) | yes | yes | yes |
| Learner list/detail (`GET /admin/learners`, `GET /admin/learners/:id`) | any org (scoped) | own org (scoped) | own org, read-only, masked phone |
| Enrollment list (`GET /admin/enrollments`) | any org (scoped) | own org (scoped) | own org, read-only, masked phone |
| Enrollment create/pause/resume | any org (scoped) | own org (scoped) | 403 |
| Course/enrollment/org schedules and schedule preview | any org (scoped) | own org (scoped) | 403 |
| Delivery list/detail (`GET /admin/delivery*`) | yes | own org (scoped) | 403 |
| Failures inspect/replay/discard | yes | own org (scoped) | 403 |
| Certificates list/resend (`GET/POST /admin/certificates*`) | yes | own org (scoped) | 403 |

## Credential hygiene

- Keys are `ek_live_` + 32 random bytes; DB holds `key_hash` + short `prefix` only.
- `last_used_at` updates on every authenticated call; `revoked_at`/`expires_at` reject.
- Certificate codes (HMAC path codes) and admin keys are different schemes on purpose:
  a cert code as Bearer → 401, an admin key as cert code → 404 (both covered by tests).
- Audit log records org/user/key changes, publish/unpublish, export, delete — with ids and
  slugs only, never key values.

## Provisioning & recovery

1. Start with `ADMIN_API_KEY` set → it is the bootstrap `platform_admin`.
2. `POST /admin/orgs {slug, name}` → create orgs.
3. `POST /admin/users {org, name, role}` → creates user + returns `apiKey` **once**.
4. Lost org_admin key: `POST /admin/users/:id/recover` as platform_admin (revokes all live
   keys first, audited as `key.recover`).
5. Rotate: `POST /admin/users/:id/keys` (revoke-all + issue, audited as `key.rotate`).

## Phase 4 additions (admin console backend)

Endpoints added in Phase 4 Step 1 where the policy was previously silent default to
`platform_admin` + `org_admin` (own org) with the following explicit read-only instructor
exception:

- `GET /admin/session` — any authenticated admin (returns principal info, no org data exposed)
- `GET /admin/learners`, `GET /admin/learners/:id`, `GET /admin/enrollments` — instructors may
  read their org's learners/progress and enrollments; all phone values are masked
- `POST /admin/enrollments`, enrollment pause/resume, learner export/delete — instructors get 403
- `GET /admin/delivery*`, `GET/POST /admin/certificates*`, `GET /admin/schedule-preview` —
  instructors get 403

Message text in delivery detail is restricted to `org_admin` and `platform_admin`;
`instructor` gets 403. No phone numbers appear in URLs; lists return masked phones
(last 4 digits only); full phone appears only in learner detail view for `org_admin` and
`platform_admin`. Instructors see the masked number in detail as well.
