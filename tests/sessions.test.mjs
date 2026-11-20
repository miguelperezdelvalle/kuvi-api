import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { prisma } from '../dist/infrastructure/db/prisma.js';
import { authRoutes } from '../dist/modules/auth/auth.routes.js';
import { usersRoutes } from '../dist/modules/users/users.routes.js';
import { refreshHash } from '../dist/modules/auth/auth.sessions.js';
import { env } from '../dist/app/env.js';

if (!process.env.SESSION_TEST_SCHEMA?.startsWith('kuvi_sessions_test_') ||
    new URL(process.env.DATABASE_URL).searchParams.get('schema') !== process.env.SESSION_TEST_SCHEMA)
  throw Error('A disposable session-test schema is required');

test('persistent sessions rotate, expire and revoke across instances', async t => {
  const password = randomBytes(20).toString('hex');
  const user = await prisma.user.create({ data: { username: randomUUID().replaceAll('-', ''), passwordHash: await bcrypt.hash(password, 4) } });
  const other = await prisma.user.create({ data: { username: randomUUID().replaceAll('-', ''), passwordHash: 'unused' } });
  const secret = randomBytes(32).toString('hex');
  const build = async () => {
    const app = Fastify({ logger: false });
    await app.register(jwt, { secret });
    // Rate limiting has a dedicated suite; concurrent session tests must not
    // exhaust quotas needed by later transaction scenarios.
    await app.register(authRoutes, { prefix: '/auth', limiter: { ip: () => 0, account: () => 0 } });
    await app.register(usersRoutes, { prefix: '/users' });
    await app.ready(); return app;
  };
  const app = await build(), second = await build();
  const login = async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: user.username, password } });
    assert.equal(res.statusCode, 200); return res.json();
  };
  const post = (path, refreshToken, server = app) => server.inject({ method: 'POST', url: `/auth/${path}`, payload: { refreshToken } });
  const me = (token, server = app) => server.inject({ url: '/users/me', headers: { authorization: `Bearer ${token}` } });
  try {
    await t.test('registration rejects identity fields before creating a patient', async () => {
      const before = await prisma.user.count();
      for (const field of ['userName', 'secondName', 'lastName', 'firstName',
        'fullName', 'name', 'nombre', 'nombres', 'apellidos']) {
        const res = await app.inject({
          method: 'POST', url: '/auth/register-patient',
          payload: {
            username: randomUUID().replaceAll('-', ''), password,
            [field]: 'Synthetic private identity',
          },
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().code, 'PATIENT_IDENTITY_NOT_ALLOWED');
        assert.equal(res.body.includes('Synthetic private identity'), false);
      }
      assert.equal(await prisma.user.count(), before);
    });
    await t.test('patient registration persists a usable session and hashed refresh credential', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/register-patient', payload: {
        username: randomUUID().replaceAll('-', ''), password, role: 'doctor',
      } });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().user.role, 'patient');
      assert.equal((await me(res.json().token)).statusCode, 200);
      assert.ok(await prisma.authRefreshToken.findUnique({ where: { tokenHash: refreshHash(res.json().refreshToken) } }));
    });
    await t.test('access lifetime is exact; only hashes persist; session works in another instance', async () => {
      const body = await login(), claims = app.jwt.verify(body.token);
      assert.equal(claims.exp - claims.iat, env.AUTH_ACCESS_TTL_SECONDS);
      assert.equal(body.expiresIn, env.AUTH_ACCESS_TTL_SECONDS);
      assert.equal(claims.tokenUse, 'access');
      const row = await prisma.authRefreshToken.findUnique({ where: { tokenHash: refreshHash(body.refreshToken) } });
      assert.equal(row.sessionId, claims.sid);
      assert.equal(JSON.stringify(row).includes(body.refreshToken), false);
      assert.equal((await me(body.token, second)).statusCode, 200);
    });
    await t.test('rotation needs no access JWT and preserves the absolute session deadline', async () => {
      const before = await login();
      const res = await post('refresh', before.refreshToken, second);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      const after = res.json();
      assert.notEqual(after.refreshToken, before.refreshToken);
      assert.equal(after.refreshExpiresAt, before.refreshExpiresAt);
      assert.equal((await me(after.token)).statusCode, 200);
      assert.equal((await me(before.token)).statusCode, 200);
    });
    await t.test('replaying a used refresh token commits family revocation', async () => {
      const first = await login(), next = (await post('refresh', first.refreshToken)).json();
      assert.equal((await post('refresh', first.refreshToken)).statusCode, 401);
      assert.equal((await me(next.token)).statusCode, 401);
      assert.equal((await post('refresh', next.refreshToken)).statusCode, 401);
      assert.ok((await prisma.authSession.findUnique({ where: { id: app.jwt.decode(next.token).sid } })).revokedAt);
    });
    await t.test('logout is idempotent and revokes access immediately without affecting another session', async () => {
      const one = await login(), two = await login();
      assert.equal((await post('logout', one.refreshToken)).statusCode, 200);
      assert.equal((await post('logout', one.refreshToken, second)).statusCode, 200);
      assert.equal((await me(one.token)).statusCode, 401);
      assert.equal((await post('refresh', one.refreshToken)).statusCode, 401);
      assert.equal((await me(two.token)).statusCode, 200);
      assert.equal((await post('logout', randomBytes(32).toString('base64url'))).statusCode, 200);
    });
    await t.test('concurrent refresh cannot create two valid token branches', async () => {
      const body = await login();
      const results = await Promise.all([post('refresh', body.refreshToken), post('refresh', body.refreshToken, second)]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 401]);
      const accepted = results.find(r => r.statusCode === 200).json();
      assert.equal((await me(accepted.token)).statusCode, 401);
    });
    await t.test('logout racing refresh leaves the session revoked', async () => {
      const body = await login();
      const results = await Promise.all([post('refresh', body.refreshToken), post('logout', body.refreshToken, second)]);
      assert.equal(results[1].statusCode, 200);
      assert.ok([200, 401].includes(results[0].statusCode));
      if (results[0].statusCode === 200) assert.equal((await me(results[0].json().token)).statusCode, 401);
      assert.equal((await me(body.token)).statusCode, 401);
    });
    await t.test('absolute expiry denies access and refresh', async () => {
      const body = await login();
      await prisma.authSession.update({ where: { id: app.jwt.decode(body.token).sid }, data: { expiresAt: new Date(1) } });
      assert.equal((await me(body.token)).statusCode, 401);
      assert.equal((await post('refresh', body.refreshToken)).statusCode, 401);
    });
    await t.test('deactivation blocks refresh, access and new login', async () => {
      const body = await login();
      await prisma.user.update({ where: { id: user.id }, data: { status: 'inactive' } });
      try {
        assert.equal((await me(body.token)).statusCode, 403);
        assert.equal((await post('refresh', body.refreshToken)).statusCode, 401);
        assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { username: user.username, password } })).statusCode, 403);
      } finally { await prisma.user.update({ where: { id: user.id }, data: { status: 'active' } }); }
    });
    await t.test('wrong subject, wrong token use, missing expiry and expired access are rejected', async () => {
      const body = await login(), claims = app.jwt.decode(body.token);
      for (const payload of [{ ...claims, sub: other.id }, { ...claims, tokenUse: 'refresh' },
        { sub: user.id, sid: claims.sid, tokenUse: 'access' }, { ...claims, exp: 1 }]) {
        assert.equal((await me(app.jwt.sign(payload))).statusCode, 401);
      }
      assert.equal((await me(body.refreshToken)).statusCode, 401);
    });
    await t.test('unknown tokens and malformed refresh/logout requests reveal no credentials', async () => {
      const unknown = randomBytes(32).toString('base64url');
      const res = await post('refresh', unknown);
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.stringify(res.json()).includes(unknown), false);
      for (const path of ['refresh', 'logout']) {
        assert.equal((await post(path, 'bad')).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/auth/${path}`, payload: {} })).statusCode, 400);
      }
    });
    await t.test('legacy acceptance is bounded by original issue time and cannot renew', async () => {
      const now = Math.floor(Date.now() / 1000);
      const current = app.jwt.sign({ sub: user.id, iat: now });
      assert.equal((await me(current)).statusCode, env.AUTH_LEGACY_MAX_AGE_SECONDS ? 200 : 401);
      const old = app.jwt.sign({ sub: user.id, iat: now - 7 * 86400 - 1 });
      assert.equal((await me(old)).statusCode, 401);
      assert.equal((await me(app.jwt.sign({ sub: user.id, iat: now + 120 }))).statusCode, 401);
      assert.equal((await post('refresh', current)).statusCode, 400);
    });
  } finally { await app.close(); await second.close(); await prisma.$disconnect(); }
});
