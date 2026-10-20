# Ekatra — Production Scope

Baseline for the Stage 1 WhatsApp learning platform SOW (`Ekatra_Project_Scope_and_SOW_v1.4.md`).
Defines what is in scope, out of scope, and deferred for the minor four-week release.

## Stage 1 — WhatsApp learning platform (in scope)

A working WhatsApp learning service and React administration console, supported by an API, background worker,
PostgreSQL, Redis, security, scheduling, and operational controls. Target: delivery in less than four calendar weeks
from an unblocked kickoff.

### Included capabilities

- Existing TypeScript backend, React admin UI, PostgreSQL database, messaging package, and Redis-backed worker.
- One active WhatsApp provider (Twilio); preserve the provider used by current customers unless discovery establishes a blocker.
- One cloud hosting target; existing working production host preferred.
- Isolated staging and production configurations, with one documented local development path.
- Admin-managed courses and enrollments; tenant and role enforcement for existing organisations.
- Authored lesson/media delivery, quizzes, progress, pause/resume, opt-out, bounded course Q&A, completion, and certificates.
- Scheduling, message history/status, failure handling, and operational monitoring.
- Hardening existing AI generation if currently exposed; generated content remains draft until an authorized admin publishes it.
- Import and acceptance of one client-supplied representative course, including media and quiz content.

### Stage 1 acceptance journey

In staging, an authorized admin publishes the approved representative course, enrolls an authorized learner, and schedules
delivery. The learner receives and completes the course through the selected WhatsApp provider; pause and opt-out suppress
future sends; progress survives a worker restart and a duplicate provider callback; delivery failure appears in the React
admin; and completion produces one consistent certificate record. The selected provider, hosting target, and approved
pilot cohort must be recorded before this journey begins.

## Stage 2 — Full multi-channel product (out of scope for Stage 1)

Separately estimated milestones after Stage 1:
- 2A: Telegram learner delivery
- 2B: Learner web launch (production OTP authentication, course consumption, quizzes, tutor interaction, progress)
- 2C: Offline mobile application release and platform synchronization
- 2D: Direct Meta Cloud API and GramIQ WhatsApp adapter certification

Stage 2 is a roadmap heading, not a single delivery commitment. It does not inherit the four-week deadline.

## Explicitly deferred (outside both scopes)

- New multi-agent orchestration, knowledge graphs, mastery prediction, adaptive curriculum research.
- Semantic caching targets or elaborate routing without observed cost/latency need.
- Voice/IVR, image understanding, AI-generated lesson media, video generation.
- WATI compatibility expansion or additional messaging providers beyond Meta Cloud API and GramIQ.
- Maya/Asmaa consolidation or edge hub deployment beyond the agreed offline mobile application and synchronization milestone.
- Autonomous marketing/sales/company agents in ekatra-learning.
- Legacy rewrites, bulk archive cleanup, migrations of all historical courses/users.
- Billing/subscriptions, self-service tenant signup, enterprise SSO.
- New spaced-repetition/FSRS UX or optimization; preserve an already-used reminder flow only if documented as required during discovery.
- A claim of 10,000 concurrent users, specific completion improvement, or specific cost per learner without evidence.

## Sizing assumptions (proposed, not existing performance claims)

- 1,000 enrolled learners
- 100 simultaneously active learner conversations
- Burst of 10 inbound webhook requests/second for 10 minutes with provider/AI calls stubbed during load testing

Developer must confirm realism against actual traffic and provider constraints during discovery. Real provider tests use a small approved test cohort.

No uptime SLA or learner-outcome improvement is implied. Proposed recovery targets: RPO ≤24 hours, RTO ≤4 hours, verified by restore rehearsal.

## Required safeguards when narrowing scope

- Inventory actual customer dependencies before disabling routes or UI.
- Default unsupported features off; show only supported actions in production.
- Preserve data and compatibility needed for existing users. Provide a transition plan for any removed surface.
- Record the provider currently used by customers during discovery. The minor release keeps that provider unless it is blocked.
- Treat certificates as completion records; do not introduce mastery/accreditation claims.
- Keep AI assistance bounded to available course content and an explicit fallback; AI failure must not stop deterministic lesson delivery.

## Overdone: simplify these (per SOW)

- Competing Azure/Railway/AWS deployment narratives → maintain one production deployment path and one local development path.
- Multiple provider/compatibility routes → enable only the selected provider; preserve inactive adapters behind explicit configuration where useful.
- Multiple admin frontends → choose the existing React admin as the maintained interface; retire static admin only after checking actual usage and replacement parity.
- Cross-app worker imports → share only the delivery/domain code needed by API and worker through a supported package; avoid new microservices.
- Redis optional mode alongside production queues → require Redis for production delivery; explicit degraded local development mode may remain.
- Several AI providers/tiering/media helpers → use the existing working text configuration with explicit timeouts, budget limits, and fallback; hide unsupported capabilities.
- Broad visual FSM authoring ambition → keep authored-course import/validation and necessary editing; do not redesign the graph editor.
- Dashboard breadth without trustworthy data → keep course, learner, progress, delivery, and error views; hide incomplete or misleading panels.
- Tracked generated files and environment drift → agree source/artifact policy; produce deployable artifacts in CI; avoid committing unrelated build churn.

## Work packages (summary)

| WP | Scope | Stage 1 acceptance |
|---|---|---|
| WP0 | Scope/discovery: verify reality, freeze release scope | Operator + product owner agreement |
| WP1 | Build/deployment: reproducible builds, migrations, containers | Clean build from fresh checkout; container API/worker start |
| WP2 | Security: tenant/role isolation, verified webhook ingress, opt-out, data controls | Two-org denial tests; invalid signatures rejected; disabled endpoints inactive |
| WP3 | Delivery/recovery: durable inbound/outbound, scheduling, retry/replay | Duplicate/restart/concurrency tests; timezone fixtures; restart catch-up |
| WP4 | Product journey: learner/admin journey, certificates, bounded AI | Staging run of approved course; one certificate record |
| WP5 | Operate/validate/handover: CI, monitoring, restore/rollback, load test, production release | All release gates pass; production deployment authorized |

## Acceptance milestones

- A = WP0–WP1 at end of Week 1
- B = WP2–WP3 at end of Week 3
- C = WP4–WP5 before the four-week deadline

If verified effort exceeds four-week capacity, the product owner must defer non-critical breadth while retaining the security,
data-isolation, progress-integrity, deployment, and recovery gates.

## Release-blocking defects

Unauthorized access, lost/corrupted learner progress, inability to complete the core journey, persistent delivery/scheduling
failure, or inability to deploy/recover safely. Cosmetic defects may be accepted only in a documented residual backlog.
