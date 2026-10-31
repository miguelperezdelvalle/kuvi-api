import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../shared/auth/current-user.js';

export const patientsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    return {
      result: 'OK',
      patient: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        alias: user.patientProfile?.alias ?? null,
        sex: user.patientProfile?.sex ?? null,
        phone: user.patientProfile?.phone ?? null,
      },
    };
  });
};
