import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { prisma } from '../dist/infrastructure/db/prisma.js';
import { doctorRoutes } from '../dist/modules/doctor/doctor.routes.js';
import { sharingRoutes } from '../dist/modules/sharing/sharing.routes.js';
import { authRoutes } from '../dist/modules/auth/auth.routes.js';
import { usersRoutes } from '../dist/modules/users/users.routes.js';
import { appointmentsRoutes } from '../dist/modules/appointments/appointments.routes.js';
import { getAppointment } from '../dist/modules/appointments/appointments.service.js';
import { onboardDoctor } from '../dist/modules/clinical-access/doctor-onboarding.js';

if (!process.env.CLINICAL_ACCESS_TEST_SCHEMA?.startsWith('kuvi_clinical_test_') ||
    new URL(process.env.DATABASE_URL).searchParams.get('schema') !== process.env.CLINICAL_ACCESS_TEST_SCHEMA)
  throw Error('Disposable clinical-access test schema required');
const username = () => randomUUID().replaceAll('-', '');
const expiry = () => new Date(Date.now() + 86400000).toISOString();

test('explicit grants, clinical approval and signing-key rotation', async t => {
  const password = randomBytes(20).toString('hex'), passwordHash = await bcrypt.hash(password, 4);
  const patient = await prisma.user.create({ data: { username: username(), passwordHash,
    patientProfile: { create: { phone: 'SYNTHETIC-PRIVATE-PHONE', sex: 'M' } } } });
  const other = await prisma.user.create({ data: { username: username(), passwordHash } });
  const createDoctor = async () => {
    const result = await onboardDoctor({ action: 'create', username: username(), password,
      verificationReference: 'synthetic-reviewed-evidence' }, 'synthetic-operator');
    return prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
  };
  const doctor = await createDoctor(), stranger = await createDoctor();
  const unapproved = await prisma.user.create({ data: { username: username(), passwordHash, role: 'doctor' } });
  const question = await prisma.questionnaireQuestion.create({ data: {
    groupId: 1, askGroup: 'Synthetic', questionText: 'SYNTHETIC-QUESTION', answerType: 'text',
  } });
  await prisma.questionnaireAnswer.create({ data: { userId: patient.id, questionId: question.id, answerValue: 'SYNTHETIC-ANSWER' } });
  await prisma.medicalHistoryNote.createMany({ data: [1, 2].map(i => ({ userId: patient.id, noteType: 'synthetic', noteText: `SYNTHETIC-NOTE-${i}` })) });
  const key = randomBytes(64).toString('base64url');
  const build = async secret => {
    const server = Fastify({ logger: false }); await server.register(jwt, { secret });
    for (const [routes, prefix] of [[doctorRoutes, '/doctor'], [sharingRoutes, '/sharing'],
      [authRoutes, '/auth'], [usersRoutes, '/users'], [appointmentsRoutes, '/appointments']])
      await server.register(routes, { prefix });
    await server.ready(); return server;
  };
  const app = await build(key);
  const req = (actor, method, url, payload) => app.inject({ method, url, payload,
    headers: actor ? { authorization: `Bearer ${app.jwt.sign({ sub: actor.id })}` } : {} });
  const save = (who, doc, scopes, version = 0) => req(who, 'POST', '/sharing/doctor-grants', {
    doctorId: doc.id, scopes, expiresAt: expiry(), expectedVersion: version,
  });
  const read = (who, scope = 'summary', target = patient.id, suffix = '') =>
    req(who, 'GET', `/doctor/patients/${target}/${scope}${suffix}`);
  const current = () => prisma.patientDoctorGrant.findUniqueOrThrow({ where: { patientId_doctorId: { patientId: patient.id, doctorId: doctor.id } } });
  let grant;
  try {
    await t.test('unapproved doctors and the public cannot acquire clinical privileges', async () => {
      assert.equal((await req(null, 'POST', '/sharing/doctor-grants', {})).statusCode, 401);
      assert.equal((await save(doctor, doctor, ['summary'])).statusCode, 403);
      assert.equal((await save(patient, unapproved, ['summary'])).statusCode, 403);
      assert.equal((await read(unapproved)).json().code, 'DOCTOR_NOT_APPROVED');
      assert.equal((await req(unapproved, 'GET', '/appointments/doctor')).statusCode, 403);
      assert.equal((await req(null, 'POST', '/auth/register-doctor', { username: username(), password })).statusCode, 403);
      assert.equal((await req(null, 'POST', '/doctor/approve', {})).statusCode, 404);
    });
    await t.test('invalid scope, expiry and owner/version spoofing are rejected', async () => {
      const base = { doctorId: doctor.id, scopes: ['summary'], expiresAt: expiry(), expectedVersion: 0 };
      for (const patch of [{ scopes: [] }, { scopes: ['all'] }, { scopes: ['summary', 'summary'] },
        { expectedVersion: -1 }, { patientId: other.id }, { expiresAt: new Date(1).toISOString() },
        { expiresAt: new Date(Date.now() + 91 * 86400000).toISOString() }])
        assert.equal((await req(patient, 'POST', '/sharing/doctor-grants', { ...base, ...patch })).statusCode, 400);
    });
    await t.test('approved doctors without a grant cannot see patient identities or existence', async () => {
      const list = await req(doctor, 'GET', '/doctor/patients');
      assert.equal(list.statusCode, 200); assert.deepEqual(list.json().value, []);
      const denied = await read(doctor), missing = await read(doctor, 'summary', 'synthetic-missing');
      assert.equal(denied.statusCode, 404); assert.deepEqual(denied.json(), missing.json());
    });
    await t.test('apps verify approved identities without creating consent or reading a patient record', async () => {
      const identity = await req(doctor, 'GET', '/doctor/me');
      assert.equal(identity.statusCode, 200); assert.equal(identity.json().user.id, doctor.id);
      assert.equal(identity.json().user.clinicalApproved, true);
      assert.equal((await req(unapproved, 'GET', '/doctor/me')).statusCode, 403);
      assert.equal((await req(patient, 'GET', '/doctor/me')).statusCode, 403);
      const target = await req(patient, 'POST', '/sharing/doctor-grants/recipient', { doctorId: doctor.id });
      assert.equal(target.statusCode, 200);
      assert.deepEqual(target.json().value, { id: doctor.id, username: doctor.username, clinicalApproved: true });
      for (const doctorId of [unapproved.id, 'synthetic-missing'])
        assert.equal((await req(patient, 'POST', '/sharing/doctor-grants/recipient', { doctorId })).statusCode, 404);
      assert.equal((await req(null, 'POST', '/sharing/doctor-grants/recipient', { doctorId: doctor.id })).statusCode, 401);
      assert.equal((await req(doctor, 'POST', '/sharing/doctor-grants/recipient', { doctorId: doctor.id })).statusCode, 403);
      assert.equal((await req(patient, 'POST', '/sharing/doctor-grants/recipient', { doctorId: doctor.id, patientId: other.id })).statusCode, 400);
      assert.equal(await prisma.patientDoctorGrant.count(), 0);
    });
    await t.test('summary consent exposes counts, not answers, notes, contact or credentials', async () => {
      const res = await save(patient, doctor, ['summary']); assert.equal(res.statusCode, 200);
      grant = res.json().value; assert.equal(grant.version, 1);
      const summary = await read(doctor); assert.equal(summary.statusCode, 200);
      assert.deepEqual(summary.json().summary.counts, { answers: 1, medicalNotes: 2 });
      assert.equal(summary.headers['cache-control'], 'no-store');
      const list = await req(doctor, 'GET', '/doctor/patients'); assert.equal(list.json().value.length, 1);
      for (const res of [summary, list]) {
        const body = res.body;
        for (const secret of ['SYNTHETIC-ANSWER', 'SYNTHETIC-NOTE', 'SYNTHETIC-PRIVATE-PHONE', passwordHash, 'verificationReference'])
          assert.equal(body.includes(secret), false);
      }
      assert.equal((await read(doctor, 'questionnaire')).statusCode, 404);
      assert.equal((await read(doctor, 'medical-history')).statusCode, 404);
      assert.equal((await read(stranger)).statusCode, 404);
    });
    await t.test('only the owning patient can list, replace or revoke the grant', async () => {
      assert.deepEqual((await req(other, 'GET', '/sharing/doctor-grants')).json().value, []);
      assert.equal((await req(other, 'POST', `/sharing/doctor-grants/${grant.id}/revoke`, { expectedVersion: 1 })).statusCode, 404);
      assert.equal((await req(doctor, 'GET', '/sharing/doctor-grants')).statusCode, 403);
      const own = await req(patient, 'GET', '/sharing/doctor-grants');
      assert.equal(own.json().value[0].id, grant.id);
      assert.equal((await save(patient, doctor, ['summary'], 0)).statusCode, 409);
    });
    await t.test('scope updates are audited and clinical history is paginated without widening access', async () => {
      const res = await save(patient, doctor, ['summary', 'questionnaire', 'medical-history'], 1);
      assert.equal(res.statusCode, 200); grant = res.json().value; assert.equal(grant.version, 2);
      const answers = await read(doctor, 'questionnaire'); assert.equal(answers.statusCode, 200);
      assert.equal(answers.json().value[0].answerValue, 'SYNTHETIC-ANSWER');
      const first = await read(doctor, 'medical-history', patient.id, '?limit=1');
      assert.equal(first.statusCode, 200); assert.equal(first.json().value.length, 1);
      const second = await read(doctor, 'medical-history', patient.id, `?limit=1&cursor=${first.json().nextCursor}`);
      assert.equal(second.json().value.length, 1); assert.notEqual(first.json().value[0].id, second.json().value[0].id);
      assert.equal(second.json().nextCursor, null);
      assert.equal((await read(doctor, 'summary', patient.id, '?limit=101')).statusCode, 400);
      assert.equal((await req(patient, 'GET', '/sharing/doctor-grants?unknown=1')).statusCode, 400);
      assert.equal(await prisma.patientDoctorGrantEvent.count({ where: { grantId: grant.id } }), 2);
    });
    await t.test('revocation is immediate, idempotent and stale requests cannot reactivate consent', async () => {
      assert.equal((await req(patient, 'POST', `/sharing/doctor-grants/${grant.id}/revoke`, { expectedVersion: 1 })).statusCode, 409);
      const path = `/sharing/doctor-grants/${grant.id}/revoke`;
      const res = await req(patient, 'POST', path, { expectedVersion: 2 });
      assert.equal(res.statusCode, 200); grant = res.json().value; assert.equal(grant.version, 3);
      assert.equal((await req(patient, 'POST', path, { expectedVersion: 2 })).statusCode, 200);
      assert.equal((await read(doctor)).statusCode, 404);
      assert.deepEqual((await req(doctor, 'GET', '/doctor/patients')).json().value, []);
      assert.equal((await save(patient, doctor, ['summary'], 2)).statusCode, 409);
      const renewed = await save(patient, doctor, ['summary'], 3); assert.equal(renewed.statusCode, 200);
      grant = renewed.json().value;
    });
    await t.test('expired permissions and inactive patients never appear in clinical queries', async () => {
      await prisma.patientDoctorGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(1) } });
      assert.equal((await read(doctor)).statusCode, 404);
      assert.deepEqual((await req(doctor, 'GET', '/doctor/patients')).json().value, []);
      grant = (await save(patient, doctor, ['summary'], grant.version)).json().value;
      await prisma.user.update({ where: { id: patient.id }, data: { status: 'inactive' } });
      try { assert.equal((await read(doctor)).statusCode, 404);
        assert.equal((await req(patient, 'GET', '/sharing/doctor-grants')).statusCode, 403);
      } finally { await prisma.user.update({ where: { id: patient.id }, data: { status: 'active' } }); }
    });
    await t.test('concurrent grant edits accept one version and audit once', async () => {
      const old = await current(), before = await prisma.patientDoctorGrantEvent.count({ where: { grantId: old.id } });
      const results = await Promise.all([save(patient, doctor, ['summary'], old.version), save(patient, doctor, ['summary'], old.version)]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
      assert.equal(await prisma.patientDoctorGrantEvent.count({ where: { grantId: old.id } }), before + 1);
      grant = (await current());
    });
    await t.test('a clinical read racing revoke cannot retain permission after revoke completes', async () => {
      const results = await Promise.all([read(doctor), req(patient, 'POST', `/sharing/doctor-grants/${grant.id}/revoke`, { expectedVersion: grant.version })]);
      assert.ok([200, 404].includes(results[0].statusCode)); assert.equal(results[1].statusCode, 200);
      assert.equal((await read(doctor)).statusCode, 404);
      grant = (await save(patient, doctor, ['summary'], results[1].json().value.version)).json().value;
    });
    await t.test('appointment assignment and legacy bearer shares do not grant medical-history access', async () => {
      await prisma.appointment.create({ data: { userId: patient.id, id: 'synthetic-consultation', doctorId: stranger.id,
        doctorName: 'Synthetic doctor', specialty: 'Synthetic', start: new Date(), end: new Date(Date.now() + 60000),
        timezone: 'UTC', location: 'Synthetic' } });
      await prisma.sharedAccess.create({ data: { ownerUserId: patient.id, label: 'synthetic-legacy', shareToken: randomBytes(24).toString('hex') } });
      assert.equal((await read(stranger)).statusCode, 404);
      assert.equal((await req(stranger, 'GET', `/appointments/doctor/${patient.id}/synthetic-consultation`)).statusCode, 200);
    });
    await t.test('operator approval cannot promote a patient or be supplied through public input', async () => {
      await assert.rejects(onboardDoctor({ action: 'approve', userId: patient.id, verificationReference: 'synthetic-reviewed' }, 'synthetic-operator'), e => e.code === 'DOCTOR_NOT_FOUND');
      await assert.rejects(onboardDoctor({ action: 'create', username: patient.username, password, verificationReference: 'synthetic-reviewed' }, 'synthetic-operator'), e => e.code === 'P2002');
      assert.equal((await prisma.user.findUnique({ where: { id: patient.id } })).role, 'patient');
      const child = spawnSync(process.execPath, ['dist/modules/clinical-access/doctor-onboarding-cli.js'], {
        env: { ...process.env, KUVI_OPERATOR_CONFIRM: '' }, encoding: 'utf8',
        input: JSON.stringify({ action: 'create', username: username(), password, verificationReference: 'synthetic-reviewed' }),
      });
      assert.equal(child.status, 1); assert.equal(child.stderr.includes('OPERATOR_CONFIRMATION_REQUIRED'), true);
      assert.equal((child.stdout + child.stderr).includes(password), false);
      await onboardDoctor({ action: 'approve', userId: unapproved.id, verificationReference: 'synthetic-existing-reviewed' }, 'synthetic-operator');
      assert.equal((await req(unapproved, 'GET', '/doctor/patients')).statusCode, 200);
    });
    await t.test('approval revocation closes sessions and grants; reapproval never resurrects patient consent', async () => {
      const login = await req(null, 'POST', '/auth/login', { username: doctor.username, password });
      assert.equal(login.statusCode, 200);
      await onboardDoctor({ action: 'revoke', userId: doctor.id, reason: 'synthetic-revocation-review' }, 'synthetic-operator');
      assert.equal((await app.inject({ url: '/users/me', headers: { authorization: `Bearer ${login.json().token}` } })).statusCode, 401);
      assert.equal((await read(doctor)).json().code, 'DOCTOR_NOT_APPROVED');
      await assert.rejects(getAppointment(doctor, patient.id, 'synthetic-consultation'), e => e.code === 'DOCTOR_NOT_APPROVED');
      const revoked = await current(); assert.ok(revoked.revokedAt);
      assert.equal((await save(patient, doctor, ['summary'], revoked.version)).statusCode, 403);
      await onboardDoctor({ action: 'approve', userId: doctor.id, verificationReference: 'synthetic-reapproval-reviewed' }, 'synthetic-operator');
      assert.equal((await read(doctor)).statusCode, 404);
      const regrant = await save(patient, doctor, ['summary'], revoked.version); assert.equal(regrant.statusCode, 200);
      assert.equal((await read(doctor)).statusCode, 200);
      assert.equal(await prisma.doctorApprovalEvent.count({ where: { doctorId: doctor.id } }), 3);
      assert.equal((await req(doctor, 'GET', '/doctor/patients')).body.includes('verificationReference'), false);
    });
    await t.test('operator CLI creates an approved account privately and rejects caller-supplied approval identity', () => {
      const payload = { action: 'create', username: username(), password, verificationReference: 'synthetic-cli-reviewed' };
      const child = spawnSync(process.execPath, ['dist/modules/clinical-access/doctor-onboarding-cli.js'], {
        env: { ...process.env, KUVI_OPERATOR_CONFIRM: '1' }, encoding: 'utf8', input: JSON.stringify(payload),
      });
      assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).action, 'created-approved');
      assert.equal((child.stdout + child.stderr).includes(password), false);
      const spoof = spawnSync(process.execPath, ['dist/modules/clinical-access/doctor-onboarding-cli.js'], {
        env: { ...process.env, KUVI_OPERATOR_CONFIRM: '1' }, encoding: 'utf8',
        input: JSON.stringify({ ...payload, username: username(), approvedBy: 'forged-operator' }),
      });
      assert.equal(spoof.status, 1); assert.equal(spoof.stderr.includes('ONBOARDING_FAILED'), true);
      assert.equal((spoof.stdout + spoof.stderr).includes(password), false);
    });
    await t.test('lists paginate identities and omit patients without a valid grant', async () => {
      assert.equal((await save(other, doctor, ['summary'])).statusCode, 200);
      const first = await req(doctor, 'GET', '/doctor/patients?limit=1');
      assert.equal(first.json().value.length, 1); assert.ok(first.json().nextCursor);
      const second = await req(doctor, 'GET', `/doctor/patients?limit=1&cursor=${first.json().nextCursor}`);
      assert.equal(second.json().value.length, 1); assert.equal(second.json().nextCursor, null);
      assert.notEqual(first.json().value[0].patient.id, second.json().value[0].patient.id);
    });
    await t.test('signing-key rotation invalidates old JWTs while opaque refresh can renew under the new key', async () => {
      const login = await req(null, 'POST', '/auth/login', { username: patient.username, password });
      assert.equal(login.statusCode, 200);
      const next = await build(randomBytes(64).toString('base64url'));
      try {
        assert.equal((await next.inject({ url: '/users/me', headers: { authorization: `Bearer ${login.json().token}` } })).statusCode, 401);
        const refreshed = await next.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: login.json().refreshToken } });
        assert.equal(refreshed.statusCode, 200);
        assert.equal((await next.inject({ url: '/users/me', headers: { authorization: `Bearer ${refreshed.json().token}` } })).statusCode, 200);
        assert.equal((await app.inject({ url: '/users/me', headers: { authorization: `Bearer ${refreshed.json().token}` } })).statusCode, 401);
      } finally { await next.close(); }
    });
    await t.test('weak signing configuration fails without printing its value', () => {
      const weak = 'synthetic-weak-key';
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./dist/app/env.js')"], {
        env: { ...process.env, JWT_SECRET: weak }, encoding: 'utf8',
      });
      assert.notEqual(child.status, 0); assert.equal((child.stdout + child.stderr).includes(weak), false);
    });
  } finally { await app.close(); await prisma.$disconnect(); }
});
