import type { RequestHandler } from 'express';
import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import { principal } from '../middleware/adminAuth';
import type { AdminAuthService } from '../services/adminAuth.service';
import { ReplayRefusedError, type DeadLetterService } from '../services/deadLetters.service';
import { orgId } from './admin.controller';

export interface FailuresControllerDeps {
  deadLetters: DeadLetterService;
  auth: AdminAuthService;
}

const listQuery = z.object({
  kind: z.enum(['inbound', 'outbound']).optional(),
  status: z.enum(['open', 'replayed', 'discarded']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const replayBody = z.object({ note: z.string().max(500).optional() });
const discardBody = z.object({ reason: z.string().trim().min(1).max(500) });

function idParam(req: { params: Record<string, unknown> }): number {
  const raw = req.params['id'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new NotFoundError();
  return Number(raw);
}

/**
 * Dead letters + controlled replay (org_admin and platform_admin, org-scoped).
 * Inbound rows carry no org, so they are visible to platform_admin only;
 * outbound rows are scoped to the caller's org (cross-org ids are 404).
 * Every replay/discard is audit-logged.
 */
export function createFailuresController({ deadLetters, auth }: FailuresControllerDeps) {
  const includeInbound = (req: Parameters<RequestHandler>[0]): boolean =>
    principal(req).role === 'platform_admin';

  const audit = async (req: Parameters<RequestHandler>[0], action: string, target: string) => {
    const p = principal(req);
    await auth.recordAudit(p.userId, orgId(req), action, target);
  };

  const notFound = (err: unknown): never => {
    if (err instanceof Error && err.message === 'not found') throw new NotFoundError('Failure not found');
    if (err instanceof ReplayRefusedError) throw new ConflictError(err.message);
    throw err;
  };

  return {
    listFailures: (async (req, res) => {
      const parsed = listQuery.safeParse(req.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query: kind, status, limit');
      const { failures, counts } = await deadLetters.list(orgId(req), {
        ...(parsed.data.kind && { kind: parsed.data.kind }),
        ...(parsed.data.status && { status: parsed.data.status }),
        ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
        includeInbound: includeInbound(req),
      });
      res.json({ failures, counts });
    }) satisfies RequestHandler,

    getFailure: (async (req, res) => {
      try {
        res.json(await deadLetters.inspect(orgId(req), idParam(req), includeInbound(req)));
      } catch (err) {
        notFound(err);
      }
    }) satisfies RequestHandler,

    replayFailure: (async (req, res) => {
      const parsed = replayBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid request: note');
      const id = idParam(req);
      try {
        const result = await deadLetters.replay(orgId(req), id, includeInbound(req), parsed.data.note ?? '');
        await audit(req, 'failure.replay', `failure:${id}`);
        res.json({ replayed: true, ...result });
      } catch (err) {
        notFound(err);
      }
    }) satisfies RequestHandler,

    discardFailure: (async (req, res) => {
      const parsed = discardBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid request: a discard reason is required');
      const id = idParam(req);
      try {
        await deadLetters.discard(orgId(req), id, includeInbound(req), parsed.data.reason);
        await audit(req, 'failure.discard', `failure:${id}`);
        res.json({ discarded: true });
      } catch (err) {
        notFound(err);
      }
    }) satisfies RequestHandler,
  };
}
