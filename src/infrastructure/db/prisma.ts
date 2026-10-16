import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { env } from '../../app/env.js';

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
}, { schema: new URL(env.DATABASE_URL).searchParams.get('schema') ?? 'public' });

export const prisma = new PrismaClient({
  adapter,
});
