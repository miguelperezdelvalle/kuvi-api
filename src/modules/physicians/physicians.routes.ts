import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuthenticatedUser } from '../../shared/auth/current-user.js';
import { DirectoryError } from './providers.js';
import { PhysicianDirectory } from './physicians.service.js';

const search = z.object({ query: z.string().trim().min(3).max(100),
  city: z.string().trim().max(100).default(''), specialty: z.string().trim().max(100).default('') }).strict();
const profile = z.object({ url: z.string().max(2000) }).strict();
export const physiciansRoutes: FastifyPluginAsync<{ directory?: PhysicianDirectory }> = async (app, options) => {
  const directory = options.directory ?? new PhysicianDirectory();
  const buckets = new Map<string, { since: number; count: number }>(); let inFlight = 0;
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ result: 'KO', code: 'INVALID_PARAMETERS' });
    if (error instanceof DirectoryError) return reply.code(error.status).send({ result: 'KO', code: error.code });
    return reply.send(error);
  });
  app.addHook('preHandler', async (request, reply) => {
    const actor = await requireAuthenticatedUser(request, reply); if (!actor) return;
    if (actor.status !== 'active' || !['patient','doctor'].includes(actor.role)) return reply.code(403).send({ result: 'KO', code: 'FORBIDDEN' });
    const now = Date.now();
    for (const [id, b] of buckets) if (now - b.since >= 60000) buckets.delete(id);
    const bucket = buckets.get(actor.id) ?? { since: now, count: 0 };
    if (bucket.count >= 20 || buckets.size >= 10000 && !buckets.has(actor.id))
      return reply.header('Retry-After', '60').code(429).send({ result: 'KO', code: 'SEARCH_RATE_LIMIT' });
    bucket.count++; buckets.set(actor.id, bucket);
  });
  async function run<T>(action: () => Promise<T>): Promise<T> {
    if (inFlight >= 8) throw new DirectoryError(503, 'SEARCH_BUSY');
    inFlight++;
    try { return await action(); } finally { inFlight--; }
  }
  // POST keeps search terms and profile links out of ordinary request URL logs.
  app.post('/search', { bodyLimit: 4096 }, async request => {
    const q = search.parse(request.body); return run(() => directory.search(q));
  });
  app.post('/profile', { bodyLimit: 4096 }, async request => {
    const p = profile.parse(request.body); return run(() => directory.profile(p.url));
  });
};
