import { createHash } from 'node:crypto';
import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { operationSchema, type MedicationOperationInput } from './medications.schema.js';

export class MedicationError extends Error {
  constructor(public status: number, public code: string, public details: unknown = null) { super(code); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v));
const decimal = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);
const key = (userId: string, id: string) => ({ userId_id: { userId, id } });
type Tx = Prisma.TransactionClient;

async function medication(tx: Tx, userId: string, id: string) {
  const m = await tx.medication.findUnique({ where: key(userId, id), include: { treatment: true } });
  if (!m || !m.treatment) throw new MedicationError(404, 'MEDICATION_NOT_FOUND');
  return m;
}
async function movement(tx: Tx, userId: string, treatmentId: string, id: string, kind: string,
  delta: Prisma.Decimal, occurredAt: Date, intakeId: string | null = null, reason: string | null = null) {
  const m = await tx.medication.update({ where: key(userId, treatmentId), data: {
    stock: { increment: delta }, stockVersion: { increment: 1 },
  } });
  await tx.medicationStockMovement.create({ data: { userId, id, treatmentId, kind, quantity: delta,
    balanceAfter: m.stock, occurredAt, intakeId, reason } });
}

async function apply(tx: Tx, userId: string, op: MedicationOperationInput) {
  const a = op.action;
  if (a.type === 'save') {
    const old = await tx.medication.findUnique({ where: key(userId, a.id) });
    if ((old?.version ?? 0) !== a.expectedVersion) throw new MedicationError(409, 'VERSION_CONFLICT', { currentVersion: old?.version ?? 0 });
    if (old && old.unit !== a.product.unit) throw new MedicationError(409, 'UNIT_CHANGE_REQUIRES_NEW_MEDICATION');
    const p = { ...a.product, ingredients: json(a.product.ingredients) };
    await tx.medication.upsert({ where: key(userId, a.id),
      create: { userId, id: a.id, ...p }, update: { ...p, version: { increment: 1 } } });
    const t = { ...a.treatment, schedule: json(a.treatment.schedule),
      startsAt: a.treatment.startsAt ? new Date(a.treatment.startsAt) : null,
      endsAt: a.treatment.endsAt ? new Date(a.treatment.endsAt) : null };
    await tx.medicationTreatment.upsert({ where: key(userId, a.id), create: { userId, id: a.id, ...t }, update: t });
    if (!old) {
      await movement(tx, userId, a.id, op.operationId, 'opening', decimal(a.openingStock!), new Date());
      for (const i of a.legacyIntakes ?? []) {
        await tx.medicationIntake.create({ data: { userId, id: i.id, treatmentId: a.id,
          occurredAt: new Date(i.occurredAt), status: 'taken', legacy: true,
          snapshot: { legacySlotIndex: i.legacySlotIndex, historicalDetailsUnknown: true } } });
      }
    }
    return;
  }
  if (a.type === 'stock') {
    const m = await medication(tx, userId, a.treatmentId);
    if (a.kind === 'adjust' && m.stockVersion !== a.expectedStockVersion)
      throw new MedicationError(409, 'STOCK_VERSION_CONFLICT', { currentVersion: m.stockVersion });
    const delta = a.kind === 'refill' ? decimal(a.quantity) : decimal(a.quantity).minus(m.stock);
    await movement(tx, userId, a.treatmentId, a.id, a.kind, delta, new Date(a.occurredAt), null, a.reason);
    return;
  }
  if (a.type === 'void_intake') {
    const i = await tx.medicationIntake.findUnique({ where: key(userId, a.intakeId) });
    if (!i) throw new MedicationError(404, 'INTAKE_NOT_FOUND');
    if (i.voidedAt) return;
    // Historic imports have no known quantity and must never alter the opening balance.
    if (i.legacy) throw new MedicationError(409, 'LEGACY_INTAKE_CANNOT_BE_REVERSED');
    await tx.medicationIntake.update({ where: key(userId, i.id), data: { voidedAt: new Date() } });
    if (i.status === 'taken' && i.quantity) await movement(tx, userId, i.treatmentId, op.operationId,
      'reversal', i.quantity, new Date(), i.id, a.reason);
    return;
  }
  const m = await medication(tx, userId, a.treatmentId);
  const t = m.treatment!;
  if (m.version !== a.expectedVersion) throw new MedicationError(409, 'VERSION_CONFLICT', { currentVersion: m.version });
  if (await tx.medicationIntake.findUnique({ where: key(userId, a.id) })) throw new MedicationError(409, 'INTAKE_ID_EXISTS');
  if (a.scheduledAt && await tx.medicationIntake.findFirst({ where: { userId, treatmentId: a.treatmentId,
    scheduledAt: new Date(a.scheduledAt), voidedAt: null, legacy: false } })) throw new MedicationError(409, 'SLOT_ALREADY_RECORDED');
  const occurred = new Date(a.occurredAt);
  if (occurred.getTime() > Date.now() + 5 * 60_000) throw new MedicationError(400, 'FUTURE_INTAKE');
  const warnings: string[] = [];
  if (t.status !== 'active') warnings.push('TREATMENT_NOT_ACTIVE');
  if ((t.startsAt && occurred < t.startsAt) || (t.endsAt && occurred > t.endsAt)) warnings.push('OUTSIDE_TREATMENT_DATES');
  if (a.status === 'taken' && m.stock.lessThan(a.quantity)) warnings.push('INSUFFICIENT_STOCK');
  const s = t.schedule as Record<string, any>;
  if (a.status === 'taken' && s.kind === 'as_needed') {
    const history = await tx.medicationIntake.findMany({ where: { userId, treatmentId: a.treatmentId,
      status: 'taken', voidedAt: null, legacy: false } });
    if (history.some(i => Math.abs(i.occurredAt.getTime() - occurred.getTime()) < s.minIntervalMinutes * 60_000))
      warnings.push('MINIMUM_INTERVAL');
    const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    for (const l of s.limits as { quantity: number; unit: string; period: string; ingredientName?: string }[]) {
      const factor = (ingredients: any[]) => {
        if (l.unit === 'takes' || l.unit === m.unit) return decimal(1);
        const ing = ingredients.find(i => i.name === l.ingredientName && i.amountUnit === l.unit);
        return ing ? decimal(ing.amount).dividedBy(ing.perQuantity) : decimal(0);
      };
      const rows = [...history.map(i => ({ time: i.occurredAt, amount: l.unit === 'takes' ? decimal(1) : decimal(i.quantity ?? 0).times(factor((i.snapshot as any).ingredients ?? [])) })),
        { time: occurred, amount: l.unit === 'takes' ? decimal(1) : decimal(a.quantity).times(factor(m.ingredients as any[])) }];
      const anchors = l.period === 'calendar_day' ? [occurred] : rows.filter(i => i.time >= occurred && i.time.getTime() < occurred.getTime() + 86400000).map(i => i.time);
      if (anchors.some(anchor => rows.filter(i => l.period === 'calendar_day' ? day(i.time) === day(anchor) :
        i.time <= anchor && i.time.getTime() > anchor.getTime() - 86400000)
        .reduce((sum, i) => sum.plus(i.amount), decimal(0)).greaterThan(l.quantity))) warnings.push('DOSE_LIMIT');
    }
  }
  if (warnings.length && !a.overrideWarning) throw new MedicationError(422, 'CONFIRM_RECORDED_INTAKE', [...new Set(warnings)]);
  await tx.medicationIntake.create({ data: { userId, id: a.id, treatmentId: a.treatmentId, quantity: a.quantity,
    unit: m.unit, scheduledAt: a.scheduledAt ? new Date(a.scheduledAt) : null, occurredAt: occurred,
    status: a.status, overrideWarning: a.overrideWarning,
    snapshot: json({ name: m.name, ingredients: m.ingredients, dose: t.dose, schedule: t.schedule, warnings }) } });
  if (a.status === 'taken') await movement(tx, userId, a.treatmentId, op.operationId, 'consumption', decimal(a.quantity).negated(), occurred, a.id);
}

export async function applyMedicationOperation(userId: string, input: unknown) {
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success) throw new MedicationError(400, 'INVALID_MEDICATION_OPERATION', parsed.error.flatten());
  const op = parsed.data;
  const hash = createHash('sha256').update(canonical(op.action)).digest('hex');
  return prisma.$transaction(async tx => {
    // Serializes only one user's medication writes, including retries from other devices.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
    const existing = await tx.medicationOperation.findUnique({ where: key(userId, op.operationId) });
    if (existing) {
      if (existing.requestHash !== hash) throw new MedicationError(409, 'OPERATION_ID_REUSED');
      return existing.result;
    }
    await apply(tx, userId, op);
    const result = { result: 'OK', operationId: op.operationId };
    await tx.medicationOperation.create({ data: { userId, id: op.operationId, requestHash: hash, result } });
    return result;
  }, { timeout: 30000 });
}

export async function getMedicationSnapshot(userId: string) {
  return prisma.$transaction(async tx => ({ result: 'OK',
    medications: await tx.medication.findMany({ where: { userId }, include: { treatment: true }, orderBy: { id: 'asc' } }),
    intakes: await tx.medicationIntake.findMany({ where: { userId }, orderBy: { occurredAt: 'asc' } }),
    movements: await tx.medicationStockMovement.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
  }), { isolationLevel: 'RepeatableRead' });
}
