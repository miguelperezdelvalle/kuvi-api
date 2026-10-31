import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import { requireAuthenticatedUser } from '../../shared/auth/current-user.js';

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

export const authRoutes: FastifyPluginAsync = async (app) => {
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

    const token = await reply.jwtSign({
      sub: user.id,
      username: user.username,
      role: user.role,
    });

    return reply.code(201).send({
      result: 'OK',
      message: 'registered',
      token,
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

    const token = await reply.jwtSign({
      sub: user.id,
      username: user.username,
      role: user.role,
    });

    return {
      result: 'OK',
      message: 'login ok',
      token,
      user: buildUserResponse(user),
    };
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
