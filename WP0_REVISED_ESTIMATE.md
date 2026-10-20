# WP0 — Revised Estimate

## Summary

| Item | Value |
|---|---|
| Original SOW target | Less than 4 calendar weeks from unblocked kickoff |
| Staffing assumption | 1 experienced full-time developer |
| Estimated effort (all work packages) | 24 developer-days |
| Available capacity (4 weeks) | ~20 working days |
| Variance | +4 days over capacity |
| Revised estimate (after deferrals) | 22.5 developer-days |
| Still over capacity? | Yes, by ~2.5 days |

## Work package breakdown

| WP | Scope | Estimate | Status |
|---|---|---|---|
| WP0 | Scope/discovery | 4 days | In progress |
| WP1 | Build/deployment | 6.25 days | Not started |
| WP2 | Security/ingress | 2.75 days | Code complete; verify |
| WP3 | Delivery/recovery | 3 days | Code complete; verify |
| WP4 | Learner/admin journey | 3 days | Code complete; verify |
| WP5 | Operate/validate/handover | 5 days | Not started |
| **Total** | | **24 days** | |

## Deferral options (non-critical breadth only)

Per SOW: if verified effort exceeds four-week capacity, the product owner must defer non-critical breadth while retaining security, data-isolation, progress-integrity, deployment, and recovery gates.

| Deferral | Effort saved | Impact |
|---|---|---|
| Async maintainer training (WP5-7) | 0.5 day | Low — docs already written |
| Media URL production validation (WP4-4) | 0.5 day | Medium — needs PUBLIC_BASE_URL anyway |
| Node/pnpm version pinning (WP1-7) | 0.25 day | Low — .nvmrc already pins Node 24.16.0 |
| Learner-web disabled confirmation (WP2-4) | 0.25 day | Low — already code-complete |
| **Total deferrable** | **1.5 days** | |

**Revised estimate after deferrals: 22.5 days**

## SOW-mandated gates that cannot be deferred

- Tenant/role enforcement (WP2)
- Verified webhook ingress (WP2)
- Durable inbound/outbound processing (WP3)
- Correct scheduling (WP3)
- Controlled retry/replay (WP3)
- Full learner journey (WP4)
- Certificate consistency (WP4)
- Clean build from fresh checkout (WP1)
- Container API/worker start (WP1)
- Repeatable safe migration (WP1)
- Monitoring/alerts with named recipients (WP5)
- Backup/restore with measured RPO/RTO (WP5)
- Rollback demonstration (WP5)
- Load profile in staging (WP5)
- Production deploy + real-provider smoke test (WP5)

## Customer decisions needed to finalize estimate

| Decision | Owner | Needed by | Effect on estimate |
|---|---|---|---|
| Hosting provider | Product owner | WP1-1 | WP1-2 effort varies by host |
| Staging environment access | Product owner | WP1-5 | Enables WP1-5, WP5-6 |
| Provider credentials/templates | Product owner | WP5-6 | Enables real-channel test |
| Operational owner named | Product owner | Before release | Enables WP5-4 alerts |
| pg_dump/pg_restore available | Infrastructure | WP5-5 | Enables backup/restore proof |
| Recovery targets confirmed | Product owner | WP0-4 | Confirms RPO/RTO scope |
| Traffic baseline confirmed | Product owner | WP0-4 | Confirms load profile scope |

## Recommendation

The 24-day estimate exceeds the 20-day four-week capacity by 4 days. Even after deferring 1.5 days of non-critical work, the revised estimate is 22.5 days — still over capacity.

**Options:**
1. **Reduce scope further** — but this would require cutting from security/isolation/integrity/deployment/recovery gates, which the SOW prohibits.
2. **Extend timeline** — accept ~5 weeks instead of <4 weeks.
3. **Add developer capacity** — second developer could parallelize WP2/WP3 verification and WP5 tasks.
4. **Defer WP5 items post-launch** — backup/restore proof and load test could be completed shortly after production release, with the understanding that they are release-blocking gates per SOW.

**Recommended path:** Option 3 or 4. The code implementation is substantially complete; the remaining effort is primarily verification, staging/production deployment, and operational readiness — all of which can be parallelized or sequenced after an initial production release with documented residual risks.
