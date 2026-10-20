# WP0 — Deployment Inventory

Verified from codebase + SOW. Items marked `[CUSTOMER]` require product owner confirmation.

## Repository

| Field | Value | Source |
|---|---|---|
| Canonical application repository | github.com/iabheejit/ekatra-platform (main) | SOW v1.4 line 25 |
| Local working directory | /Users/Shared/Scripts/ekatra-master/active/ekatra-platform | SOW v1.4 line 25 |
| Current working copy branch | main | `git branch` |
| Remote origin | https://github.com/Chirayu1167/Ekatra-bot.git | `git remote -v` |
| Last commit SHA | bb98f04316b1631bfac03d68540b500c0865eb83 | `git log -1` |
| Last commit message | feat: production-grade Ekatra WhatsApp learning platform | `git log -1` |
| Last commit date | Sun Oct 18 18:36:26 2026 +0530 | `git log -1` |
| Staged uncommitted changes | 19 admin-ui files (new screens/components/routes) | `git diff --cached --name-only` |
| Uncommitted untracked files | DEVELOPER_SOW.md, HARDENING_PROGRESS.md, PRODUCTION_SCOPE.md, SOW_REMAINING.md | `git status` |

## Deployment targets

| Field | Value | Source |
|---|---|---|
| Active WhatsApp provider | Twilio | src/services/whatsapp.service.ts, README |
| Production hosting target | [CUSTOMER] Not selected | PHASE6_REPORT: "No hosting provider was selected" |
| Staging environment | [CUSTOMER] Not configured | No staging URLs in codebase |
| Production URL | [CUSTOMER] Not set | PUBLIC_BASE_URL required in production, currently unset |
| Container registry | GHCR (configured, not published) | .github/workflows/release.yml |

## Infrastructure

| Component | Technology | Status |
|---|---|---|
| Backend API | Node 24.16.0, Express, TypeScript | src/server.ts |
| Worker | Node 24.16.0, TypeScript | src/worker.ts |
| Database | PostgreSQL 18 | src/db/pg.ts, docker-compose.yml |
| Cache/queue | Redis (required for production) | src/config/env.ts, Redis-backed worker |
| Container | Multi-stage Dockerfile | Dockerfile |
| Orchestration | docker-compose | docker-compose.yml |
| CI/CD | GitHub Actions (ci.yml, release.yml) | .github/workflows/ |
| Container registry | GHCR | .github/workflows/release.yml |

## Migration state

| Field | Value | Source |
|---|---|---|
| Migration runner | src/scripts/migrate.ts (checksum + advisory locking) | Code |
| Baseline schema (PG) | v1–v7 equivalent in pgSchema.ts | Code |
| Phase 3 delivery schema | phase3Schema.ts (v2 + v3) | Code |
| Phase 4 migrations | v4 consent/cert cooldown, v5 quiz explanations | migratePg.ts |
| Production database rollout state | [CUSTOMER] UNKNOWN | PHASE4_STATUS: "Production database rollout state: UNKNOWN" |
| MIGRATION_DATABASE_URL | [CUSTOMER] Not configured | .env.example placeholder only |

## Worker topology

| Field | Value | Source |
|---|---|---|
| Worker entry point | src/worker.ts | Code |
| Poll interval | WORKER_POLL_MS (default 2000ms) | src/config/env.ts |
| Visibility timeout | WORKER_VISIBILITY_SECS (default 300s) | src/config/env.ts |
| Max jobs per tick | WORKER_MAX_JOBS_PER_TICK (default 4) | src/config/env.ts |
| Scheduler enabled | SCHEDULER_ENABLED (default true) | src/config/env.ts |
| Scheduler tick | SCHEDULER_TICK_MS (default 60000ms) | src/config/env.ts |
| Grace hours | SCHEDULER_GRACE_HOURS (default 6) | src/config/env.ts |
| Single-leader scheduler lock | pg_try_advisory_lock (class id 2) | src/services/scheduler.service.ts |
| Worker heartbeat table | worker_heartbeat | phase3Schema.ts |

## Operational owners

| Role | Name | Contact | Status |
|---|---|---|---|
| Product owner | [CUSTOMER] TBD | [CUSTOMER] TBD | Not named |
| Developer | [CUSTOMER] TBD | [CUSTOMER] TBD | Not named |
| Operational owner | [CUSTOMER] TBD | [CUSTOMER] TBD | Must be named before release (SOW) |

## Secrets and credentials

| Field | Value | Status |
|---|---|---|
| TWILIO_ACCOUNT_SID | [CUSTOMER] Required, not in repo | .env.example placeholder |
| TWILIO_AUTH_TOKEN | [CUSTOMER] Required, not in repo | .env.example placeholder |
| TWILIO_WHATSAPP_FROM | [CUSTOMER] Required, not in repo | .env.example placeholder |
| ADMIN_API_KEY | [CUSTOMER] Required for admin API | .env.example placeholder |
| OPTOUT_HASH_SECRET | [CUSTOMER] Required in production | .env.example placeholder |
| CERTIFICATE_SECRET | [CUSTOMER] Recommended | .env.example placeholder |
| DATABASE_URL | [CUSTOMER] Required | .env.example placeholder |
| MIGRATION_DATABASE_URL | [CUSTOMER] Required for migrations | .env.example placeholder |
| PUBLIC_BASE_URL | [CUSTOMER] Required in production | .env.example placeholder |

## Acceptance fixtures

| Field | Value | Status |
|---|---|---|
| Approved representative course | [CUSTOMER] TBD | Not yet confirmed |
| Pilot cohort | [CUSTOMER] TBD | Not yet confirmed |
| Test users (two organizations) | [CUSTOMER] TBD | Not yet confirmed |
| Provider templates/credentials | [CUSTOMER] TBD | buttons:setup creates templates; approval needed |
