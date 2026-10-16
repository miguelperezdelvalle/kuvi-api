import { medicationsRoutes } from '../modules/medications/medications.routes.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { env } from './env.js';
import { prisma } from '../infrastructure/db/prisma.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { usersRoutes } from '../modules/users/users.routes.js';
import { patientsRoutes } from '../modules/patients/patients.routes.js';
import { questionnaireRoutes } from '../modules/questionnaire/questionnaire.routes.js';
import { medicalHistoryRoutes } from '../modules/medical-history/medical-history.routes.js';
import { sharingRoutes } from '../modules/sharing/sharing.routes.js';
import { summaryRoutes } from '../modules/summary/summary.routes.js';
import { doctorRoutes } from '../modules/doctor/doctor.routes.js';


async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
  });

  await app.register(helmet);

  await app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
      app: 'kuvi-api',
      env: env.APP_ENV,
    };
  });

  app.get('/db-health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      database: 'connected',
    };
  });

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(usersRoutes, { prefix: '/users' });
  await app.register(patientsRoutes, { prefix: '/patients' });
  await app.register(questionnaireRoutes, { prefix: '/questionnaire' });
  await app.register(medicalHistoryRoutes, { prefix: '/medical-history' });
  await app.register(sharingRoutes, { prefix: '/sharing' });
  await app.register(summaryRoutes, { prefix: '/summary' });
  await app.register(doctorRoutes, { prefix: '/doctor' });
  await app.register(medicationsRoutes, { prefix: '/medications' });
  return app;
}

async function main() {
  const app = await buildApp();

  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    });

    console.log(`Server running on http://${env.HOST}:${env.PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
