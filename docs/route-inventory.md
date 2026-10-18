# Route inventory (Phases 2–5)

Single source of truth: `ROUTE_INVENTORY` in `src/app.ts`. `tests/ingress.test.ts` pins it —
adding a route without classifying it there breaks the build. A stack-walk count test proves
no route is mounted off-inventory.

No disabled/legacy routes exist in this release: there is no learner web UI beyond `/register`,
no OTP, no mock auth, nothing to gate. If such a route ever appears, it must either stay
unmounted or land in this list behind auth.

## Public (no credentials)

| Route | Protection | Notes |
| --- | --- | --- |
| `GET /health` | none (health) | Liveness only. Security headers set, no CORS. |
| `GET /ready` | none (health) | Readiness check used by the admin Status screen. |
| `GET /worker-status` | none (health) | Worker heartbeat status; no learner or message content. |
| `GET /register` | none (page) | Static HTML page; visual design frozen. |
| `GET /register/courses` | none (catalog) | Published courses of `?org=` (else `default`); unknown org → 404. |
| `POST /register` | rate-limited (20/hr/IP, 3/hr/phone, in-memory) | 8kb JSON body bound. Creates pending enrollment only; sends nothing. |
| `GET /certificates/:file` | capability URL (256-bit HMAC code) | Unguessable code IS the credential. Never accepts an admin key (format mismatch → 404). |
| `POST /webhooks/whatsapp` | Twilio signature (`X-Twilio-Signature` over exact public URL + raw form fields) | 32kb form bound. Missing/invalid → 403 with zero processing, zero DB change, zero sends. Durable accept only: stores the event idempotently, enqueues work, returns 200; the worker replies later. In `production`, boot refuses to start with validation off. |
| `POST /webhooks/whatsapp/status` | Twilio signature (same) | Delivery callbacks: signed, deduped by state, monotonic (no regression). Unknown sids/statuses acked without effect. |

## Admin (all behind `authenticateAdmin`: per-user key or bootstrap key; failures throttled per IP)

| Route | Roles |
| --- | --- |
| `GET/POST /admin/courses`, `GET/PATCH/DELETE /admin/courses/:id`, `POST …/publish`, `POST …/unpublish`, lesson add/replace/delete | any role, tenant-scoped; cross-org → 404 |
| `GET/POST /admin/orgs` | `platform_admin` only |
| `GET/POST /admin/users`, `POST /users/:id/keys`, `DELETE /users/:id/keys/:keyId` | `platform_admin` + `org_admin` (org_admin pinned to own org) |
| `POST /admin/users/:id/recover` | `platform_admin` only |
| `GET /admin/audit` | `platform_admin` (all / `?org=`) + `org_admin` (own org) |
| `GET /admin/learners/:phone/export`, `DELETE /admin/learners/:phone` | `platform_admin` + `org_admin`, scoped (Task 5) |
| `GET/PUT/DELETE /admin/courses/:id/schedule` | `platform_admin` + `org_admin`, tenant-scoped |
| `GET/PUT /admin/enrollments/:id/schedule`, `GET/PUT /admin/schedule-defaults` | `platform_admin` + `org_admin`, tenant-scoped, audited |
| `GET /admin/failures` (list + counts by reason), `GET /admin/failures/:id` (inspect + attempts), `POST …/replay`, `POST …/discard` (needs reason) | `platform_admin` + `org_admin`, tenant-scoped (inbound rows: platform only), audited |
| `GET /admin/session` | any authenticated admin |
| `GET /admin/learners` (list: opaque id, masked phone, course, progress, status, optedOut; filters: courseId, status, optedOut, search) | all three roles, tenant-scoped; instructors are read-only |
| `GET /admin/learners/:id` (detail: enrollments; full phone only for `org_admin`/`platform_admin`, masked for instructor) | all three roles, tenant-scoped; instructors are read-only |
| `GET /admin/enrollments` (list with filters: courseId, status; masked phone) | all three roles, tenant-scoped; instructors are read-only |
| `POST /admin/enrollments` (body: { phone, courseId, consent: true }, creates pending enrollment, consent audit-logged) | `platform_admin` + `org_admin`, tenant-scoped, audited |
| `POST /admin/enrollments/:id/pause`, `POST /admin/enrollments/:id/resume` | `platform_admin` + `org_admin`, tenant-scoped, audited |
| `GET /admin/delivery` (list outbound messages: status, kind, provider message id, attempts, timestamps, learner opaque id; no message bodies) | `platform_admin` + `org_admin`, tenant-scoped, audited |
| `GET /admin/delivery/:id` (detail with attempt chain; message text only for org_admin and platform_admin) | `platform_admin` + `org_admin`, tenant-scoped, audited |
| `GET /admin/certificates` (completion records list) | `platform_admin` + `org_admin`, tenant-scoped, audited |
| `POST /admin/certificates/:id/resend` (re-send through outbound pipeline, OptOutGuardSender applies) | `platform_admin` + `org_admin`, tenant-scoped, audited |
| `GET /admin/schedule-preview?enrollmentId=<id>&count=5` (next N send times) | `platform_admin` + `org_admin`, tenant-scoped, audited |

401 = missing/invalid/revoked/expired credential. 403 = valid credential, insufficient role.
429 = auth-failure budget spent (`RATE_LIMIT_AUTH_FAILURES_PER_HOUR`, default 100/IP/hour).

Instructor learner read access covers every learner in the instructor's org; there is no
per-course assignment. Introducing that restriction would require a migration. Instructors
remain forbidden from enrollment create/pause/resume, all schedule routes (including course
schedules), delivery, certificates, failures, users/keys/audit, and learner export/delete.

## Static

| Route | Notes |
| --- | --- |
| `GET /media/*` | Public BY DESIGN (Twilio fetches attachments). `express.static` with `index: false`, `dotfiles: ignore`: no directory listing; `..` traversal returns 404 (tested). Never place secrets here (see `.env.example`). |
| `GET /console/*` | Admin UI bundle and GET-only SPA fallback. `/console` CSP is `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`; HTML uses `no-store`, hashed assets use immutable caching. No unsafe-inline exception. |

## Hardening applied to every response

`nosniff` + `DENY` framing + `no-referrer` (no CSP — it would break the registration page's
inline script). CORS off by default; allow-list via `CORS_ORIGINS`. Bodies bounded
(8kb register, 32kb webhook, 256kb admin).

## Logging

Phones masked to last 4 (`***3210`); message bodies never logged; no `Authorization` headers,
API keys, or Twilio tokens in logs (see `maskPhone` in `src/logger.ts`).
