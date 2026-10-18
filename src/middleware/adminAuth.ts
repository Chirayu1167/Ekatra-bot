import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors';
import type { AdminPrincipal, AdminRole, AdminAuthService } from '../services/adminAuth.service';
import type { OrganisationsService } from '../services/organisations.service';

/**
 * Protects /admin with a shared secret: `Authorization: Bearer <ADMIN_API_KEY>`.
 * Both sides are hashed first so the comparison is constant-time regardless of length.
 * Kept for the bootstrap credential; per-user keys go through `authenticateAdmin`.
 */
export function requireAdminKey(apiKey: string): RequestHandler {
  const expected = createHash('sha256').update(apiKey).digest();
  return (req, _res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
    const given = createHash('sha256')
      .update(match?.[1]?.trim() ?? '')
      .digest();
    if (!match || !timingSafeEqual(given, expected)) {
      next(new UnauthorizedError());
      return;
    }
    next();
  };
}

function bearerToken(req: Parameters<RequestHandler>[0]): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Authenticates per-user API keys (and the bootstrap key) into `res.locals.principal`.
 * Unknown, revoked or expired credentials → 401. Never logs the presented value.
 */
export function authenticateAdmin(
  auth: AdminAuthService,
  bootstrapKey?: string,
): RequestHandler {
  const expectedBootstrap = bootstrapKey
    ? createHash('sha256').update(bootstrapKey).digest()
    : null;
  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      next(new UnauthorizedError());
      return;
    }
    if (expectedBootstrap) {
      const given = createHash('sha256').update(token).digest();
      if (given.length === expectedBootstrap.length && timingSafeEqual(given, expectedBootstrap)) {
        (res.locals as { principal?: AdminPrincipal }).principal = {
          userId: null,
          orgId: null,
          role: 'platform_admin',
          bootstrap: true,
        };
        next();
        return;
      }
    }
    let principal: AdminPrincipal | null;
    try {
      principal = await auth.authenticate(token);
    } catch {
      next(new UnauthorizedError());
      return;
    }
    if (!principal) {
      next(new UnauthorizedError());
      return;
    }
    (res.locals as { principal?: AdminPrincipal }).principal = principal;
    next();
  };
}

/** Reads the authenticated principal. Missing principal is fail-closed (401). */
export function principal(req: Parameters<RequestHandler>[0]): AdminPrincipal {
  const p = (req.res?.locals as { principal?: AdminPrincipal } | undefined)?.principal;
  if (!p) throw new UnauthorizedError();
  return p;
}

/** Role gate applied per route. Insufficient role → 403 (never reveals resources). */
export function requireRole(...allowed: AdminRole[]): RequestHandler {
  return (req, _res, next) => {
    const p = principal(req);
    if (!allowed.includes(p.role)) {
      next(new ForbiddenError());
      return;
    }
    next();
  };
}

/**
 * Tenant scope from the principal — never from raw client input. platform_admin may name an
 * org explicitly via `?org=<slug>` (resolved server-side; unknown → 404); every other role is
 * pinned to its own org and any `?org=` is ignored. Result lands in `res.locals.orgId`.
 */
export function resolveOrgFromPrincipal(orgs: OrganisationsService): RequestHandler {
  return async (req, res, next) => {
    let p: AdminPrincipal;
    try {
      p = principal(req);
    } catch {
      next(new UnauthorizedError());
      return;
    }
    if (p.role === 'platform_admin' && p.orgId === null) {
      const raw = req.query['org'];
      if (raw === undefined) {
        try {
          (res.locals as { orgId?: number }).orgId = await orgs.getDefaultId();
        } catch {
          next(new NotFoundError('Organisation not found'));
          return;
        }
        next();
        return;
      }
      if (typeof raw !== 'string') {
        next(new NotFoundError('Organisation not found'));
        return;
      }
      const org = await orgs.getBySlug(raw.trim().toLowerCase());
      if (!org) {
        next(new NotFoundError('Organisation not found'));
        return;
      }
      (res.locals as { orgId?: number }).orgId = org.id;
      next();
      return;
    }
    // Non-platform principals are pinned to their own org. Explicitly naming another org
    // is cross-org access → 404 (never reveal what exists elsewhere).
    if (p.orgId === null) {
      next(new NotFoundError('Organisation not found'));
      return;
    }
    const raw = req.query['org'];
    if (raw !== undefined) {
      const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      const org = slug ? await orgs.getBySlug(slug) : undefined;
      if (!org || org.id !== p.orgId) {
        next(new NotFoundError('Organisation not found'));
        return;
      }
    }
    (res.locals as { orgId?: number }).orgId = p.orgId;
    next();
  };
}
