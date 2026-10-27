import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../shared/auth/current-user.js';
import { z } from 'zod';
import { id } from './appointments.schema.js';
import { AppointmentError, applyAppointmentOperation, getAppointment, listAppointments } from './appointments.service.js';

export const appointmentsRoutes: FastifyPluginAsync = async app => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppointmentError) return reply.code(error.status).send({ result: 'KO', code: error.code, details: error.details });
    if (error instanceof z.ZodError) return reply.code(400).send({ result: 'KO', code: 'INVALID_PARAMETERS' });
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') return reply.code(409).send({ result: 'KO', code: 'RECORD_ALREADY_EXISTS' });
    return reply.send(error);
  });
  for (const role of ['patient', 'doctor'] as const) {
    const base = role === 'patient' ? '/me' : '/doctor';
    app.get(base, async (request, reply) => {
      const actor = await requireRole(request, reply, role);
      if (!actor) return;
      if (actor.status !== 'active') return reply.code(403).send({ result: 'KO', code: 'INACTIVE_USER' });
      return listAppointments(actor, request.query);
    });
    const path = role === 'patient' ? '/me/:id' : '/doctor/:patientId/:id';
    app.get(path, async (request, reply) => {
      const actor = await requireRole(request, reply, role);
      if (!actor) return;
      if (actor.status !== 'active') return reply.code(403).send({ result: 'KO', code: 'INACTIVE_USER' });
      const p = z.object({ id, patientId: id.optional() }).parse(request.params);
      return getAppointment(actor, role === 'patient' ? actor.id : p.patientId!, p.id);
    });
    app.post(role === 'patient' ? '/me/operations' : '/doctor/:patientId/operations', { bodyLimit: 256 * 1024 }, async (request, reply) => {
      const actor = await requireRole(request, reply, role);
      if (!actor) return;
      const owner = role === 'patient' ? actor.id : z.object({ patientId: id }).parse(request.params).patientId;
      return applyAppointmentOperation(actor, owner, request.body);
    });
  }
};
