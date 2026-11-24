import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes, createCipheriv, createHash } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { prisma } from '../dist/infrastructure/db/prisma.js';
import { documentsRoutes } from '../dist/modules/documents/documents.routes.js';
import { parseDocument, MAX_DOCUMENT_BODY } from '../dist/modules/documents/documents.service.js';

if (!process.env.DOCUMENT_TEST_SCHEMA?.startsWith('kuvi_docs_test_') ||
    new URL(process.env.DATABASE_URL).searchParams.get('schema') !== process.env.DOCUMENT_TEST_SCHEMA) {
  throw new Error('An isolated document test schema is mandatory');
}
const user = (data = {}) => prisma.user.create({ data: { username: randomUUID(), passwordHash: 'synthetic-not-a-login', ...data } });
const seal = (plain) => {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', randomBytes(32), nonce);
  const bytes = Buffer.concat([c.update(plain), c.final()]);
  return { nonce: nonce.toString('base64url'), ciphertext: bytes.toString('base64url'), tag: c.getAuthTag().toString('base64url') };
};
function payload(ownerId, documentId = randomUUID(), vaultId = 'synthetic-vault') {
  return Buffer.from(JSON.stringify({ format: 'kuvi-document', version: 1, ownerId, vaultId, documentId,
    key: seal(randomBytes(32)), metadata: seal(Buffer.from('Synthetic private patient name.pdf')),
    content: seal(Buffer.from('Synthetic private document data')) }));
}
const idOf = body => JSON.parse(body).documentId;
async function appFor(options = {}) {
  const app = Fastify();
  await app.register(jwt, { secret: 'isolated-documents-test-secret-key' });
  await app.register(documentsRoutes, { prefix: '/documents', ...options });
  await app.ready();
  return app;
}
const headers = (app, who, extra = {}) => ({ authorization: `Bearer ${app.jwt.sign({ sub: who.id })}`,
  'content-type': 'application/json', ...extra });
const upload = (app, who, body) => app.inject({ method: 'POST', url: `/documents/me/${idOf(body)}`,
  headers: headers(app, who), payload: body });

test('encrypted document backup', async t => {
  try {
    await t.test('authentication, active patient role and session checks run before accepting uploads', async () => {
      const app = await appFor(); const patient = await user();
      const doctor = await user({ role: 'doctor' }); const inactive = await user({ status: 'inactive' });
      try {
        assert.equal((await app.inject('/documents/me')).statusCode, 401);
        assert.equal((await app.inject({ url: '/documents/me', headers: headers(app, doctor) })).statusCode, 403);
        assert.equal((await app.inject({ url: '/documents/me', headers: headers(app, inactive) })).statusCode, 403);
        const invalid = app.jwt.sign({ sub: patient.id, sid: 'missing-session', tokenUse: 'access' });
        assert.equal((await app.inject({ url: '/documents/me', headers: { authorization: `Bearer ${invalid}` } })).statusCode, 401);
        assert.equal((await app.inject({ method: 'POST', url: '/documents/me/test',
          headers: { 'content-type': 'application/json' }, payload: 'not-json' })).statusCode, 401);
      } finally { await app.close(); }
    });

    await t.test('opaque bytes round-trip with exact digest and technical metadata only', async () => {
      const app = await appFor(); const owner = await user(); const other = await user();
      const body = payload(owner.id); const documentId = idOf(body);
      try {
        const response = await upload(app, owner, body);
        assert.equal(response.statusCode, 200); assert.equal(response.json().created, true);
        const digest = createHash('sha256').update(body).digest('hex');
        assert.equal(response.json().sha256, digest);
        const row = await prisma.documentBackup.findUnique({ where: { userId_documentId: { userId: owner.id, documentId } } });
        assert.ok(Buffer.from(row.content).equals(body));
        assert.equal(Buffer.from(row.content).includes(Buffer.from('Synthetic private patient name')), false);
        const downloaded = await app.inject({ url: `/documents/me/${documentId}`, headers: headers(app, owner) });
        assert.equal(downloaded.statusCode, 200); assert.ok(downloaded.rawPayload.equals(body));
        assert.equal(downloaded.headers.etag, `"${digest}"`);
        assert.equal(downloaded.headers['cache-control'], 'no-store');
        const summary = (await app.inject({ url: '/documents/me', headers: headers(app, owner) })).json();
        assert.equal(summary.count, 1); assert.equal(summary.usedBytes, body.length);
        assert.deepEqual(Object.keys(summary.items[0]).sort(), ['createdAt','documentId','sha256','sizeBytes'].sort());
        assert.equal((await app.inject({ url: '/documents/me', headers: headers(app, other) })).json().count, 0);
        assert.equal((await app.inject({ url: `/documents/me/${documentId}`, headers: headers(app, other) })).statusCode, 404);
      } finally { await app.close(); }
    });

    await t.test('simultaneous exact retries use one row and one quota allocation', async () => {
      const owner = await user(); const body = payload(owner.id);
      const app = await appFor({ quotaBytes: body.length, maxDocuments: 1 });
      try {
        const results = await Promise.all([upload(app, owner, body), upload(app, owner, body)]);
        assert.deepEqual(results.map(r => r.statusCode), [200,200]);
        assert.equal(results.filter(r => r.json().created).length, 1);
        const summary = (await app.inject({ url: '/documents/me', headers: headers(app, owner) })).json();
        assert.equal(summary.count, 1); assert.equal(summary.usedBytes, body.length);
        const conflict = await upload(app, owner, payload(owner.id,idOf(body)));
        assert.equal(conflict.statusCode,409); assert.equal(conflict.json().code,'DOCUMENT_BACKUP_CONFLICT');
        assert.ok(Buffer.from((await prisma.documentBackup.findFirst({ where:{userId:owner.id} })).content).equals(body));
      } finally { await app.close(); }
    });

    await t.test('concurrent different uploads cannot overspend count or byte quotas', async () => {
      for (const maxDocuments of [1,100]) {
        const owner = await user(); const a = payload(owner.id); const b = payload(owner.id);
        const app = await appFor({ maxDocuments, quotaBytes: maxDocuments === 1 ? 100000 : a.length + b.length - 1 });
        try {
          const replies = await Promise.all([upload(app,owner,a),upload(app,owner,b)]);
          assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,409]);
          assert.equal(replies.find(r=>r.statusCode===409).json().code,'DOCUMENT_QUOTA_EXCEEDED');
          assert.equal(await prisma.documentBackup.count({where:{userId:owner.id}}),1);
        } finally { await app.close(); }
      }
    });

    await t.test('strict envelopes reject names, keys, malformed base64, contexts and versions without echoing them', async () => {
      const app = await appFor(); const owner = await user();
      try {
        const original = JSON.parse(payload(owner.id));
        for (const mutation of [v=>v.name='Synthetic private name',v=>v.secret='must-not-be-uploaded',
          v=>v.recoveryCode='must-not-be-uploaded',v=>v.ownerId='other-owner',v=>v.documentId='other-document',
          v=>v.version=2,v=>v.key.ciphertext='AA==',v=>v.content.ciphertext='***',v=>v.content.nonce='',
          v=>v.metadata.title='Synthetic private name',v=>v.metadata.ciphertext='']) {
          const data = structuredClone(original); mutation(data);
          const reply = await app.inject({method:'POST',url:`/documents/me/${original.documentId}`,
            headers:headers(app,owner),payload:JSON.stringify(data)});
          assert.equal(reply.statusCode,400); assert.equal(reply.body.includes('Synthetic private name'),false);
        }
        assert.equal(await prisma.documentBackup.count({where:{userId:owner.id}}),0);
        const invalidUtf8 = await app.inject({method:'POST',url:'/documents/me/test',headers:headers(app,owner),payload:Buffer.from([255])});
        assert.equal(invalidUtf8.statusCode,400);
        const large = await app.inject({method:'POST',url:'/documents/me/test',headers:headers(app,owner),payload:'x'.repeat(MAX_DOCUMENT_BODY+1)});
        assert.equal(large.statusCode,413);
        // Failed parses release the upload slot instead of blocking the owner.
        assert.equal((await upload(app,owner,payload(owner.id))).statusCode,200);
      } finally { await app.close(); }
    });

    await t.test('ciphertext and metadata limits are checked independently', async () => {
      const owner = await user(); const data = JSON.parse(payload(owner.id));
      data.metadata.ciphertext = Buffer.alloc(4097).toString('base64url');
      assert.throws(()=>parseDocument(owner.id,data.documentId,Buffer.from(JSON.stringify(data))),e=>e.code==='INVALID_ENCRYPTED_DOCUMENT');
      data.metadata.ciphertext = Buffer.alloc(1).toString('base64url');
      data.content.ciphertext = Buffer.alloc(10*1024*1024+1).toString('base64url');
      assert.throws(()=>parseDocument(owner.id,data.documentId,Buffer.from(JSON.stringify(data))),e=>e.code==='INVALID_ENCRYPTED_DOCUMENT');
      data.content.ciphertext = Buffer.alloc(10*1024*1024).toString('base64url');
      assert.equal(parseDocument(owner.id,data.documentId,Buffer.from(JSON.stringify(data))).vaultId,data.vaultId);
    });

    await t.test('deletion is owner-scoped, hash-guarded and frees quota without switching the vault', async () => {
      const owner = await user(); const other = await user(); const body = payload(owner.id);
      const app = await appFor({maxDocuments:1});
      try {
        const saved = (await upload(app,owner,body)).json(); const documentId = idOf(body);
        const remove = (who,hash) => app.inject({method:'DELETE',url:`/documents/me/${documentId}`,headers:headers(app,who,{'if-match':hash})});
        assert.equal((await remove(other,saved.sha256)).json().deleted,false);
        assert.equal((await remove(owner,'0'.repeat(64))).statusCode,409);
        assert.equal((await remove(owner,`"${saved.sha256}"`)).json().deleted,true);
        assert.equal((await remove(owner,saved.sha256)).json().deleted,false);
        const summary = (await app.inject({url:'/documents/me',headers:headers(app,owner)})).json();
        assert.equal(summary.usedBytes,0); assert.equal(summary.count,0);
        const wrongVault = await upload(app,owner,payload(owner.id,randomUUID(),'another-vault'));
        assert.equal(wrongVault.statusCode,409); assert.equal(wrongVault.json().code,'DOCUMENT_VAULT_MISMATCH');
        assert.equal((await upload(app,owner,payload(owner.id))).statusCode,200);
      } finally { await app.close(); }
    });

    await t.test('pagination never returns blobs and is bounded to 50 records', async () => {
      const app = await appFor(); const owner = await user();
      try {
        for (let i=0;i<51;i++) assert.equal((await upload(app,owner,payload(owner.id,`document-${String(i).padStart(3,'0')}`))).statusCode,200);
        const first = (await app.inject({url:'/documents/me',headers:headers(app,owner)})).json();
        assert.equal(first.items.length,50); assert.equal(first.nextCursor,'document-049');
        const second = (await app.inject({url:`/documents/me?cursor=${first.nextCursor}`,headers:headers(app,owner)})).json();
        assert.equal(second.items.length,1); assert.equal(second.nextCursor,null);
      } finally { await app.close(); }
    });
  } finally { await prisma.$disconnect(); }
});
