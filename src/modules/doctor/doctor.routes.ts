import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../shared/auth/current-user.js';

export const doctorRoutes: FastifyPluginAsync = async (app) => {
  // SharedAccess has no recipient identity and cannot authorize a particular
  // doctor. Do not infer consent from a role, directory entry or appointment.
  // Appointment-scoped routes retain their own authorization checks.
  for (const path of ['/patients', '/patients/:id/summary']) {
    app.get(path, async (request, reply) => {
      const doctor = await requireRole(request, reply, 'doctor');
      if (!doctor) return;
      return reply.code(403).send({
        result: 'KO', code: 'PATIENT_ACCESS_NOT_CONFIGURED',
        message: 'Explicit patient authorization is required',
      });
    });
  }
};
