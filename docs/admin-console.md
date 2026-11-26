# Admin Console (`/console`)

The client-only React SPA in `admin-ui/` is served by the API from `admin-ui/dist` under
`/console`. It uses the typed API client in `admin-ui/src/api/` and existing `/admin` endpoints.
There is no Supabase, TanStack Start, server-function, Lovable, or alternate-provider code.

## Screens

- **Courses:** search and draft/published list; create/edit; lessons with supported text, media,
  link, and quiz items; audio accepts a public MP3 URL or an MP3 upload up to 16 MB; optional quiz
  explanation up to 1000 characters; publish/unpublish/delete
  with confirmation and server validation/safeguard errors. Existing lesson IDs are retained on
  edits. Fields without a backend mapping are hidden.
- **Learners:** paginated filters/search, opaque-ID detail, progress and enrollment status.
  Numbers are masked by default; `org_admin` and `platform_admin` can explicitly reveal them.
  Enrollment requires the consent checkbox; pause/resume errors are shown clearly. Instructors
  have read-only learner and enrollment access with masked numbers and no actions.
- **Schedules:** course and enrollment schedules, organisation defaults, daily/custom times, IANA
  timezone selection, and `/admin/schedule-preview` results. Operational schedule controls are
  admin-only; instructors cannot configure or read schedules. Enrollment selectors mask numbers.
- **Delivery:** paginated outbound-message list with status filter and detail/attempt history.
  Lists contain no inbound text or phone numbers. Message text is shown only in admin-only detail;
  there is no staff reply box.
- **Course broadcast:** org admins can select a published course, enter numbers manually or import
  an `.xlsx` first-column list (up to 100), then preview eligibility and rejection counts before
  explicitly queueing. Numbers are only selection input: every recipient must match an active
  enrollment with recorded course consent in that organisation. Paused/completed, opted-out,
  unmatched, duplicate, and invalid numbers are excluded. Free-form text is sent only within the
  24-hour WhatsApp customer-service window; outside it, the approved `TWILIO_CONTENT_SID_BROADCAST`
  template is required, with no free-form fallback. Queueing and worker-time checks use the durable
  outbound pipeline. Delivery receipts are not learning metrics.
- **Failures:** open failures and reason counts, inspection of attempt summaries, replay one or
  multiple selected failures, and discard with a required reason. Replay and cooldown conflicts
  are shown in plain language.
- **Certificates:** completion records and resend through the existing outbound pipeline; cooldown
  conflicts are surfaced.
- **Users and API keys:** list users and sanitized key metadata, create users, rotate or revoke
  keys. Plaintext keys appear once in a memory-only dialog with a copy action and are cleared when
  the dialog closes. The adjacent Audit log is read-only.
- **Status:** readiness and worker heartbeat age/status refresh every 15 seconds. This replaces the
  unsupported provider-integration page; it does not configure a messaging provider. The screen is
  admin-only; `/ready` and `/worker-status` themselves remain public health endpoints.

Instructors see only Courses and read-only Learners navigation. `org_admin` and `platform_admin`
see every implemented screen, including course broadcasts. The server enforces authorization;
hidden navigation is not a security boundary.

The dashboard reports active enrollments, recorded completions, and open delivery failures; it
does not infer learning from sent/delivered/read message counts. Broadcast support is implemented
in code, but still requires staging/provider acceptance before production use.

## Excluded dashboard features and course fields

No routes, navigation items, or UI remain for Telegram, the learner web app, Stripe, AI tutor UI,
flow builder, provider integration management, analytics/statistics, or demo auth. Delivery text
is read-only. See `docs/course-model-mapping.md` for excluded/unmatched course fields:
`whatsappLessonIntro`, `whatsappCompletionMessage`, price, category, Stripe fields, and any field
without a backend equivalent. The SQLite importer warns by field and non-empty row count for every
unsupported source course column, without logging values. No reference dashboard files or
environment values were copied; no files under `reference/microlearn-main` were edited.

## Authentication and tenant scope

Sign-in validates the API key with `GET /admin/session`. The key stays in memory unless “Keep me
signed in on this tab” is checked, in which case it is stored only in that tab's `sessionStorage`.
It is never written to `localStorage`, URLs, or logs. Platform-admin organisation scope is
selected by the authenticated UI and sent as `?org=`; the server remains authoritative for role
and tenant access. API responses are never logged. Phone numbers do not appear in URLs or list
views.

## Serving and Content Security Policy

The API serves files from `admin-ui/dist` under `/console`, and uses an SPA fallback only for
unmatched GET requests under `/console`. HTML is `no-store`; hashed assets are immutable for a
year. The console-only CSP is:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

There is no inline-style exception. `tests/ingress.test.ts` covers static serving, SPA fallback,
caching, CSP, and route isolation. Browser/Playwright CSP validation has not been performed.

## Development

For the full local API + worker + console stack without Twilio:

```sh
npm run dev:local
```

It starts disposable embedded PostgreSQL, applies migrations, creates a demo org/course and
one-time admin key, and starts the API, fake-sender worker, and Vite. The key is printed once to
the terminal. Ctrl+C stops the child processes and removes the temporary database. The local
smoke check verified `/console/`, `/console/dashboard`, `/ready`, and `/worker-status` return 200.
If embedded PostgreSQL cannot run on Windows, use a disposable local `DATABASE_URL` with the
standard API and Vite commands; never use production data.

For UI-only work, run `npm run dev` inside `admin-ui/`; Vite uses `/console/` as its base and
proxies `/admin`, `/ready`, and `/worker-status` to the API at port 3000. Build from the root with
`npm run build`, or in `admin-ui/` with `npm run build`. The root build includes the production
console bundle in `admin-ui/dist`.

Course MP3 uploads are stored in `MEDIA_DIR` and publicly served from `/media` so Twilio can
retrieve them. Configure `PUBLIC_BASE_URL` to the public HTTPS origin before using uploads.
