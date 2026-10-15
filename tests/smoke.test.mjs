import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

// Launch the built application on a free, loopback-only port. No database writes.
test('compiled server starts and protects patient endpoints', { timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, ['dist/app/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  child.stderr.resume();
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const { msg } = JSON.parse(line);
            const match = typeof msg === 'string' && msg.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
          } catch { /* Ignore non-JSON startup messages. */ }
        }
      });
    });
    const get = (path, headers = {}) => fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5000) });
    await t.test('health', async () => {
      const response = await get('/health');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'ok');
    });
    for (const path of ['/users/me', '/patients/me', '/medical-history/me', '/summary/me']) {
      await t.test(`${path} rejects missing and invalid JWT`, async () => {
        for (const headers of [{}, { Authorization: 'Bearer invalid-token' }]) {
          const response = await get(path, headers);
          assert.equal(response.status, 401);
          assert.equal((await response.json()).result, 'KO');
        }
      });
    }
    if (process.env.RUN_DB_HEALTH === '1') {
      await t.test('database responds to a read-only health check', async () => {
        const response = await get('/db-health');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).database, 'connected');
      });
    }
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(timer); }
  }
});

test('/users/me preserves profile and authentication responses', async (t) => {
  const { default: Fastify } = await import('fastify');
  const { default: jwt } = await import('@fastify/jwt');
  const { prisma } = await import('../dist/infrastructure/db/prisma.js');
  const { usersRoutes } = await import('../dist/modules/users/users.routes.js');
  const app = Fastify({ logger: false });
  const originalFind = prisma.user.findUnique;
  const queries = [];
  const user = { id: 'test-user', username: 'test-patient', role: 'patient', status: 'active',
    passwordHash: 'must-not-be-returned', patientProfile: { phone: '5550000000', sex: 'H' } };
  prisma.user.findUnique = async (query) => {
    queries.push(query);
    return query.where.id === 'missing' ? null : user;
  };
  try {
    await app.register(jwt, { secret: 'isolated-test-secret-not-for-production' });
    await app.register(usersRoutes, { prefix: '/users' });
    await app.ready();
    for (const payload of [{ sub: user.id }, { username: user.username }]) {
      await t.test(`profile lookup by ${Object.keys(payload)[0]}`, async () => {
        const response = await app.inject({ method: 'GET', url: '/users/me',
          headers: { authorization: `Bearer ${app.jwt.sign(payload)}` } });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { result: 'OK', user: {
          id: user.id, username: user.username, role: 'patient', status: 'active', phone: '5550000000', sex: 'H',
        } });
        assert.deepEqual(queries.at(-1), { where: payload.sub ? { id: payload.sub } : { username: payload.username },
          include: { patientProfile: true } });
      });
    }
    await t.test('unknown user remains 404', async () => {
      const response = await app.inject({ method: 'GET', url: '/users/me',
        headers: { authorization: `Bearer ${app.jwt.sign({ sub: 'missing' })}` } });
      assert.equal(response.statusCode, 404);
    });
    await t.test('missing token does not query database', async () => {
      const count = queries.length;
      const response = await app.inject({ method: 'GET', url: '/users/me' });
      assert.equal(response.statusCode, 401);
      assert.equal(queries.length, count);
    });
    await t.test('missing profile still returns null fields', async () => {
      user.patientProfile = null;
      const response = await app.inject({ method: 'GET', url: '/users/me',
        headers: { authorization: `Bearer ${app.jwt.sign({ sub: user.id })}` } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().user.phone, null);
      assert.equal(response.json().user.sex, null);
    });
  } finally {
    prisma.user.findUnique = originalFind;
    await app.close();
    await prisma.$disconnect();
  }
});
