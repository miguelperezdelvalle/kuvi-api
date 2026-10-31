import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { prisma } from '../dist/infrastructure/db/prisma.js';
import { authRoutes } from '../dist/modules/auth/auth.routes.js';
import { usersRoutes } from '../dist/modules/users/users.routes.js';
import { patientsRoutes } from '../dist/modules/patients/patients.routes.js';
import { doctorRoutes } from '../dist/modules/doctor/doctor.routes.js';
import { medicationsRoutes } from '../dist/modules/medications/medications.routes.js';
import { appointmentsRoutes } from '../dist/modules/appointments/appointments.routes.js';
import { questionnaireRoutes } from '../dist/modules/questionnaire/questionnaire.routes.js';
import { medicalHistoryRoutes } from '../dist/modules/medical-history/medical-history.routes.js';
import { sharingRoutes } from '../dist/modules/sharing/sharing.routes.js';
import { summaryRoutes } from '../dist/modules/summary/summary.routes.js';
import { physiciansRoutes } from '../dist/modules/physicians/physicians.routes.js';

test('clinical access containment and account status use synthetic in-memory data', async t => {
  const password = randomBytes(20).toString('hex');
  const passwordHash = await bcrypt.hash(password, 4);
  const users = new Map([
    ['patient', { id: 'patient', username: 'synthetic-patient', role: 'patient', status: 'active',
      passwordHash, patientProfile: { alias: null, sex: 'M', phone: null } }],
    ['doctor', { id: 'doctor', username: 'synthetic-doctor', role: 'doctor', status: 'active',
      passwordHash, patientProfile: null }],
    ['inactive', { id: 'inactive', username: 'synthetic-inactive', role: 'patient', status: 'inactive',
      passwordHash, patientProfile: null }],
    ['inactive-doctor', { id: 'inactive-doctor', username: 'synthetic-inactive-doctor',
      role: 'doctor', status: 'inactive', passwordHash, patientProfile: null }],
  ]);
  const originals = [];
  const replace = (model, method, value) => {
    originals.push([prisma[model], method, prisma[model][method]]);
    prisma[model][method] = value;
  };
  let lookups = 0, writes = 0, createData;
  replace('user', 'findUnique', async ({ where }) => {
    lookups++;
    return where.id ? users.get(where.id) ?? null :
      [...users.values()].find(u => u.username === where.username) ?? null;
  });
  replace('user', 'create', async ({ data }) => {
    writes++;
    createData = data;
    if (data.username === 'synthetic-race') throw Object.assign(new Error('duplicate'), { code: 'P2002' });
    return { id: 'created-patient', ...data };
  });
  // Denied routes must stop before inspecting a patient collection or clinical
  // records. Any accidental attempt fails instead of touching the real database.
  const clinicalAccess = () => { throw new Error('Forbidden clinical database access in test'); };
  for (const [model, methods] of Object.entries({
    user: ['findMany'], questionnaireAnswer: ['count', 'findFirst', 'findMany', 'upsert'],
    medicalHistoryNote: ['count', 'findFirst', 'findMany', 'create'],
    sharedAccess: ['count', 'findMany', 'create', 'findFirst'],
    appointment: ['findFirst', 'findMany'], physician: ['findMany'],
  })) for (const method of methods) replace(model, method, clinicalAccess);
  // The only medication paths exercised below are rejected by authentication.
  // Fail closed if a regression ever reaches a transaction.
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = clinicalAccess;
  const app = Fastify({ logger: false });
  try {
    await app.register(jwt, { secret: randomBytes(32).toString('hex') });
    for (const [routes, prefix] of [
      [authRoutes, '/auth'], [usersRoutes, '/users'], [patientsRoutes, '/patients'],
      [doctorRoutes, '/doctor'], [medicationsRoutes, '/medications'],
      [appointmentsRoutes, '/appointments'], [questionnaireRoutes, '/questionnaire'],
      [medicalHistoryRoutes, '/medical-history'], [sharingRoutes, '/sharing'],
      [summaryRoutes, '/summary'], [physiciansRoutes, '/physicians'],
    ]) await app.register(routes, { prefix, ...(routes === authRoutes ? { sessions: {
      create: async () => ({ id: 'synthetic-session', refreshToken: randomBytes(32).toString('base64url'),
        expiresAt: new Date(Date.now() + 86400000) }),
      rotate: async () => null, revoke: async () => {},
    } } : {}) });
    await app.ready();
    const req = (actor, method, url, payload, claims = {}) => app.inject({ method, url, payload,
      headers: actor ? { authorization: `Bearer ${app.jwt.sign({ sub: actor, ...claims })}` } : {} });

    await t.test('public doctor registration never looks up users or creates accounts', async () => {
      const before = [lookups, writes];
      for (const actor of [null, 'patient', 'doctor']) {
        const res = await req(actor, 'POST', '/auth/register-doctor', { username: 'synthetic-new', password });
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().code, 'DOCTOR_REGISTRATION_DISABLED');
        assert.equal(res.json().token, undefined);
      }
      assert.deepEqual([lookups, writes], before);
    });
    for (const path of ['/doctor/patients', '/doctor/patients/synthetic-target/summary']) {
      await t.test(`${path} denies anonymous, wrong role and forged token role`, async () => {
        assert.equal((await req(null, 'GET', path)).statusCode, 401);
        assert.equal((await req('patient', 'GET', path)).statusCode, 403);
        assert.equal((await req('patient', 'GET', path, undefined, { role: 'doctor' })).statusCode, 403);
      });
      await t.test(`${path} denies active doctors without querying patient data`, async () => {
        const res = await req('doctor', 'GET', path);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().code, 'PATIENT_ACCESS_NOT_CONFIGURED');
        assert.equal(res.json().value, undefined);
        assert.equal(res.json().patient, undefined);
      });
    }
    await t.test('login and registration validation errors are 400 and do not reach persistence', async () => {
      const before = [lookups, writes];
      for (const url of ['/auth/login', '/auth/register-patient']) {
        for (const payload of [{}, { username: [], password }, { username: 'ok', password: 'bad' }]) {
          const res = await req(null, 'POST', url, payload);
          assert.equal(res.statusCode, 400);
          assert.equal(res.json().code, 'INVALID_PARAMETERS');
          assert.equal(JSON.stringify(res.json()).includes(password), false);
        }
      }
      assert.deepEqual([lookups, writes], before);
    });
    await t.test('patient registration preserves response and cannot choose a clinical role', async () => {
      const res = await req(null, 'POST', '/auth/register-patient', {
        username: 'synthetic-new-patient', password, role: 'doctor', status: 'active',
      });
      assert.equal(res.statusCode, 201);
      assert.equal(createData.role, 'patient');
      assert.equal(createData.status, 'active');
      assert.equal(await bcrypt.compare(password, createData.passwordHash), true);
      assert.equal(res.json().user.role, 'patient');
      assert.equal(app.jwt.verify(res.json().token).sub, 'created-patient');
      assert.equal(res.json().user.passwordHash, undefined);
    });
    await t.test('duplicate and concurrent registration retain 409', async () => {
      for (const username of ['synthetic-patient', 'synthetic-race']) {
        const res = await req(null, 'POST', '/auth/register-patient', { username, password });
        assert.equal(res.statusCode, 409);
        assert.equal(res.json().token, undefined);
      }
    });
    await t.test('valid active patient and doctor login contracts remain compatible', async () => {
      for (const id of ['patient', 'doctor']) {
        const user = users.get(id);
        const res = await req(null, 'POST', '/auth/login', { username: user.username, password });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json().user, { id, username: user.username, role: user.role });
        assert.equal(app.jwt.verify(res.json().token).sub, id);
        assert.equal(res.json().passwordHash, undefined);
      }
    });
    await t.test('inactive login refuses tokens; wrong credentials stay indistinguishable', async () => {
      for (const id of ['inactive', 'inactive-doctor']) {
        const username = users.get(id).username;
        const res = await req(null, 'POST', '/auth/login', { username, password });
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().code, 'INACTIVE_USER');
        assert.equal(res.json().token, undefined);
        assert.equal((await req(null, 'POST', '/auth/login', { username, password: 'wrong-password' })).statusCode, 401);
      }
      assert.equal((await req(null, 'POST', '/auth/login', { username: 'synthetic-missing', password })).statusCode, 401);
    });
    const patientPaths = [
      ['GET', '/auth/me'], ['GET', '/users/me'], ['GET', '/patients/me'],
      ['GET', '/questionnaire/vegetative-functions'], ['GET', '/questionnaire/answers/me'],
      ['POST', '/questionnaire/answers', {}], ['GET', '/medical-history/me'],
      ['POST', '/medical-history/me', {}], ['GET', '/sharing/me'],
      ['POST', '/sharing/me', {}], ['PATCH', '/sharing/me/synthetic-share/toggle', {}],
      ['GET', '/summary/me'], ['GET', '/medications/me'], ['POST', '/medications/me/operations', {}],
      ['GET', '/appointments/me'], ['GET', '/appointments/me/synthetic-appointment'],
      ['POST', '/appointments/me/operations', {}], ['POST', '/physicians/search', {}],
      ['POST', '/physicians/profile', {}],
    ];
    for (const [method, path, body] of patientPaths) {
      await t.test(`inactive account is denied before data access: ${method} ${path}`, async () => {
        const res = await req('inactive', method, path, body);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().code, 'INACTIVE_USER');
      });
    }
    for (const path of ['/doctor/patients', '/doctor/patients/synthetic-target/summary', '/appointments/doctor']) {
      await t.test(`inactive doctor is denied: ${path}`, async () => {
        const res = await req('inactive-doctor', 'GET', path);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().code, 'INACTIVE_USER');
      });
    }
    await t.test('profile responses remain compatible; user status is read on every request', async () => {
      assert.equal((await req('patient', 'GET', '/auth/me')).json().user.phone, null);
      assert.equal((await req('patient', 'GET', '/patients/me')).json().patient.sex, 'M');
      const token = app.jwt.sign({ sub: 'patient' });
      users.get('patient').status = 'inactive';
      try {
        assert.equal((await app.inject({ method: 'GET', url: '/users/me',
          headers: { authorization: `Bearer ${token}` } })).statusCode, 403);
      } finally { users.get('patient').status = 'active'; }
      assert.equal((await req('missing', 'GET', '/users/me')).statusCode, 404);
      assert.equal((await req('patient', 'GET', '/users/me', undefined, { exp: 1 })).statusCode, 401);
    });
  } finally {
    await app.close();
    prisma.$transaction = originalTransaction;
    for (const [model, method, original] of originals.reverse()) model[method] = original;
    await prisma.$disconnect();
  }
});
