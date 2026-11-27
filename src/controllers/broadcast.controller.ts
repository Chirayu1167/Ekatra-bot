import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../errors';
import { principal } from '../middleware/adminAuth';
import type { AdminAuthService } from '../services/adminAuth.service';
import type { BroadcastService } from '../services/broadcast.service';
import { BROADCAST_ENROLLMENT_STATUSES, MAX_BROADCAST_RECIPIENTS } from '../services/broadcast.service';
import { orgId } from './admin.controller';

const previewBody = z.object({
  audience: z.enum(['course', 'numbers', 'all_learners']).optional(),
  courseId: z.number().int().positive().optional(),
  statuses: z.array(z.enum(BROADCAST_ENROLLMENT_STATUSES)).max(BROADCAST_ENROLLMENT_STATUSES.length).optional(),
  message: z.string().trim().min(1).max(1024),
  phoneNumbers: z.array(z.string().max(64)).max(MAX_BROADCAST_RECIPIENTS).default([]),
});

function idParam(req: Request): number {
  const raw = req.params['id'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new NotFoundError('Broadcast not found');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new NotFoundError('Broadcast not found');
  return id;
}

export function createBroadcastController({
  broadcasts,
  auth,
}: {
  broadcasts: BroadcastService;
  auth: AdminAuthService;
}) {
  const audit = async (req: Request, action: string, target: string) => {
    const actor = principal(req);
    await auth.recordAudit(actor.userId, orgId(req), action, target);
  };

  return {
    preview: (async (req, res) => {
      const parsed = previewBody.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          `Provide a message (up to 1024 characters), choose who receives it, and keep manual numbers to ${MAX_BROADCAST_RECIPIENTS} or fewer.`,
        );
      }
      const actor = principal(req);
      const result = await broadcasts.preview({
        orgId: orgId(req),
        actorId: actor.userId,
        ...parsed.data,
      });
      await audit(
        req,
        'broadcast.preview',
        `broadcast:${result.id} accepted:${result.acceptedCount} rejected:${result.rejected.reduce((sum, item) => sum + item.count, 0)}`,
      );
      res.status(201).json(result);
    }) satisfies RequestHandler,

    audience: (async (req, res) => {
      const raw = req.query['courseId'];
      let courseId: number | undefined;
      if (typeof raw === 'string' && raw !== '') {
        if (!/^\d+$/.test(raw)) throw new BadRequestError('Invalid course');
        courseId = Number(raw);
      }
      res.json(await broadcasts.audienceCounts(orgId(req), courseId));
    }) satisfies RequestHandler,

    queue: (async (req, res) => {
      const result = await broadcasts.queue(orgId(req), idParam(req));
      await audit(
        req,
        'broadcast.queue',
        `broadcast:${idParam(req)} queued:${result.queuedCount} skipped:${result.skippedCount}`,
      );
      res.json({ queued: true, ...result });
    }) satisfies RequestHandler,

    status: (async (req, res) => {
      res.json(await broadcasts.status(orgId(req), idParam(req)));
    }) satisfies RequestHandler,
  };
}
