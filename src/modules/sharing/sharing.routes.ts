import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import { requireRole } from '../../shared/auth/current-user.js';

const createShareSchema = z.object({
  label: z.string().trim().min(1).max(100),
  scope: z.string().trim().min(1).max(50).optional().default('summary'),
  expiresAt: z.string().datetime().optional(),
});

export const sharingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const shares = await prisma.sharedAccess.findMany({
      where: { ownerUserId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      result: 'OK',
      count: shares.length,
      value: shares.map((share) => ({
        id: share.id,
        label: share.label,
        shareToken: share.shareToken,
        scope: share.scope,
        active: share.active,
        expiresAt: share.expiresAt,
        createdAt: share.createdAt,
        updatedAt: share.updatedAt,
      })),
    };
  });

  app.post('/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const body = createShareSchema.parse(request.body);

    const token = randomBytes(24).toString('hex');

    const share = await prisma.sharedAccess.create({
      data: {
        ownerUserId: user.id,
        label: body.label,
        scope: body.scope,
        shareToken: token,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });

    return reply.code(201).send({
      result: 'OK',
      message: 'share created',
      share: {
        id: share.id,
        label: share.label,
        shareToken: share.shareToken,
        scope: share.scope,
        active: share.active,
        expiresAt: share.expiresAt,
      },
    });
  });

  app.patch('/me/:id/toggle', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const params = z
      .object({
        id: z.string().min(1),
      })
      .parse(request.params);

    const share = await prisma.sharedAccess.findFirst({
      where: {
        id: params.id,
        ownerUserId: user.id,
      },
    });

    if (!share) {
      return reply.code(404).send({
        result: 'KO',
        message: 'Share not found',
      });
    }

    const updated = await prisma.sharedAccess.update({
      where: { id: share.id },
      data: {
        active: !share.active,
      },
    });

    return {
      result: 'OK',
      message: 'share updated',
      share: {
        id: updated.id,
        label: updated.label,
        shareToken: updated.shareToken,
        scope: updated.scope,
        active: updated.active,
        expiresAt: updated.expiresAt,
      },
    };
  });
};
