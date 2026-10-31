import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../infrastructure/db/prisma.js';
import { env } from '../../app/env.js';

type AuthPayload = {
  sub?: string;
  username?: string;
  role?: string;
  sid?: string;
  tokenUse?: string;
  exp?: number;
  iat?: number;
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

  if (payload.sid !== undefined || payload.tokenUse !== undefined) {
    if (payload.tokenUse !== 'access' || typeof payload.sid !== 'string' ||
        typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
        typeof payload.sub !== 'string') {
      reply.code(401).send({ result: 'KO', code: 'INVALID_ACCESS_TOKEN', message: 'Sign in again' });
      return null;
    }
    const session = await prisma.authSession.findFirst({ where: {
      id: payload.sid, userId: payload.sub, revokedAt: null, expiresAt: { gt: new Date() },
    } });
    if (!session) {
      reply.code(401).send({ result: 'KO', code: 'SESSION_EXPIRED', message: 'Sign in again' });
      return null;
    }
  } else {
    // Old app versions retain their signed token only for a bounded transition.
    // Each legacy token expires no later than seven days after its original iat;
    // restarting the service cannot renew that window. It cannot be refreshed.
    const now = Date.now() / 1000;
    if (!env.AUTH_LEGACY_MAX_AGE_SECONDS || typeof payload.iat !== 'number' ||
        !Number.isFinite(payload.iat) || payload.iat > now + 60 ||
        now >= payload.iat + env.AUTH_LEGACY_MAX_AGE_SECONDS) {
      reply.code(401).send({ result: 'KO', code: 'SESSION_EXPIRED', message: 'Sign in again' });
      return null;
    }
  }

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

  if (user.status !== 'active') {
    reply.code(403).send({
      result: 'KO',
      code: 'INACTIVE_USER',
      message: 'Account is not active',
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
