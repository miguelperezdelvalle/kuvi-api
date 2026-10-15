import type { FastifyPluginAsync } from 'fastify';
import { requireAuthenticatedUser } from '../../shared/auth/current-user.js';

export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request, reply) => {
    const user = await requireAuthenticatedUser(request, reply);
    if (!user) return;

    return {
      result: 'OK',
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        phone: user.patientProfile?.phone ?? null,
        sex: user.patientProfile?.sex ?? null,
      },
    };
  });
};
