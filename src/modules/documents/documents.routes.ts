import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireRole } from '../../shared/auth/current-user.js';
import { DocumentError, type DocumentLimits, documentLimits, MAX_DOCUMENT_BODY,
  putDocument, getDocument, listDocuments, deleteDocument } from './documents.service.js';

export const documentsRoutes: FastifyPluginAsync<Partial<DocumentLimits>> = async (app, options) => {
  const limits = documentLimits(options);
  const owners = new WeakMap<FastifyRequest, string>();
  const slots = new WeakSet<FastifyRequest>();
  const perUser = new Map<string, number>();
  let inFlight = 0;
  const release = (request: FastifyRequest) => {
    if (!slots.delete(request)) return;
    inFlight--;
    const owner = owners.get(request)!;
    const remaining = (perUser.get(owner) ?? 1) - 1;
    if (remaining === 0) perUser.delete(owner); else perUser.set(owner, remaining);
  };
  app.addHook('onRequest', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;
    owners.set(request, user.id);
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'POST') {
      const count = perUser.get(user.id) ?? 0;
      if (inFlight >= 4 || count >= 2) {
        return reply.code(429).header('Retry-After', '5').send({ result: 'KO', code: 'DOCUMENT_BACKUP_BUSY',
          message: 'Hay respaldos en curso. Espera unos segundos y vuelve a intentar.' });
      }
      inFlight++; perUser.set(user.id, count + 1); slots.add(request);
    }
  });
  app.addHook('onResponse', async request => { release(request); });
  app.addHook('onError', async request => { release(request); });
  app.addHook('onRequestAbort', async request => { release(request); });
  // Preserve the exact ciphertext bytes for checksums and idempotent retries.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const failure = (error: unknown) => {
    if (error instanceof DocumentError) return { status: error.status,
      body: { result: 'KO', code: error.code, message: error.message } };
    throw error;
  };
  app.get('/me', async (request, reply) => {
    try { return await listDocuments(owners.get(request)!, (request.query as { cursor?: string }).cursor, limits); }
    catch (error) { const e = failure(error); return reply.code(e.status).send(e.body); }
  });
  app.post('/me/:id', { bodyLimit: MAX_DOCUMENT_BODY }, async (request, reply) => {
    try { return await putDocument(owners.get(request)!, (request.params as { id: string }).id, request.body, limits); }
    catch (error) { const e = failure(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/me/:id', async (request, reply) => {
    try {
      const row = await getDocument(owners.get(request)!, (request.params as { id: string }).id);
      return reply.type('application/json').header('ETag', `"${row.sha256}"`).send(Buffer.from(row.content));
    } catch (error) { const e = failure(error); return reply.code(e.status).send(e.body); }
  });
  app.delete('/me/:id', async (request, reply) => {
    try { return await deleteDocument(owners.get(request)!, (request.params as { id: string }).id, request.headers['if-match']); }
    catch (error) { const e = failure(error); return reply.code(e.status).send(e.body); }
  });
};
