import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../shared/auth/current-user.js';
import { clinicalAccessErrors } from '../clinical-access/clinical-access.errors.js';
import { listGrantedPatients, paramsSchema, readPatient } from '../clinical-access/clinical-access.service.js';

export const doctorRoutes: FastifyPluginAsync = async app => {
  app.setErrorHandler(clinicalAccessErrors);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.get('/me', async (request, reply) => {
    const doctor = await requireRole(request, reply, 'doctor'); if (!doctor) return;
    return { result: 'OK', user: { id: doctor.id, username: doctor.username,
      role: 'doctor', clinicalApproved: true } };
  });
  app.get('/patients', async (request, reply) => {
    const doctor = await requireRole(request, reply, 'doctor'); if (!doctor) return;
    return listGrantedPatients(doctor.id, request.query);
  });
  for (const scope of ['summary', 'questionnaire', 'medical-history'] as const) {
    app.get(`/patients/:id/${scope}`, async (request, reply) => {
      const doctor = await requireRole(request, reply, 'doctor'); if (!doctor) return;
      const { id } = paramsSchema.parse(request.params);
      return readPatient(doctor.id, id, scope, request.query);
    });
  }
};
