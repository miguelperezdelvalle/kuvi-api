import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { AuthRateLimiter } from '../dist/modules/auth/auth.rate-limit.js';
import { authRoutes } from '../dist/modules/auth/auth.routes.js';
import { prisma } from '../dist/infrastructure/db/prisma.js';

test('authentication limits recover by time and remain bounded', () => {
  let now = 0;
  const limiter = new AuthRateLimiter(() => now, 3);
  for (let i = 0; i < 20; i++) assert.equal(limiter.ip('one', 'login'), 0);
  assert.equal(limiter.ip('one', 'login'), 900);
  for (let i = 0; i < 10; i++) assert.equal(limiter.account('  Test-User '), 0);
  assert.equal(limiter.account('test-user'), 900);
  assert.equal(limiter.ip('two', 'refresh'), 0);
  assert.equal(limiter.ip('three', 'login'), 60); // capacity cannot evict a blocked user
  now += 901000;
  assert.equal(limiter.ip('one', 'login'), 0);
  assert.equal(limiter.account('test-user'), 0);
});

test('auth HTTP limits precede credential work and ignore spoofed forwarding headers', async t => {
  const oldFind = prisma.user.findUnique;
  let reads = 0, now = Date.now();
  prisma.user.findUnique = async () => { reads++; return null; };
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: randomBytes(32).toString('hex') });
  await app.register(authRoutes, { prefix: '/auth', limiter: new AuthRateLimiter(() => now) });
  await app.ready();
  try {
    const req = (ip, username, headers = {}) => app.inject({ method: 'POST', url: '/auth/login',
      remoteAddress: ip, headers, payload: { username, password: 'synthetic-incorrect' } });
    await t.test('account quota spans different IPs without revealing account existence', async () => {
      for (let i = 0; i < 10; i++) assert.equal((await req(`10.0.0.${i+1}`, 'synthetic-user')).statusCode, 401);
      const before = reads, res = await req('10.0.1.1', 'synthetic-user');
      assert.equal(res.statusCode, 429);
      assert.equal(res.json().code, 'AUTH_RATE_LIMIT');
      assert.equal(Number(res.headers['retry-after']), 900);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(reads, before);
    });
    await t.test('IP quota cannot be bypassed by X-Forwarded-For or changing usernames', async () => {
      for (let i = 0; i < 20; i++) assert.equal((await req('10.2.0.1', `synthetic-${i}`,
        { 'x-forwarded-for': `10.9.0.${i+1}` })).statusCode, 401);
      const before = reads;
      assert.equal((await req('10.2.0.1', 'synthetic-more')).statusCode, 429);
      assert.equal(reads, before);
    });
    await t.test('window expiry restores access', async () => {
      now += 901000;
      assert.equal((await req('10.2.0.1', 'synthetic-user')).statusCode, 401);
    });
    await t.test('register and refresh quotas count malformed requests', async () => {
      for (const [path, limit] of [['register-patient', 10], ['refresh', 60]]) {
        for (let i = 0; i < limit; i++) {
          const res = await app.inject({ method: 'POST', url: `/auth/${path}`, remoteAddress: '10.3.0.1', payload: {} });
          assert.equal(res.statusCode, 400);
        }
        const res = await app.inject({ method: 'POST', url: `/auth/${path}`, remoteAddress: '10.3.0.1', payload: {} });
        assert.equal(res.statusCode, 429);
      }
    });
  } finally { await app.close(); prisma.user.findUnique = oldFind; await prisma.$disconnect(); }
});
