import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ClinicalAccessError } from './clinical-access.service.js';

export function clinicalAccessErrors(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ClinicalAccessError) return reply.code(error.status).send({ result: 'KO', code: error.code });
  if (error instanceof z.ZodError) return reply.code(400).send({ result: 'KO', code: 'INVALID_PARAMETERS' });
  return reply.send(error);
}
