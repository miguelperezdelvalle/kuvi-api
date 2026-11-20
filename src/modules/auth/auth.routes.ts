import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import { requireAuthenticatedUser } from '../../shared/auth/current-user.js';
import { env } from '../../app/env.js';
import { AuthSessions } from './auth.sessions.js';
import { AuthRateLimiter, type AuthCategory } from './auth.rate-limit.js';

const registerSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(6).max(72),
  phone: z.string().trim().max(32).optional().default(''),
  sex: z.enum(['H', 'M']).optional().default('H'),
});

const loginSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(6).max(72),
});
const refreshSchema = z.object({ refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

function buildUserResponse(user: {
  id: string;
  username: string;
  role: string;
}) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

type Options = { sessions?: Pick<AuthSessions, 'create' | 'rotate' | 'revoke'>; limiter?: AuthRateLimiter };
export const authRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const sessions = options.sessions ?? new AuthSessions();
  const limiter = options.limiter ?? new AuthRateLimiter();
  const rateLimit = (reply: FastifyReply, seconds: number) => reply.header('Retry-After', seconds)
    .code(429).send({ result: 'KO', code: 'AUTH_RATE_LIMIT', message: 'Try again later' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    if (request.method !== 'POST') return;
    const path = request.routeOptions.url ?? '';
    const category: AuthCategory = path.endsWith('/login') ? 'login' :
      path.endsWith('/refresh') ? 'refresh' : path.endsWith('/logout') ? 'logout' : 'register';
    const retry = limiter.ip(request.ip, category);
    if (retry) return rateLimit(reply, retry);
  });
  app.addHook('preValidation', async (request, reply) => {
    if (!request.routeOptions.url?.endsWith('/login')) return;
    const username = (request.body as { username?: unknown } | null)?.username;
    if (typeof username !== 'string' || username.length > 32) return;
    const retry = limiter.account(username);
    if (retry) return rateLimit(reply, retry);
  });
  const issue = async (reply: FastifyReply, user: { id: string; username: string; role: string },
    session: { id: string; refreshToken: string; expiresAt: Date }) => ({
    token: await reply.jwtSign({ sub: user.id, username: user.username, role: user.role,
      sid: session.id, tokenUse: 'access' }, { sign: { expiresIn: `${env.AUTH_ACCESS_TTL_SECONDS}s` } }),
    tokenType: 'Bearer', expiresIn: env.AUTH_ACCESS_TTL_SECONDS,
    refreshToken: session.refreshToken, refreshExpiresAt: session.expiresAt.toISOString(),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        result: 'KO', code: 'INVALID_PARAMETERS', message: 'Invalid parameters',
      });
    }
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return reply.code(409).send({ result: 'KO', message: 'Username already exists' });
    }
    return reply.send(error);
  });

  app.post('/register-patient', async (request, reply) => {
    const identityFields = new Set([
      'userName', 'secondName', 'lastName', 'firstName', 'fullName',
      'name', 'nombre', 'nombres', 'apellidos',
    ]);
    if (request.body && typeof request.body === 'object' &&
        Object.keys(request.body).some(key => identityFields.has(key))) {
      return reply.code(400).send({
        result: 'KO', code: 'PATIENT_IDENTITY_NOT_ALLOWED',
        message: 'Actualiza Kuvi para crear una cuenta con protección de identidad.',
      });
    }
    const body = registerSchema.parse(request.body);

    const existingUser = await prisma.user.findUnique({
      where: { username: body.username },
    });

    if (existingUser) {
      return reply.code(409).send({
        result: 'KO',
        message: 'Username already exists',
      });
    }

    const passwordHash = await bcrypt.hash(body.password, 10);

    const user = await prisma.user.create({
      data: {
        username: body.username,
        passwordHash,
        role: 'patient',
        status: 'active',
        patientProfile: {
          create: {
            alias: null,
            sex: body.sex,
            phone: body.phone || null,
          },
        },
      },
    });

    const tokens = await issue(reply, user, await sessions.create(user.id));

    return reply.code(201).send({
      result: 'OK',
      message: 'registered',
      ...tokens,
      user: buildUserResponse(user),
    });
  });

  // Public registration must never grant a clinical role. Re-enable only
  // through a reviewed onboarding workflow, never a caller-supplied role.
  app.post('/register-doctor', async (_request, reply) => {
    return reply.code(403).send({
      result: 'KO',
      code: 'DOCTOR_REGISTRATION_DISABLED',
      message: 'Doctor registration requires an approved onboarding workflow',
    });
  });

  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { username: body.username },
    });

    if (!user) {
      return reply.code(401).send({
        result: 'KO',
        message: 'Invalid credentials',
      });
    }

    const passwordOk = await bcrypt.compare(body.password, user.passwordHash);

    if (!passwordOk) {
      return reply.code(401).send({
        result: 'KO',
        message: 'Invalid credentials',
      });
    }

    if (user.status !== 'active') {
      return reply.code(403).send({
        result: 'KO',
        code: 'INACTIVE_USER',
        message: 'Account is not active',
      });
    }

    const tokens = await issue(reply, user, await sessions.create(user.id));

    return {
      result: 'OK',
      message: 'login ok',
      ...tokens,
      user: buildUserResponse(user),
    };
  });

  app.post('/refresh', async (request, reply) => {
    const { refreshToken } = refreshSchema.parse(request.body);
    const session = await sessions.rotate(refreshToken);
    if (!session) return reply.code(401).send({ result: 'KO', code: 'INVALID_REFRESH_TOKEN', message: 'Sign in again' });
    return { result: 'OK', message: 'session renewed',
      ...await issue(reply, session.user, session), user: buildUserResponse(session.user) };
  });

  app.post('/logout', async (request, reply) => {
    const { refreshToken } = refreshSchema.parse(request.body);
    await sessions.revoke(refreshToken);
    return { result: 'OK', message: 'session closed' };
  });

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
