import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { prisma } from '../dist/infrastructure/db/prisma.js';
import { appointmentsRoutes } from '../dist/modules/appointments/appointments.routes.js';
import { applyAppointmentOperation, getAppointment, listAppointments } from '../dist/modules/appointments/appointments.service.js';

if (!process.env.APPOINTMENT_TEST_SCHEMA?.startsWith('kuvi_appts_test_') ||
    new URL(process.env.DATABASE_URL).searchParams.get('schema') !== process.env.APPOINTMENT_TEST_SCHEMA)
  throw Error('Isolated appointment test schema required');
const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const details = extra => ({ doctorId: null, doctorName: 'External doctor', specialty: 'General',
  start: at(60), end: at(90), timezone: 'America/Mexico_City', location: 'Consultorio',
  modality: 'in_person', reminder24h: true, reminder1h: true, ...extra });
const save = (id, appointment, expectedVersion = 0) => ({ type: 'save', id, expectedVersion, appointment });
test('appointment backend persistence, access and lifecycle', async t => {
  const user = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'test-only' } });
  const other = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'test-only' } });
  const doctor = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'test-only', role: 'doctor' } });
  const stranger = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'test-only', role: 'doctor' } });
  await prisma.doctorApproval.createMany({ data: [doctor, stranger].map(d => ({ userId: d.id, approvedAt: new Date(), approvedBy: 'synthetic-operator', verificationReference: 'synthetic-fixture' })) });
  const apply = (action, actor = user, operationId = randomUUID(), owner = user.id) => applyAppointmentOperation(actor, owner, { operationId, action });
  const read = async id => (await getAppointment(user, user.id, id)).value;
  const app = Fastify();
  await app.register(jwt, { secret: 'isolated-appointment-tests' });
  await app.register(appointmentsRoutes, { prefix: '/appointments' });
  await app.ready();
  const req = (actor, method, url, payload) => app.inject({ method, url, payload,
    headers: actor ? { authorization: `Bearer ${app.jwt.sign({ sub: actor.id })}` } : {} });
  const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
  try {
    await t.test('authenticated routes reject anonymous, wrong role, malformed body and invalid time', async () => {
      assert.equal((await req(null, 'GET', '/appointments/me')).statusCode, 401);
      assert.equal((await req(doctor, 'GET', '/appointments/me')).statusCode, 403);
      assert.equal((await req(user, 'POST', '/appointments/me/operations', {})).statusCode, 400);
      await rejects(apply(save('invalid', details({ end: at(-100) }))), 'INVALID_APPOINTMENT_OPERATION');
      await rejects(apply(save('invalid', details({ timezone: 'invalid' }))), 'INVALID_APPOINTMENT_OPERATION');
      await rejects(apply(save('invalid', details({ modality: 'video', consultationUrl: 'javascript:bad' }))), 'INVALID_APPOINTMENT_OPERATION');
      await rejects(apply(save('invalid', details({ doctorId: other.id }))), 'INVALID_DOCTOR');
    });
    await t.test('concurrent retry writes once; operation reuse and stale versions conflict', async () => {
      const action = save('manual', details()), operation = randomUUID();
      await Promise.all([apply(action, user, operation), apply(action, user, operation)]);
      const row = await read('manual');
      assert.equal(row.version, 1); assert.equal(row.events.length, 1);
      assert.equal(row.origin, 'patient'); assert.equal(row.bookingStatus, 'recorded');
      await rejects(apply({ ...action, appointment: details({ location: 'Other' }) }, user, operation), 'OPERATION_ID_REUSED');
      await rejects(apply(action), 'VERSION_CONFLICT');
    });
    await t.test('patient and unrelated doctor cannot see or mutate another patient appointment', async () => {
      assert.equal((await listAppointments(other, {})).value.length, 0);
      await rejects(getAppointment(other, user.id, 'manual'), 'FORBIDDEN');
      await rejects(getAppointment(stranger, user.id, 'manual'), 'APPOINTMENT_NOT_FOUND');
      assert.equal((await req(other, 'GET', '/appointments/me/manual')).statusCode, 404);
      assert.equal((await req(stranger, 'GET', `/appointments/doctor/${user.id}/manual`)).statusCode, 404);
      await rejects(apply({ type: 'archive', id: 'manual', expectedVersion: 1, archived: true }, stranger), 'APPOINTMENT_NOT_FOUND');
    });
    await t.test('rescheduling preserves history and rejects invalid dates', async () => {
      const before = await read('manual');
      await apply({ type: 'reschedule', id: 'manual', expectedVersion: 1, start: at(180), end: at(210), timezone: 'America/Mexico_City', reason: 'Patient request' });
      const after = await read('manual');
      assert.equal(after.version, 2); assert.equal(after.events.length, 2);
      assert.equal(after.events[0].snapshot.before.start, before.start.toISOString());
      await rejects(apply({ type: 'reschedule', id: 'manual', expectedVersion: 2, start: at(-120), end: at(-60), timezone: 'America/Mexico_City', reason: 'bad' }), 'RESCHEDULE_REQUIRES_FUTURE_DATE');
    });
    await t.test('archive is independent, reversible, and never deletes history', async () => {
      await apply({ type: 'archive', id: 'manual', expectedVersion: 2, archived: true });
      assert.equal((await listAppointments(user, { archived: 'true' })).value.length, 1);
      assert.equal((await read('manual')).status, 'scheduled');
      await rejects(apply({ type: 'status', id: 'manual', expectedVersion: 3, status: 'cancelled', reason: 'test' }), 'APPOINTMENT_ARCHIVED');
      await apply({ type: 'archive', id: 'manual', expectedVersion: 3, archived: false });
      await apply({ type: 'status', id: 'manual', expectedVersion: 4, status: 'cancelled', reason: 'Patient cancelled' });
      assert.equal((await read('manual')).events.length, 5);
    });
    await t.test('follow-up must refer to an earlier appointment owned by the same patient', async () => {
      await rejects(apply(save('followup', details({ previousAppointmentId: 'missing' }))), 'INVALID_PREVIOUS_APPOINTMENT');
      await apply(save('followup', details({ start: at(300), end: at(330), previousAppointmentId: 'manual' })));
      assert.equal((await read('followup')).previousAppointmentId, 'manual');
    });
    await t.test('doctor confirmation is explicit; patient cannot forge confirmation or prescriptions', async () => {
      await apply(save('consultation', details({ doctorId: doctor.id, start: at(-10), end: at(30) })));
      assert.equal((await read('consultation')).bookingStatus, 'requested');
      await rejects(apply({ type: 'confirm', id: 'consultation', expectedVersion: 1 }), 'DOCTOR_ACTION_REQUIRED');
      await rejects(apply(save('forged', { ...details(), bookingStatus: 'confirmed' })), 'INVALID_APPOINTMENT_OPERATION');
      await apply({ type: 'confirm', id: 'consultation', expectedVersion: 1 }, doctor);
      assert.equal((await listAppointments(doctor, {})).value.length, 1);
      await rejects(apply({ type: 'clinical_note', id: 'consultation', expectedVersion: 2, noteId: 'bad', text: 'forged' }), 'DOCTOR_ACTION_REQUIRED');
      await apply({ type: 'clinical_note', id: 'consultation', expectedVersion: 2, noteId: 'note1', text: 'Doctor-authored follow-up instructions' }, doctor);
      assert.equal((await read('consultation')).clinicalNotes[0].doctorId, doctor.id);
    });
    await t.test('issued prescription survives changes; replacement and revocation retain originals', async () => {
      const prescription = { type: 'issue_prescription', id: 'consultation', expectedVersion: 3, prescriptionId: 'rx1', instructions: 'Test instructions',
        items: [{ id: 'item1', name: 'Test medication', dose: '1 unit', route: 'Test route', frequency: 'As prescribed', duration: 'Test duration' }] };
      await rejects(apply(prescription), 'DOCTOR_ACTION_REQUIRED');
      await apply(prescription, doctor);
      await apply({ ...prescription, expectedVersion: 4, prescriptionId: 'rx2', supersedesId: 'rx1', instructions: 'Correction' }, doctor);
      let row = await read('consultation');
      assert.equal(row.prescriptions.length, 2);
      assert.equal(row.prescriptions[0].instructions, 'Test instructions');
      assert.ok(row.prescriptions[0].revokedAt);
      await apply({ type: 'status', id: 'consultation', expectedVersion: 5, status: 'completed', reason: 'Consultation completed' }, doctor);
      await apply({ type: 'archive', id: 'consultation', expectedVersion: 6, archived: true });
      await apply({ type: 'revoke_prescription', id: 'consultation', expectedVersion: 7, prescriptionId: 'rx2', reason: 'Correction required' }, doctor);
      row = await read('consultation');
      assert.equal(row.status, 'completed'); assert.ok(row.archivedAt);
      assert.equal(row.prescriptions[1].revocationReason, 'Correction required');
      assert.equal(await prisma.medication.count({ where: { userId: user.id } }), 0);
    });
    await t.test('patient time edits require a new doctor confirmation', async () => {
      const a = details({ doctorId: doctor.id });
      await apply(save('change', a));
      await apply({ type: 'confirm', id: 'change', expectedVersion: 1 }, doctor);
      await apply(save('change', { ...a, start: at(120), end: at(150) }, 2));
      assert.equal((await read('change')).bookingStatus, 'requested');
      await rejects(apply({ type: 'status', id: 'change', expectedVersion: 3, status: 'no_show', reason: 'early' }), 'APPOINTMENT_NOT_ENDED');
    });
    await t.test('post-consultation patient notes stay distinct from immutable doctor notes', async () => {
      await apply({ type: 'archive', id: 'consultation', expectedVersion: 8, archived: false });
      await apply({ type: 'patient_notes', id: 'consultation', expectedVersion: 9, text: 'Patient recollection', followUpAt: at(1000) });
      const row = await read('consultation');
      assert.equal(row.patientNotes, 'Patient recollection');
      assert.equal(row.clinicalNotes[0].text, 'Doctor-authored follow-up instructions');
      await rejects(apply({ type: 'patient_notes', id: 'consultation', expectedVersion: 10, text: 'Wrong author', followUpAt: null }, doctor), 'PATIENT_ACTION_REQUIRED');
    });
    await t.test('concurrent distinct edits do not silently overwrite each other', async () => {
      const results = await Promise.allSettled([
        apply({ type: 'patient_notes', id: 'consultation', expectedVersion: 10, text: 'Device one', followUpAt: null }),
        apply({ type: 'patient_notes', id: 'consultation', expectedVersion: 10, text: 'Device two', followUpAt: null }),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'rejected').reason.code, 'VERSION_CONFLICT');
    });
    await t.test('paginated lists do not omit or repeat records and inactive users are denied', async () => {
      const seen = new Set(); let cursor;
      do {
        const page = await listAppointments(user, { limit: 1, ...(cursor ? { cursor } : {}) });
        for (const row of page.value) { assert.ok(!seen.has(row.id)); seen.add(row.id); }
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(seen.size, 4);
      await prisma.user.update({ where: { id: user.id }, data: { status: 'inactive' } });
      assert.equal((await req(user, 'GET', '/appointments/me')).statusCode, 403);
      await rejects(apply({ type: 'archive', id: 'change', expectedVersion: 3, archived: true }), 'INACTIVE_OR_INVALID_ACTOR');
    });
  } finally { await app.close(); await prisma.$disconnect(); }
});
