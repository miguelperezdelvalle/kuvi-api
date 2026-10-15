import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';

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

type AuthPayload = {
  sub?: string;
  username?: string;
  role?: string;
};

async function findCurrentUser(payload: AuthPayload) {
  if (payload.sub) {
    return prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        patientProfile: true,
      },
    });
  }

  if (payload.username) {
    return prisma.user.findUnique({
      where: { username: payload.username },
      include: {
        patientProfile: true,
      },
    });
  }

  return null;
}

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

  app.post('/register-doctor', async (request, reply) => {
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
        role: 'doctor',
        status: 'active',
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
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({
        result: 'KO',
        message: 'Unauthorized',
      });
    }

    const payload = request.user as AuthPayload;
    const user = await findCurrentUser(payload);

    if (!user) {
      return reply.code(404).send({
        result: 'KO',
        message: 'User not found',
      });
    }

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
