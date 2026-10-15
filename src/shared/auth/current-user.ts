import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../infrastructure/db/prisma.js';

type AuthPayload = {
  sub?: string;
  username?: string;
  role?: string;
};

export async function requireAuthenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({
      result: 'KO',
      message: 'Unauthorized',
    });
    return null;
  }

  const payload = request.user as AuthPayload;

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
    reply.code(404).send({
      result: 'KO',
      message: 'User not found',
    });
    return null;
  }

  return user;
}

export async function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedRole: 'patient' | 'doctor',
) {
  const user = await requireAuthenticatedUser(request, reply);

  if (!user) {
    return null;
  }

  if (user.role !== expectedRole) {
    reply.code(403).send({
      result: 'KO',
      message: 'Forbidden',
    });
    return null;
  }

  return user;
}
