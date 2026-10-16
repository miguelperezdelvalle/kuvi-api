import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { prisma } from '../dist/infrastructure/db/prisma.js';
import { medicationsRoutes } from '../dist/modules/medications/medications.routes.js';
import { applyMedicationOperation, getMedicationSnapshot } from '../dist/modules/medications/medications.service.js';

if (!process.env.MEDICATION_TEST_SCHEMA?.startsWith('kuvi_meds_test_') ||
    new URL(process.env.DATABASE_URL).searchParams.get('schema') !== process.env.MEDICATION_TEST_SCHEMA) {
  throw new Error('Run with npm run test:medications: isolated schema is mandatory');
}
const now = () => new Date().toISOString();
const product = { name: 'Test medicine', form: 'tablet', unit: 'tablet', ingredients: [{ name: 'Test ingredient', amount: 500, amountUnit: 'mg', perQuantity: 1, perUnit: 'tablet' }] };
const treatment = { doctor: 'Test doctor', dose: 0.5, startsAt: null, endsAt: null, status: 'active', reminders: true,
  lowStockDays: 3, lowStockUnits: 2, schedule: { kind: 'fixed', timezone: 'America/Guatemala', times: [480, 1200], weekdays: [1,2,3,4,5,6,7] } };
const save = (id, extra = {}) => ({ type: 'save', id, expectedVersion: 0, product, treatment, openingStock: 10, ...extra });
const intake = (id, extra = {}) => ({ type: 'intake', id: randomUUID(), treatmentId: id, quantity: 0.5,
  scheduledAt: now(), occurredAt: now(), expectedVersion: 1, status: 'taken', ...extra });
test('medication persistence and synchronization', async t => {
  const user = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'not-a-real-hash' } });
  const other = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'not-a-real-hash' } });
  const doctor = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'not-a-real-hash', role: 'doctor' } });
  const apply = (action, operationId = randomUUID(), who = user.id) => applyMedicationOperation(who, { operationId, action });
  const app = Fastify();
  await app.register(jwt, { secret: 'isolated-medications-test-secret' });
  await app.register(medicationsRoutes, { prefix: '/medications' });
  await app.ready();
  try {
    await t.test('routes require authentication and patient role', async () => {
      assert.equal((await app.inject('/medications/me')).statusCode, 401);
      assert.equal((await app.inject({ url: '/medications/me', headers: { authorization: `Bearer ${app.jwt.sign({ sub: doctor.id })}` } })).statusCode, 403);
      const invalid = await app.inject({ method: 'POST', url: '/medications/me/operations', payload: {}, headers: { authorization: `Bearer ${app.jwt.sign({ sub: user.id })}` } });
      assert.equal(invalid.statusCode, 400);
    });
    await t.test('legacy import preserves opening stock and unknown historic fields', async () => {
      await apply(save('legacy', { openingStock: 7, legacyIntakes: [{ id: 'old-intake', occurredAt: now(), legacySlotIndex: 1 }] }));
      const m = await prisma.medication.findUnique({ where: { userId_id: { userId: user.id, id: 'legacy' } } });
      assert.equal(m.stock.toString(), '7');
      const i = await prisma.medicationIntake.findUnique({ where: { userId_id: { userId: user.id, id: 'old-intake' } } });
      assert.equal(i.quantity, null); assert.equal(i.legacy, true);
      await assert.rejects(apply({ type: 'void_intake', intakeId: 'old-intake', reason: 'test' }), e => e.code === 'LEGACY_INTAKE_CANNOT_BE_REVERSED');
    });
    await t.test('simultaneous retries create only one intake and consumption', async () => {
      await apply(save('daily'));
      const a = intake('daily'); const op = randomUUID();
      await Promise.all([apply(a, op), apply(a, op), apply(a, op)]);
      const snapshot = await getMedicationSnapshot(user.id);
      assert.equal(snapshot.medications.find(m => m.id === 'daily').stock.toString(), '9.5');
      assert.equal(snapshot.intakes.filter(i => i.id === a.id).length, 1);
      assert.equal(snapshot.movements.filter(m => m.intakeId === a.id).length, 1);
      await assert.rejects(apply({ ...a, quantity: 2 }, op), e => e.code === 'OPERATION_ID_REUSED');
      await assert.rejects(apply({ ...a, id: randomUUID() }), e => e.code === 'SLOT_ALREADY_RECORDED');
      const voidAction = { type: 'void_intake', intakeId: a.id, reason: 'accidental tap' };
      await Promise.all([apply(voidAction), apply(voidAction)]);
      assert.equal((await getMedicationSnapshot(user.id)).medications.find(m => m.id === 'daily').stock.toString(), '10');
    });
    await t.test('skipped intake does not consume inventory', async () => {
      await apply(intake('daily', { status: 'skipped', scheduledAt: new Date(Date.now()-3600000).toISOString() }));
      assert.equal((await getMedicationSnapshot(user.id)).medications.find(m => m.id === 'daily').stock.toString(), '10');
    });
    await t.test('owner isolation and version conflict leave state unchanged', async () => {
      assert.equal((await getMedicationSnapshot(other.id)).medications.length, 0);
      await assert.rejects(apply(intake('daily'), randomUUID(), other.id), e => e.code === 'MEDICATION_NOT_FOUND');
      await assert.rejects(apply(save('daily')), e => e.code === 'VERSION_CONFLICT');
      const changed = { ...save('daily'), expectedVersion: 1, product: { ...product, name: 'New name' } };
      delete changed.openingStock;
      await apply(changed);
      await assert.rejects(apply(intake('daily')), e => e.code === 'VERSION_CONFLICT');
    });
    await t.test('refills add, adjustments detect stale stock versions', async () => {
      const a = { type: 'stock', id: randomUUID(), treatmentId: 'daily', kind: 'refill', quantity: 2.5, expectedStockVersion: 0, occurredAt: now(), reason: 'refill' };
      await apply(a);
      assert.equal((await getMedicationSnapshot(user.id)).medications.find(m => m.id === 'daily').stock.toString(), '12.5');
      await assert.rejects(apply({ ...a, id: randomUUID(), kind: 'adjust', quantity: 1 }), e => e.code === 'STOCK_VERSION_CONFLICT');
    });
    await t.test('as-needed interval and ingredient limits require explicit confirmation', async () => {
      const prn = { ...treatment, schedule: { kind: 'as_needed', timezone: 'America/Guatemala', reason: 'per prescription', minIntervalMinutes: 60,
        limits: [{ quantity: 250, unit: 'mg', ingredientName: 'Test ingredient', period: 'rolling_24h' }, { quantity: 1, unit: 'takes', period: 'calendar_day' }] } };
      await apply(save('prn', { treatment: prn }));
      const first = intake('prn', { scheduledAt: null, occurredAt: new Date(Date.now()-120000).toISOString() });
      await apply(first);
      const second = intake('prn', { scheduledAt: null });
      await assert.rejects(apply(second), e => e.code === 'CONFIRM_RECORDED_INTAKE' && e.details.includes('DOSE_LIMIT') && e.details.includes('MINIMUM_INTERVAL'));
      await apply({ ...second, overrideWarning: true });
      assert.equal((await getMedicationSnapshot(user.id)).medications.find(m => m.id === 'prn').stock.toString(), '9');
    });
    await t.test('edited concentration does not rewrite historic ingredient doses', async () => {
      const prn = { ...treatment, schedule: { kind: 'as_needed', timezone: 'America/Guatemala', reason: '', minIntervalMinutes: 0,
        limits: [{ quantity: 550, unit: 'mg', ingredientName: 'Test ingredient', period: 'rolling_24h' }] } };
      await apply(save('concentration', { treatment: prn }));
      await apply(intake('concentration', { quantity: 1, scheduledAt: null }));
      const edited = save('concentration', { expectedVersion: 1, treatment: prn,
        product: { ...product, ingredients: [{ ...product.ingredients[0], amount: 100 }] } });
      delete edited.openingStock;
      await apply(edited);
      await assert.rejects(apply(intake('concentration', { quantity: 1, scheduledAt: null, expectedVersion: 2 })),
        e => e.code === 'CONFIRM_RECORDED_INTAKE' && e.details.includes('DOSE_LIMIT'));
    });
    await t.test('failed imports roll back product, treatment, ledger and operation', async () => {
      await assert.rejects(apply(save('rollback', { legacyIntakes: [{ id: 'old-intake', occurredAt: now(), legacySlotIndex: null }] })));
      assert.equal((await getMedicationSnapshot(user.id)).medications.some(m => m.id === 'rollback'), false);
    });
    await t.test('invalid units, duplicate hours and end dates are rejected', async () => {
      await assert.rejects(apply(save('bad', { treatment: { ...treatment, schedule: { ...treatment.schedule, times: [480,480] } } })), e => e.status === 400);
      await assert.rejects(apply(save('bad', { product: { ...product, unit: 'mL' } })), e => e.status === 400);
      await assert.rejects(apply(save('bad', { treatment: { ...treatment, startsAt: now(), endsAt: '2020-01-01T00:00:00Z' } })), e => e.status === 400);
    });
  } finally { await app.close(); await prisma.$disconnect(); }
});
