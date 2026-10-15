import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../infrastructure/db/prisma.js';

export const patientsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({
        result: 'KO',
        message: 'Unauthorized',
      });
    }

    const payload = request.user as {
      sub?: string;
      username?: string;
      role?: string;
    };

    const user = payload.sub
      ? await prisma.user.findUnique({
          where: { id: payload.sub },
          include: {
            patientProfile: true,
          },
        })
      : payload.username
        ? await prisma.user.findUnique({
            where: { username: payload.username },
            include: {
              patientProfile: true,
            },
          })
        : null;

    if (!user) {
      return reply.code(404).send({
        result: 'KO',
        message: 'Patient not found',
      });
    }

    if (user.role !== 'patient') {
      return reply.code(403).send({
        result: 'KO',
        message: 'Forbidden',
      });
    }

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
