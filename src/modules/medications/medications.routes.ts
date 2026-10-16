import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../shared/auth/current-user.js';
import { applyMedicationOperation, getMedicationSnapshot, MedicationError } from './medications.service.js';

export const medicationsRoutes: FastifyPluginAsync = async app => {
  app.get('/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;
    return getMedicationSnapshot(user.id);
  });
  app.post('/me/operations', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;
    try { return await applyMedicationOperation(user.id, request.body); }
    catch (error) {
      if (error instanceof MedicationError) return reply.code(error.status).send({ result: 'KO', code: error.code, details: error.details });
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002')
        return reply.code(409).send({ result: 'KO', code: 'RECORD_ALREADY_EXISTS' });
      throw error;
    }
  });
};
