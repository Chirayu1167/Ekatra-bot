# Ekatra WhatsApp Chatbot (MVP)

A small TypeScript/Express service that receives WhatsApp messages through Twilio and replies.
It started as the messaging foundation for Ekatra and now also **delivers courses**: an admin
manages courses over a small API, and learners take them lesson by lesson on WhatsApp, with
progress saved in PostgreSQL. See [Course delivery](#course-delivery) below and
[docs/course-mvp.md](docs/course-mvp.md) for the design, limits and remaining work.


```text
User → WhatsApp → Twilio → POST /webhooks/whatsapp
                              │  1. validate Twilio signature
                              │  2. store event (idempotent on MessageSid) + enqueue
                              │  3. return 200 immediately
                              ▼
Worker (npm run worker) → chatbot.handleMessage() → outbound pipeline
                              → WhatsApp service → Twilio REST API
                              ▼
                       User receives reply (at-least-once; progress commits
                       only after a confirmed send — see docs/delivery-architecture.md)
```

## Learner journey (web registration → certificate)

1. **Register on the web** at `/register`: name, WhatsApp number, course, and a consent tick-box.
   This creates a *pending* enrollment (only published courses can be chosen).
2. **We message them on WhatsApp** straight away (`TWILIO_CONTENT_SID_WELCOME` template, or plain
   text inside the 24 h window). If WhatsApp refuses, the page says so instead of claiming success,
   and a later "hi" from the learner shows the Start Course prompt.
3. **Start Course** (button, or type `START COURSE`) delivers lesson 1.
4. **Next / Pause / Resume** buttons (or typed `NEXT`, `PAUSE`, `RESUME`) control the course. `STOP`
   opts out and suppresses every further send; `START` opts back in.
5. **Finishing the last lesson** records completion and sends a certificate PDF (or a printable page
   when the name isn't Latin-script). Exactly one record per enrollment; `CERTIFICATE` re-sends it.
   A certificate records completion only, not mastery.
6. **Questions**: any free-text message from a learner with an active/paused course goes to the
   course tutor.
7. **Course-only answers**, enforced in three layers (`src/services/courseTutor.ts`): a lexical
   gate (off-topic questions never reach the model), a prompt limited to the learner's *delivered*
   lessons that must answer `OUT_OF_SCOPE` otherwise, and a fixed refusal for that reply. Quiz
   items and answers are never given to the model. 20 questions/learner/hour by default.
8. Quizzes: author a quiz item with `"correct": true` on exactly one option to have it scored.
   A quiz with no marked answer is acknowledged but never graded.

WhatsApp only lets a business start a conversation with an **approved template** (outside the 24 h
window). Run `npm run buttons:setup` once; it creates `ekatra_welcome` and submits it for approval.
Until it is approved, test with the Twilio sandbox: the learner first sends `join <your-code>`.

Tests: `npm test` drives this whole journey through the real HTTP endpoints with a fake sender and
fake LLM (`tests/journey.test.ts`).

## Quick start

Requires Node.js 24.16.0 (see `.nvmrc`) and PostgreSQL 18. The fastest local setup is
`docker compose up -d postgres` (named volume `ekatra-pgdata`), which the app reaches at
`DATABASE_URL=postgres://ekatra:ekatra-dev-only@postgres:5432/ekatra`.

```bash
npm install
cp .env.example .env     # then fill in your Twilio values, ADMIN_API_KEY and DATABASE_URL (see below)
npm run seed             # optional: sample courses incl. `demo-1`, `demo-2` (set PUBLIC_BASE_URL first for image/PDF)
npm run dev
```

For a reproducible clean install, run `npm ci` and `npm ci --prefix admin-ui`; both dependency
sets are required because the root build includes the console. `npm run ci:all` runs typecheck,
lint, tests, and build for the API and admin UI. The combined scripts fail early with the exact
admin UI install command if its local build/test tools are missing.

Tests need no Docker: they start an embedded PostgreSQL 18 automatically
(`tests/pg.global-setup.ts`) and give every test file an isolated database. In CI they use
the `postgres:18` service container instead (`EKATRA_TEST_DATABASE_URL`).

### Local console preview without Twilio

For a disposable local stack with embedded PostgreSQL, migrations, a demo organisation/course,
a one-time demo `org_admin` API key, API, worker using a fake sender, and Vite console:

```bash
npm run dev:local
```

The command prints the API key once to the terminal; copy it for the sign-in form and do not
paste it into a URL or save it in a file. The worker creates synthetic delivery IDs and never
contacts Twilio or sends messages. Open the printed console URL, sign in, and press Ctrl+C to
stop all child processes and remove the temporary database. This does not touch `.env` or any
existing database. On Windows, if embedded PostgreSQL cannot start in the local environment,
use a disposable PostgreSQL database and the standard `npm run dev`/`admin-ui` dev-server setup
with `DATABASE_URL` configured; do not point local experiments at production data. The local
Vite proxy serves the API-backed `/admin` routes and the readiness/worker-status checks. The
console key remains in memory unless the sign-in checkbox explicitly opts into tab-scoped
`sessionStorage`; it is never stored in `localStorage`.

Check it is up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

## How to run (local development)

Every time you develop, do these 3 steps in order:

### 1. Start the app server

```bash
npm run dev
```

Leave it running. Confirm it is up with `curl http://localhost:3000/health`.

### 2. Start the Cloudflare tunnel

In a **second terminal** (keep the app running), expose your local server over HTTPS:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public URL like `https://<something>.trycloudflare.com`.
Keep this terminal open — closing it kills the URL.

Then set that URL in `.env` (no trailing slash) and **restart the app** so
signature validation uses the exact public URL:

```text
PUBLIC_BASE_URL=https://<something>.trycloudflare.com
```

> The free Cloudflare URL changes every time you restart `cloudflared`,
> so you must repeat step 3 each time it changes.

### 3. Update the webhook on your Twilio number

1. Open the [Twilio Console](https://www.twilio.com/console) → Messaging →
   Senders → WhatsApp senders → open your number → **Edit sender**
   (for the sandbox: Messaging → Try it out → Send a WhatsApp message).
2. Find **"When a message comes in"**, set the method to **`POST`**.
3. Set the URL to your current tunnel URL plus the webhook path:

   ```text
   https://<something>.trycloudflare.com/webhooks/whatsapp
   ```

4. Save.
5. From your phone, send `hello` to the Twilio WhatsApp number — you should get
   the bot's reply, and see `whatsapp.message.received` /
   `whatsapp.message.replied` in the app logs.

If replies stop after restarting `cloudflared`, the tunnel URL changed —
copy the new URL into both `.env` (`PUBLIC_BASE_URL`, then restart the app)
and the Twilio sender webhook.

## Environment variables

| Variable                                          | Required | Description                                                                                       |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `PORT`                                            | no       | HTTP port. Default `3000`.                                                                        |
| `NODE_ENV`                                        | no       | `development` (default), `test`, or `production`. Production refuses to start with signature validation off. |
| `TWILIO_ACCOUNT_SID`                              | yes      | Twilio Account SID (starts with `AC`).                                                            |
| `TWILIO_AUTH_TOKEN`                               | yes      | Twilio Auth Token. Used to send messages **and** to verify webhook signatures. Keep it secret.    |
| `TWILIO_WHATSAPP_FROM`                            | yes      | Your WhatsApp sender, with prefix, e.g. `whatsapp:+14155238886` (the Twilio sandbox number).      |
| `TWILIO_WEBHOOK_VALIDATE`                         | no       | `true` (default) or `false`. See [Webhook signature validation](#webhook-signature-validation).   |
| `PUBLIC_BASE_URL`                                 | yes (prod) | Public base URL Twilio calls, e.g. `https://abc.ngrok-free.app` (no trailing slash). Required for signature validation. |
| `DATABASE_URL`                                    | yes      | PostgreSQL connection URL, e.g. `postgres://ekatra:secret@db-host:5432/ekatra`. Tests provision their own databases. |
| `DATABASE_POOL_MAX`                               | no       | App pool size. Default `10`.                                                                      |
| `DATABASE_SSL`                                    | no       | `off` (default) or `require`. Staging/production hosted databases must use `require`.             |
| `DATABASE_STATEMENT_TIMEOUT_MS` / `DATABASE_IDLE_TIMEOUT_MS` | no | Query watchdog (default `10000`) and idle-client reaping (default `30000`), in ms.  |
| `ADMIN_API_KEY`                                   | yes (prod) | Bootstrap `platform_admin` key for `/admin` (min 16 chars). Unset = admin API off (404) unless users exist. Create orgs/users with it, then use per-user keys. See `docs/authz-policy.md`. |
| `MEDIA_DIR`                                       | no       | Folder served publicly at `/media`. Default `./media`.                                            |
| `CORS_ORIGINS`                                    | no       | Comma-separated browser origins. Unset (default) = no CORS headers.                               |
| `RATE_LIMIT_AUTH_FAILURES_PER_HOUR`               | no       | Failed admin/webhook auth attempts per IP/hour before 429. Default `100`.                         |
| `PROCESSED_MESSAGE_RETENTION_DAYS`                | no       | Webhook de-dup id retention. Default `30`. Opt-outs/completions never pruned.                     |
| `AUDIT_LOG_RETENTION_DAYS`                        | no       | Audit-log retention, pruned by `npm run cleanup` only. Default `365`.                             |
| `TWILIO_CONTENT_SID_MAIN_MENU` / `_NAV` / `_RESUME` / `_COURSES` / `_CMDS_1` / `_CMDS_2` | no | Tap-button templates from `npm run buttons:setup` (see below). Empty = typed commands only. |

Configuration is validated with Zod at startup. If anything required is missing or malformed, the
process prints a clear message (variable names only, never values) and exits with code 1.

`.env` is git-ignored. Never commit real credentials.

## Twilio Setup

1. **Create/access a Twilio account** at <https://www.twilio.com/console>.
2. **Copy your Account SID** from the Console dashboard → `TWILIO_ACCOUNT_SID`.
3. **Copy your Auth Token** from the same dashboard (click to reveal) → `TWILIO_AUTH_TOKEN`.
4. **Configure a WhatsApp sender.** For development use the **WhatsApp Sandbox**
   (Console → Messaging → Try it out → Send a WhatsApp message). The sandbox shows its number
   (usually `+1 415 523 8886`) and a join phrase like `join <two-words>`. From your own WhatsApp,
   send that phrase to the sandbox number to opt in. Set `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`
   (use the number shown in your console).
5. **Configure the incoming-message webhook.** In the sandbox settings, find
   **"When a message comes in"**.
6. **Set the method to `POST`.**
7. **Set the URL to:**

   ```text
   https://YOUR-DOMAIN/webhooks/whatsapp
   ```

   For local development, `YOUR-DOMAIN` is your tunnel (see below), e.g.
   `https://YOUR-TUNNEL.ngrok-free.app/webhooks/whatsapp`. Save the settings.

8. **Start the application** (`npm run dev`).
9. **Send a WhatsApp message** (e.g. `hello`) to the sandbox number.
10. **Verify the response.** You should receive the welcome message and see
    `whatsapp.message.received` and `whatsapp.message.replied` in the server logs.

### Exposing your local server with ngrok

Twilio must be able to reach your machine over HTTPS:

```bash
ngrok http 3000
```

ngrok prints a forwarding URL such as `https://YOUR-TUNNEL.ngrok-free.app`. Use it in two places:

- Twilio webhook: `https://YOUR-TUNNEL.ngrok-free.app/webhooks/whatsapp` (method `POST`)
- `.env`: `PUBLIC_BASE_URL=https://YOUR-TUNNEL.ngrok-free.app` (restart the app after changing it)

Free ngrok URLs change each time ngrok restarts, so update both when that happens.

## Webhook signature validation

Twilio signs every webhook with the `X-Twilio-Signature` header. This app verifies it using
Twilio's official helper (`twilio.validateRequest`) — no custom algorithm.

| `TWILIO_WEBHOOK_VALIDATE` | Behaviour                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `true` (default)          | Missing/invalid signature → **403**. The chatbot is **not** executed and nothing is sent.                                    |
| `false`                   | Signature is not checked. For local experiments (e.g. `curl`) only. A warning is logged at startup. **Never in production.** |

The signature covers the exact public URL plus the POST parameters. If validation fails even
though your setup looks right, the most common cause is a URL mismatch (the URL Twilio called differs
from the one the app reconstructs). Set `PUBLIC_BASE_URL` to the exact base URL configured in Twilio;
the failing log line (`twilio.signature.invalid`) includes `urlUsedForValidation` to help you compare.
Also note that the Twilio console URL (`http` vs `https`, trailing slash, query string) must match what
Twilio is actually configured to call.

## Bot behaviour

The original replies are unchanged; course commands sit in front of them.

| User sends                                                      | Bot replies with                                    |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `hello`, `hi`, `hey`, bare `start`                              | Welcome + menu (+ course commands)                  |
| `1`, `COURSES`                                                  | List of published courses                           |
| `START <number \| slug \| title>`                               | Enrol and receive an intro + lesson 1               |
| `NEXT`                                                          | The next lesson                                     |
| `PAUSE` / `RESUME`                                              | Pause / continue the current course                 |
| `PROGRESS`                                                      | Lessons delivered per course, and what to send next |
| `STOP` (also `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `STOPALL`) | Unsubscribes: pauses the course, keeps progress     |
| `START` (also `UNSTOP`, `SUBSCRIBE`) after STOP                 | Subscribes again (then `RESUME`)                    |
| `2`, `help`, anything else                                      | Help / fallback (+ course commands)                 |

Matching ignores case, surrounding whitespace and trailing punctuation (`Next!` works).

**Opt-out.** A learner who sends `STOP` is unsubscribed: their active course is paused (progress
kept), they get one confirmation, and every later message gets only "send START to opt back
in" until they do. Only the _whole message_ counts, so "stop the lesson" is not an opt-out.
Anything that sends to learners (including future reminders) must check `OptOutService`.

### Tap buttons (optional)

Instead of typing, learners can tap **Next / Pause** under each lesson, **Courses** after the
last one, **Resume** after a pause, and command buttons (**Courses / Next / Pause**, **Resume /
Progress / Courses**) on lists, progress and help. Buttons are Twilio _quick-reply_ Content Templates.

```bash
npm run buttons:setup     # creates the templates (idempotent), prints the .env lines
```

Paste the printed `TWILIO_CONTENT_SID_*` lines into `.env` and restart. A tap arrives as a normal
message (`ButtonPayload` = `NEXT`, `PAUSE`, `RESUME` or `COURSES`), so it behaves exactly like
typing. Typed commands always keep working, each button set can be enabled independently, and if
a button message fails to send the learner gets plain text with the typed command instead.
Limits (Twilio): in-session quick-reply messages allow at most 3 buttons; button messages are
separate from media; the button text is kept to one line. **Not yet verified against real
Twilio** (see docs/course-mvp.md).

## Course delivery

### Content model

A **course** has a title, description, slug, `draft`/`published` status and ordered **lessons**.
A lesson has a title and 1–6 ordered **items**:

| `kind`                             | Fields                               | Sent as                             |
| ---------------------------------- | ------------------------------------ | ----------------------------------- |
| `text`                             | `text` (≤ 1200 chars)                | text message                        |
| `link`                             | `url` (http/https), `label?`         | text message                        |
| `image` `document` `video` `audio` | `url` (public **https**), `caption?` | optional caption message, then file |

Media rules come from Twilio's WhatsApp docs: one media file per message; captions are not
reliable, so the file is always sent on its own; Twilio fetches the URL and rejects it if the
`Content-Type` header does not match the file; images ≤ 5 MB, other files ≤ 16 MB (the docs
quote 16–20 MB, we use the lower figure). Accepted extensions: images `jpg jpeg png`; documents
`pdf doc docx xls xlsx ppt pptx csv`; video `mp4`; audio `mp3 ogg amr 3gp` (ogg must be Opus).

### Hosting attachments

Put files in `./media` and reference them as `${PUBLIC_BASE_URL}/media/<file>` (served publicly,
read-only), or use any public https URL. There is no upload endpoint yet.

### Admin API

Every call needs `Authorization: Bearer <key>` — either the bootstrap `ADMIN_API_KEY`
(`platform_admin`) or a per-user key. Courses belong to one organisation; cross-org reads
return 404. Public registration can scope to an org: `/register?org=<slug>` (plain
`/register` uses the `default` org).

Phase 2 docs: `docs/authz-policy.md` (roles + permission matrix + provisioning),
`docs/route-inventory.md` (every route and its protection), `docs/learner-data-runbook.md`
(opt-out, export, delete, retention).
Phase 3 docs: `docs/delivery-architecture.md` (jobs, states, retry table, uncertain sends),
`docs/scheduling.md` (timezones, due computation, catch-up policy),
`docs/replay-runbook.md` (failures, reconcile, replay, discard).

### Scheduled lessons

Set a daily time or custom days/times per course or enrollment (with an IANA
timezone, default from the org) via the admin schedule API; the worker's
scheduler tick sends the next undelivered lesson when due. Catch-up after
downtime sends at most one missed lesson per enrollment per tick and skips
windows older than the grace period (default 6 h). `NEXT` keeps working for
everyone. Failures land in `GET /admin/failures` with reasons and can be
replayed or discarded (audited).

| Method & path                                  | Purpose                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| `GET /admin/courses[?status=draft\|published]` | List courses                                            |
| `POST /admin/courses`                          | Create a draft (optionally with `lessons`)              |
| `GET /admin/courses/:id`                       | View a course with lessons and items                    |
| `PATCH /admin/courses/:id`                     | Edit title / description                                |
| `POST /admin/courses/:id/publish`              | Publish (needs ≥ 1 lesson). `/unpublish` hides it again |
| `DELETE /admin/courses/:id`                    | Delete (refused once learners are enrolled)             |
| `POST /admin/courses/:id/lessons`              | Append a lesson                                         |
| `PUT /admin/courses/:id/lessons/:lessonId`     | Replace a lesson's title and/or items                   |
| `DELETE /admin/courses/:id/lessons/:lessonId`  | Delete a lesson (refused once learners are enrolled)    |

```bash
curl -X POST localhost:3000/admin/courses \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Farming 101","description":"Basics","lessons":[
        {"title":"Soil","items":[
          {"kind":"text","text":"Healthy soil is the foundation."},
          {"kind":"document","url":"https://example.org/soil.pdf","caption":"Handout"}]}]}'
curl -X POST localhost:3000/admin/courses/1/publish -H "Authorization: Bearer $ADMIN_API_KEY"
```

Errors use the usual `{ "error": { "code", "message" } }` shape (400 validation, 401, 404, 409, 422).

### How delivery stays safe

- **Progress is saved only after a confirmed successful send.** If a send fails the
  message is retried with backoff (transient) or dead-lettered (permanent —
  e.g. template required outside the 24 h window); progress is unchanged, and
  `NEXT` re-sends the lesson. A learner may see part of a lesson twice after a
  failure; they can never skip one. See `docs/delivery-architecture.md`.
- **Duplicate webhooks** are stored once by `MessageSid` (persistent, survives
  restarts) and enqueued once. A crash after acceptance is reclaimed after the
  visibility timeout and finishes exactly one logical progress update.
- **One message at a time per learner** (advisory lock in the worker, cross-process),
  so a double-tapped `NEXT` can't race. Progress updates are also compare-and-set
  and strictly one lesson at a time.
- **Completion** is the delivery of the final lesson. It is one `completed_at` on the
  enrolment, written once; completed courses cannot be restarted (yet).
- **A learner has at most one active course**; others can be paused. `START <paused course>`
  resumes it.
- **Unavailable media**: if Twilio rejects an attachment the learner gets a text with the link
  instead and the lesson continues.
- Lessons can be appended and their content edited at any time, but not deleted or reordered
  once anyone is enrolled (that would shift stored positions). Unpublishing hides a course from
  new learners; people already in it can finish.

### Run it locally

```bash
npm install && cp .env.example .env     # fill in Twilio values + ADMIN_API_KEY
npm run seed                            # sample courses (set PUBLIC_BASE_URL for image + PDF)
npm run dev                             # then tunnel + set the Twilio webhook (see above)
```

Then WhatsApp the sandbox number: `COURSES` → `START 1` → `NEXT` … → `PROGRESS`.

The seed also creates **Demo 1** (text + link) and **Demo 2** (image + PDF, needs `PUBLIC_BASE_URL`
set before seeding): `START demo-1` / `START demo-2`. Re-running `npm run seed` only adds
what is missing, so it is safe on an existing database.
Production: `npm run build && npm start` (`npm run seed:prod` seeds from `dist`).

## Scripts

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Run the API with auto-reload (`tsx watch`)     |
| `npm run worker`    | Run the delivery worker (jobs, retries, scheduler) |
| `npm run build`     | Compile to `dist/` (includes `dist/worker.js`) |
| `npm start`         | Run the compiled build (`node dist/server.js`) |
| `npm test`          | Run the Vitest suite (Twilio is fully mocked)  |
| `npm run lint`      | ESLint                                         |
| `npm run typecheck` | TypeScript type check (`tsc --noEmit`)         |
| `npm run seed`      | Create/publish the sample courses (idempotent) |
| `npm run format`    | Prettier                                       |

Tests never call Twilio. Signature tests generate signatures with Twilio's own
`getExpectedTwilioSignature` helper.

## Project structure

```text
src/
├── config/env.ts                    Zod env validation (fail fast)
├── routes/whatsapp.ts               Route + middleware wiring for /webhooks/whatsapp
├── controllers/whatsapp.controller.ts  Parse → log → chatbot → send → acknowledge
├── middleware/
│   ├── validateTwilioSignature.ts   Official Twilio signature check
│   └── errorHandler.ts              Centralized error → HTTP mapping
├── services/
│   ├── whatsapp.service.ts          Only place that talks to Twilio (text + one media file)
│   ├── idempotency.ts               IdempotencyStore interface (+ no-op)
│   ├── idempotency.pg.ts            Persistent MessageSid de-duplication (INSERT .. ON CONFLICT)
│   ├── delivery.ts                  Ordered sending + media fallback
│   ├── keyedMutex.ts                Per-learner serialisation
│   ├── optout.service.ts            STOP / START opt-out list
│   ├── buttonTemplates.ts           Quick-reply template definitions + setup logic
│   ├── course.service.ts            Courses, lessons, publishing rules
│   └── enrollment.service.ts        Learner progress (compare-and-set)
├── bot/
│   ├── chatbot.ts                   Original greeting/help bot (unchanged behaviour)
│   ├── courseBot.ts                 COURSES/START/NEXT/PAUSE/RESUME/PROGRESS
│   ├── commands.ts                  Command parsing
│   └── lessonRenderer.ts            Lesson → ordered WhatsApp messages
├── db/                              pg pool + migration runner + baseline schema, seed + sample courses
├── routes/admin.ts, controllers/admin.controller.ts, middleware/adminAuth.ts   Admin API
├── scripts/seed.ts, buttons-setup.ts   `npm run seed`, `npm run buttons:setup`
├── types/whatsapp.ts                Webhook schema + shared types
├── errors.ts / logger.ts            Typed errors, structured JSON logger
├── app.ts                           createApp(deps) — dependency-injected Express app
└── server.ts                        Entry point
```

Responsibilities:

```text
Webhook Controller → MessageHandler (Chatbot) → WhatsAppSender (Twilio service) → Twilio
```

## Design notes for what comes next

- **Replace the chatbot with a Learning Engine.** The controller depends only on the
  `MessageHandler` interface (`handleMessage({ userId, text, messageId })`). A Learning Engine that
  implements it can be dropped into `server.ts` without touching the webhook layer.
- **Replace the sender with a queue.** The controller depends only on `WhatsAppSender`. Later,
  the webhook can enqueue work (Redis/worker) and a worker can send via the Twilio service.
- **Idempotency.** `MessageSid` will become the idempotency key in the persistent implementation.
  The controller already calls `IdempotencyStore.claim(messageSid)`; today it is a no-op
  (`NoopIdempotencyStore`), so duplicate webhooks are **not** deduplicated yet. Even with a
  persistent store, this reduces duplicate processing — it does **not** guarantee exactly-once
  WhatsApp delivery.
- **Webhook latency.** The reply is generated and sent before the webhook returns. Twilio's webhook
  timeout is short (about 15 seconds), which is fine for today's instant replies but is a reason to
  move to a queue/worker once logic gets slower.

## Error handling

All errors go through one handler. Clients receive `{ "error": { "code", "message" } }` and never a
stack trace, Twilio error detail, or configuration value.

| Situation                        | HTTP | `error.code`             |
| -------------------------------- | ---- | ------------------------ |
| Malformed webhook / bad body     | 400  | `bad_request`            |
| Invalid/missing Twilio signature | 403  | `invalid_signature`      |
| Chatbot threw                    | 500  | `chatbot_error`          |
| Twilio send failed               | 502  | `twilio_send_failed`     |
| Unknown route                    | 404  | `not_found`              |
| Missing/invalid configuration    | —    | process exits at startup |

WhatsApp users never see error details; if sending fails, they simply get no reply and the failure is logged.

## Logging

Logs are one JSON object per line. For each incoming message the app logs `timestamp`, `messageSid`,
`from`, `to` and `messageBody`. The Auth Token and other secrets are never logged.

> **Privacy note:** `from` is a phone number and `messageBody` is user-written text, so these logs contain
> personal data. That is useful while debugging; revisit retention and redaction before handling real learners.

## Limitations

- Postgres is the system of record: progress updates are serialised with row locks, so more
  than one instance can run, but webhook handling still assumes sticky delivery inside the
  request (Twilio waits ~15 s) and there is no cross-instance queue yet.
- Lessons are sent inside the webhook request (Twilio waits ~15 s), hence the 6-item cap.
  Twilio does not guarantee arrival order of rapidly sent messages, especially media.
- Media that Twilio accepts but later fails to download is **not** detected (needs status
  callbacks). Media URLs are not pre-checked for reachability, type or size at publish time.
- No restart of completed courses, no certificates, no upload endpoint, no admin UI.
- WhatsApp rules still apply: sandbox opt-in, and free-form messages only within the 24-hour
  customer-service window after the learner's last message.
- Logs contain phone numbers and message text; the database stores phone numbers. Decide
  retention and redaction before real learners.

See [docs/course-mvp.md](docs/course-mvp.md) for remaining work.

## Release preparation (Phase 6)

Production deployment is host-neutral until an operator selects a provider. Build the backend
and console, run `npm run migrate` as a pre-deploy job with `MIGRATION_DATABASE_URL` set to a
direct/session connection, then start the API and worker with their production environment.
Production processes skip startup migrations unless `RUN_MIGRATIONS_ON_START=true` is explicitly
set. See [docs/environment.md](docs/environment.md) and [docs/staging.md](docs/staging.md) for
connection roles, required settings, and migration procedure.

After deployment, run the endpoint-only staging check with `BASE_URL` and `ADMIN_KEY` supplied by
your secret manager or shell environment:

```text
npm run staging:smoke
```

It prints only the check name, status, and authenticated role; it does not print API response
bodies or the key. It sends a deliberately invalid webhook signature, which must be rejected
before any inbound work is stored. For real Twilio verification, use test recipients and follow
[docs/twilio-setup.md](docs/twilio-setup.md) and
[docs/live-journey-checklist.md](docs/live-journey-checklist.md). Docker, deployment, real-browser
CSP behavior, and real Twilio delivery were not verified as part of this repository preparation.
