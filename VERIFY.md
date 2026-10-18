# Verify Phases 1 + 2 + 2.5 + 3 on a clean checkout (placeholders only)
Prereqs: Node 24.16.0 (`nvm use`), Docker, `curl`, `jq`, PostgreSQL 18 client tools
(`pg_dump`, `pg_restore`) for the backup proof. Never use real learner numbers
or real secrets. All values below are placeholders.

## 1. Reproducible build (Phases 1-2.5)

```bash
npm ci
npm run typecheck
npm run lint
npm test        # expect 348 passed + 1 explicit skip (backup proof needs pg_dump), 25 files
npm run build
```

Tests need no Docker: they start an embedded PostgreSQL 18 automatically
(`tests/pg.global-setup.ts`, one shared cluster, one isolated database per file).
In CI they use the `postgres:18` service via `EKATRA_TEST_DATABASE_URL`.

## 2. Docker build + run (Postgres)

```bash
docker build -t ekatra-bot:verify .
cp .env.example .env   # fill placeholders: TWILIO_*=ACxxx/your-token, ADMIN_API_KEY=<32+ chars>,
                       # DATABASE_URL=postgres://ekatra:ekatra-dev-only@postgres:5432/ekatra
docker compose up -d   # starts postgres:18, one-shot migrate job, API, and worker
curl localhost:3000/health            # {"status":"ok"}
curl -s localhost:3000/register | head -c 200   # HTML page
# worker liveness is the heartbeat row (the API keeps /health):
# SELECT worker_id, last_beat FROM worker_heartbeat;  -- fresh every WORKER_POLL_MS
```

## 3. Backup / restore round trip (Phase 2.5, pg_dump custom format)

```bash
DATABASE_URL=postgres://ekatra:ekatra-dev-only@localhost:5433/ekatra \
  sh scripts/backup.sh ./backups/verify.dump
ls -la ./backups/verify.dump           # exists, non-empty
# restore proof into an ISOLATED empty database (never over live data first):
createdb verify_restore
sh scripts/restore.sh ./backups/verify.dump postgres://ekatra:ekatra-dev-only@localhost:5433/verify_restore
```

Automated proof (runs in CI where client tools exist):
`npm test -- tests/backup.test.ts` — dumps, restores into an isolated DB, checks integrity
plus a smoke subset, and prints `backup-proof bytes=… backupMs=… restoreMs=…`.
RPO = backup interval (operator cron; WAL/PITR only on managed hosts — a hosting decision).
RTO = restore time (measured above) + redeploy.

## 4. Upgrade + import tests (Phases 2 + 2.5)

Covered by the suite:

```bash
npm test -- tests/orgs.isolation.test.ts   # legacy SQLite v5 chain still upgrades (raw SQL)
npm test -- tests/pg.foundation.test.ts   # PG ledger, checksums, locks, positions, int8
npm test -- tests/import.test.ts           # SQLite fixture -> Postgres, counts + spot checks
npm run import:sqlite -- --sqlite ./data/ekatra.db --dry-run   # planned counts, writes nothing
```

## 5. Two-org RBAC curl tour (Phase 2, bootstrap key)

```bash
export BASE=localhost:3000 ADMIN_KEY=your_admin_key_here
auth() { echo "Authorization: Bearer $1"; }

# orgs + users (bootstrap platform_admin)
curl -X POST $BASE/admin/orgs -H "$(auth $ADMIN_KEY)" -H 'Content-Type: application/json' \
  -d '{"slug":"acme","name":"Acme"}'
curl -X POST $BASE/admin/orgs -H "$(auth $ADMIN_KEY)" -H 'Content-Type: application/json' \
  -d '{"slug":"other","name":"Other"}'
ACME_KEY=$(curl -s -X POST $BASE/admin/users -H "$(auth $ADMIN_KEY)" -H 'Content-Type: application/json' \
  -d '{"org":"acme","name":"Asha","role":"org_admin"}' | jq -r .apiKey)
INS_KEY=$(curl -s -X POST $BASE/admin/users -H "$(auth $ADMIN_KEY)" -H 'Content-Type: application/json' \
  -d '{"org":"acme","name":"Dev","role":"instructor"}' | jq -r .apiKey)
echo "$ACME_KEY" | grep -c ek_live_   # 1 (shown once; only a hash is stored)

# course in acme, publish it
CID=$(curl -s -X POST "$BASE/admin/courses?org=acme" -H "$(auth $ACME_KEY)" -H 'Content-Type: application/json' \
  -d '{"title":"Verify 101","description":"smoke","lessons":[{"title":"L1","items":[{"kind":"text","text":"Hello verify"}]}]}' | jq -r .course.id)
curl -X POST "$BASE/admin/courses/$CID/publish?org=acme" -H "$(auth $ACME_KEY)"

# cross-org is 404 (use the id in the other org):
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/admin/courses/$CID?org=other" -H "$(auth $ACME_KEY)"  # 404
# instructor blocked from user mgmt:
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin/users -H "$(auth $INS_KEY)"  # 403
# no/invalid credentials:
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin/courses            # 401
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin/courses -H 'Authorization: Bearer wrong'  # 401

# scoped public registration (?org=) + unknown org:
curl -s "$BASE/register/courses?org=acme" | jq .courses[].title   # Verify 101
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/register/courses?org=nope"  # 404
curl -s -X POST $BASE/register -H 'Content-Type: application/json' \
  -d '{"name":"Test Learner","phoneNumber":"+910000000001","courseId":'$CID',"consent":true,"org":"acme"}' | jq .success  # true
```

## 6. Learner export / delete + retention (Phase 2)

```bash
PH=whatsapp%3A%2B910000000001
curl -s $BASE/admin/learners/$PH/export -H "$(auth $ACME_KEY)" | jq '{phone: .learner.phone, enrollments: (.enrollments|length), optOut}'
curl -s -X DELETE $BASE/admin/learners/$PH -H "$(auth $ACME_KEY)" | jq .   # optOutRetained: false (never opted out)
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin/learners/$PH/export -H "$(auth $INS_KEY)"  # 403
npm run cleanup   # prints { processedMessages, auditLog } counts; opt-outs untouched
```

## 7. Twilio sandbox smoke (test numbers only)

1. Point the sandbox "When a message comes in" at `POST https://<staging>/webhooks/whatsapp`
   with `PUBLIC_BASE_URL=https://<staging>` set (restart first).
2. Phone: send `join <sandbox-code>`, then `hi` → Start Course prompt.
3. `START COURSE` → lesson 1; `NEXT` → lesson 2; `PAUSE` → paused; `RESUME` → active.
4. Finish → certificate link; `CERTIFICATE` re-sends (one record only).
5. `STOP` → exactly one confirmation, then **silence** (further texts get no reply).
6. `START` → opted back in; `RESUME` continues.
7. Negative: replay with a tampered `X-Twilio-Signature` → 403, no reply, no state change.

## 8. Route inventory gate

```bash
npm test -- tests/ingress.test.ts   # inventory pin + mounted-count + 401/403/413/media/CORS/header cases
```

Any new route must be added to `ROUTE_INVENTORY` (`src/app.ts`) with its protection class,
or this fails by design.

## 9. Phase 3 worker restart test (durable recovery)

```bash
npm test -- tests/durable-inbound.test.ts  # crash-after-acceptance: reclaim -> exactly one progress update
```

Manual proof against a staging stack (placeholders only, test numbers only):

1. Send `NEXT` to the sandbox number (worker running).
2. Kill the worker mid-processing (`docker compose stop worker`, restart within
   `WORKER_VISIBILITY_SECS`): the message row stays `processing`.
3. Start the worker: it reclaims the stuck job, delivers the lesson once, and
   advances progress exactly one step (`SELECT status, attempts FROM jobs`
   shows one `completed` chain; the enrollment moved one lesson).

## 10. Duplicate status-callback test (no regression)

```bash
npm test -- tests/durable-outbound.test.ts  # signed + deduped; delivered never regresses
```

Manual proof: with a real Twilio number, trigger two `MessageStatus=delivered`
callbacks for one `MessageSid` on `/webhooks/whatsapp/status` (valid signature):
both return 200, the message stays `delivered`, and no extra attempt row appears.
A tampered signature returns 403 and changes nothing.

## 11. Failed-send retry / replay tour (test numbers only)

1. Break sending (e.g. point the worker at invalid Twilio credentials in staging):
   webhooks still return 200 (accepted durably); progress does not move.
2. `GET /admin/failures` (org_admin key) shows the work with reasons; counts by
   `reason_code` are included.
3. Restore credentials; wait out the backoff (or replay):
   `POST /admin/failures/:id/replay` → lesson arrives once, progress advances once.
4. For an opted-out learner the replay returns 409 and sends nothing.
5. `POST /admin/failures/:id/discard` needs `{reason}` (400 without); both replay
   and discard appear in `GET /admin/audit` as `failure.replay` / `failure.discard`.

## 12. Quiz explanation storage and delivery

The optional quiz explanation is a nullable `TEXT` field (trimmed, max 1000
characters) stored on the quiz item, not as a new lesson item. It is included in
course create/read/edit responses and imported from SQLite when the source schema
contains the optional field. Existing SQLite sources without it import as NULL.
Verify the migration-upgrade, API validation/edit-preservation, import, correct and
incorrect feedback, NULL behavior, duplicate-webhook, and outbound-retry regressions
with:

```bash
npm test -- tests/pg.foundation.test.ts tests/admin.api.test.ts tests/import.test.ts tests/course.journey.test.ts tests/reliability.test.ts
```

All Twilio sends in these automated tests use the fake sender. Do not use real learner
numbers or send real messages for this check.

## 13. Phase 5 Part 1 admin console (`/console`)

Build the UI and API from the repository root with `npm run build`, start the API using the
normal staging configuration, then open `https://<staging>/console/`. Use an authorized
test administrator key; do not paste real keys into URLs, browser storage, logs, or screenshots.
Leave “Keep me signed in on this tab” unchecked for memory-only sign-in. If checked, the key may
appear only in that tab's `sessionStorage`, never `localStorage`.

Acceptance by role:

- **`org_admin`:** Sign in; create a draft course, add a lesson and quiz explanation, save, publish
  and unpublish with confirmation. In Learners, confirm the phone is masked, open details, reveal
  and hide the number, and enroll a test learner only after checking the consent statement. Pause
  and resume a test enrollment. In Schedules, configure course and enrollment times plus an
  organisation timezone/default, save, and inspect server-generated next send times.
- **`platform_admin`:** Repeat the supported course, learner, and schedule checks after selecting
  the intended organisation in the org switcher. Confirm the selection is in `?org=` and no phone
  number is ever placed in a URL.
- **`instructor`:** Confirm only Courses and Learners navigation appears. Read a learner's masked
  phone and progress; confirm no number reveal, enrollment, pause/resume, or Schedules link/action
  is available.

Automated route-level smoke test (no real messaging):

```sh
npm test -- tests/ingress.test.ts
```

It checks `/console/` static serving and SPA fallback, strict console CSP and caching, plus
non-shadowing of `/admin`, `/webhooks`, `/register`, `/health`, `/ready`, and `/media`. Verify the
CSP in a real browser before production rollout; this task's validation is API-level and does not
claim a browser-based CSP audit.

## 14. Local console preview without Twilio

On a development machine with dependencies installed, run:

```sh
npm run dev:local
```

The command starts a disposable embedded PostgreSQL cluster, applies migrations, seeds a demo
organisation and course, issues an `org_admin` key, then starts the API, worker with the local
fake sender, and Vite UI. The key is printed once in the terminal and is never written to a file.
Use it only for the local console sign-in; no Twilio request or real message is sent. Open the
printed `/console/` URL and press Ctrl+C to stop all services and remove the temporary database.
If the embedded PostgreSQL binary cannot start on Windows, use a disposable local `DATABASE_URL`
with the ordinary API and UI development commands; never use production data.

## 15. Phase 5 Part 2 operational console

Use `npm run dev:local` for an isolated demo with the synthetic sender, or a disposable staging
stack with test-only data. Do not use real learner numbers or send real messages.

- **`org_admin`:** Open Delivery; filter and page through outbound records, then inspect one detail
  and its attempts. Confirm no inbound text or phone number appears in the list. Open Failures,
  inspect attempts, replay a test failure, and discard another only with a reason. Open
  Certificates and verify a cooldown response is shown in plain language. In Users/API keys,
  create or rotate a test key, copy it once, close the dialog, and confirm the plaintext is gone;
  inspect Audit read-only. Open Status and confirm readiness and worker heartbeat state.
- **`platform_admin`:** Select an organisation and repeat the same operational checks. Confirm
  records and actions stay scoped to the selected organisation and no phone number is placed in a
  URL.
- **`instructor`:** Confirm navigation contains only Courses and Learners. Verify learner detail
  and progress remain read-only with masked phone numbers; there are no Delivery, Failures,
  Certificates, Schedules, Users/API keys, Audit, or Status screen links or learner action buttons.

Automated end-to-end API flow (fake sender; no Twilio):

```sh
npm test -- tests/console.smoke.test.ts
```

The test creates and publishes a course, enrolls with consent, schedules and delivers lessons,
forces a failure, inspects it, replays it, and verifies delivery/progress plus instructor route
restrictions. Root Vitest discovery remains restricted to `tests/**/*.test.ts`; run the complete
root and admin-ui gates with `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
from the root, and the equivalent scripts from `admin-ui/`.

## 16. Phase 6 pre-deploy and staging verification

Run the backend and UI gates before packaging. In production, set
`MIGRATION_DATABASE_URL` to a direct/session migration connection and run
`npm run migrate` as a separate pre-deploy step. Start the API and worker only after the
migration succeeds; production startup migrations are disabled by default. Use
`npm run migrate:prod` when running the compiled migration job after `npm run build`.

After the host is configured, inject `BASE_URL` and `ADMIN_KEY` from a secret manager, then run:

```text
npm run staging:smoke
```

The script checks `/health`, `/ready`, `/worker-status`, `/console` and its strict CSP,
`/admin/session`, `/register`, and rejection of an invalid-signature webhook. It prints status
only, not response bodies or the key. The local integration proof is
`npm test -- tests/staging-smoke.test.ts`; it also verifies the rejected webhook creates no
inbound event or job.

For SQLite migration review, use a protected copy and the counts-only command in
`docs/import-runbook.md`; the original source stays untouched. For a real Twilio run, first
confirm the account/sender/templates and consent, then fill in
`docs/live-journey-checklist.md` using the proxy and signature instructions in
`docs/twilio-setup.md`. Do not send live messages until an operator authorizes the test.
