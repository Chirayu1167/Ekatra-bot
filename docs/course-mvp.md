# Course delivery MVP — audit, design, status

## Audit of the original codebase

A ~400-line TypeScript/Express/Twilio service (40 tests). It had a webhook with Twilio signature
validation, injected seams (`MessageHandler`, `WhatsAppSender`, `IdempotencyStore`) and a
stateless greeting bot. It had **no** database, courses, enrolment, media sending, working
idempotency (no-op store), admin surface or auth. Its `ChatbotReply` could carry only one text.

## What changed

| Area                | Change                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New                 | `src/db/*` (SQLite, migrations, seed), `course.service`, `enrollment.service`, `courseBot`, `commands`, `lessonRenderer`, `delivery`, `keyedMutex`, `idempotency.sqlite`, admin route/controller/auth, `scripts/seed.ts`, `media/` samples                                                      |
| Modified (additive) | `chatbot.ts` (optional reply fields), `whatsapp.controller.ts` (multi-message send, post-send commit hook, release-on-failure, per-learner lock), `whatsapp.service.ts` + `types/whatsapp.ts` (`mediaUrl`), `idempotency.ts` (optional `release`), `app.ts`, `server.ts`, `env.ts`, `errors.ts` |
| Unchanged           | The original three test files, signature validation, error handler, logger, the original bot's replies                                                                                                                                                                                          |

## Decisions (yours to confirm)

1. **SQLite via Node's built-in `node:sqlite`** — no DB existed. I first used `better-sqlite3`,
   but a clean `npm ci` tried to compile it (needs a C++ toolchain, e.g. on Windows) and it
   requires Node >= 22 anyway, so I switched. Trade-offs: Node still marks `node:sqlite`
   "experimental" (startup warning), and `engines` is now `>=22.13` (was `>=20`). SQL lives only
   in `src/db`, `course.service`, `enrollment.service` and `idempotency.sqlite`, so moving to
   PostgreSQL later touches those files.
2. **Progress commits after send (at-least-once).** Failure ⇒ a lesson may repeat, never skip.
3. **START delivers intro + lesson 1**; `NEXT` delivers each later lesson.
4. **One active course per learner**; completed courses can't be restarted.
5. **Media is sent as separate messages**, never as captions (Twilio docs are inconsistent).
6. **Admin auth = one shared bearer key**, API disabled when unset.

## Test results

`npm test`: 210 tests, 10 files (40 original + 170 new), all passing; `lint`, `typecheck`,
`build` clean. Covers: listing, starting, every content type, all lessons, pause/resume,
restart persistence (file DB, three process "restarts"), duplicate and concurrent webhooks,
repeated commands, invalid input, send failure + retry, media fallback, admin CRUD/validation/
auth, migrations, seed, `/media`.
Safety checks were also **mutation-tested**: ~20 deliberate breakages (e.g. commit before send,
drop the lock, drop compare-and-set, never release a claim, skip rollback, open admin auth) were
each caught by at least one test, re-run after the driver change. This exposed two real gaps
(single-step progress, transaction rollback), now covered. One surviving mutant is equivalent
(`PRAGMA foreign_keys = ON` is already the `node:sqlite` default).

Not tested: **live Twilio/WhatsApp delivery** (no credentials or network here). A compiled-server
smoke test confirmed health, admin API, auth, seed idempotency, `/media` content types,
persistence across a process restart, and that a failing send returns 502 without recording
progress. Real media rendering on a phone, Twilio's real error codes for bad media, and message
ordering on a real handset remain to be verified with your sandbox.

## Added after the first handover

- **STOP opt-out** (`opt_outs` table, migration 2). Tested incl. restart persistence.
- **Tap buttons** via Twilio quick-reply templates (`npm run buttons:setup`). Tested with a fake
  Twilio: message order, tap handling via `ButtonPayload`, fallback to plain text, setup logic.
  **Not tested against real Twilio:** creating the templates, whether the sandbox renders the
  buttons, and the exact inbound fields on a real tap. Verify with the script below.

### Buttons: manual check

1. `npm run buttons:setup`, paste the 3 lines into `.env`, restart.
2. `START demo-1` → under lesson 1 you should see **Next** and **Pause** buttons. Tap Next.
3. Tap Pause → a **Resume** button appears. Tap it.
4. Finish the course → a **Courses** button appears.
5. If no buttons render: check the server log for `whatsapp.buttons.fallback`; you will have
   received plain text instead. Send me the log line and the Twilio error code.

## Remaining work / open questions

- Run the manual script below against your Twilio sandbox, including a deliberately bad media URL.
- Where will real course files live (own server / S3 / CDN)? Upload endpoint?
- Move delivery off the webhook (queue/worker) if lessons grow or ordering proves flaky;
  add Twilio status callbacks to detect async media failures and to order messages.
- Publish-time media check (HEAD: reachable, content-type, size).
- Restart/re-take policy; PostgreSQL if multiple instances; retention/redaction of phone numbers.
- Admin UI; per-admin auth if more than the shared key is needed.

## Manual sandbox script

1. `npm run seed` (with `PUBLIC_BASE_URL` set), `npm run dev`, tunnel, set Twilio webhook.
2. `COURSES` → `START 1` → `NEXT` → `NEXT` (lesson 3 should include the image and PDF).
3. `PAUSE`, `NEXT` (refused), `RESUME`, `PROGRESS`.
4. Stop and restart the server; `PROGRESS` should be unchanged.
5. Create a course via the admin API with a dead media URL; confirm the learner gets the link fallback.
