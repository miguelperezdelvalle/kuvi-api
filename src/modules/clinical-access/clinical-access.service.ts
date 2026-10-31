import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;
export class ClinicalAccessError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new ClinicalAccessError(status, code); };
const id = z.string().trim().min(1).max(160);
export const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: id.optional() }).strict();
export const grantSchema = z.object({ doctorId: id,
  scopes: z.array(z.enum(['summary', 'questionnaire', 'medical-history'])).min(1).max(3)
    .refine(s => new Set(s).size === s.length),
  expiresAt: z.string().datetime(), expectedVersion: z.number().int().min(0),
}).strict();
export const revokeSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export const paramsSchema = z.object({ id }).strict();
const snapshot = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

export async function lockDoctor(tx: Tx, doctorId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`doctor-approval:${doctorId}`}, 0))`;
}
async function doctorApproved(tx: Tx, doctorId: string) {
  const doctor = await tx.user.findUnique({ where: { id: doctorId }, include: { doctorApproval: true } });
  if (!doctor || doctor.role !== 'doctor' || doctor.status !== 'active' ||
      !doctor.doctorApproval || doctor.doctorApproval.revokedAt || doctor.doctorApproval.approvedAt > new Date())
    fail(403, 'DOCTOR_NOT_APPROVED');
}
async function lockPair(tx: Tx, patientId: string, doctorId: string) {
  await lockDoctor(tx, doctorId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`patient-grant:${patientId}:${doctorId}`}, 0))`;
}
async function activePatient(tx: Tx, patientId: string) {
  const patient = await tx.user.findUnique({ where: { id: patientId }, select: { id: true, role: true, status: true } });
  if (!patient || patient.role !== 'patient' || patient.status !== 'active') fail(403, 'INACTIVE_PATIENT');
}
export async function saveGrant(patientId: string, input: unknown) {
  const body = grantSchema.parse(input);
  const expiresAt = new Date(body.expiresAt), now = Date.now();
  if (expiresAt.getTime() <= now || expiresAt.getTime() > now + 90 * 86400000) fail(400, 'INVALID_GRANT_EXPIRY');
  return prisma.$transaction(async tx => {
    await lockPair(tx, patientId, body.doctorId);
    await activePatient(tx, patientId); await doctorApproved(tx, body.doctorId);
    const where = { patientId_doctorId: { patientId, doctorId: body.doctorId } };
    const old = await tx.patientDoctorGrant.findUnique({ where });
    if ((old?.version ?? 0) !== body.expectedVersion) fail(409, 'GRANT_VERSION_CONFLICT');
    const data = { scopes: body.scopes, expiresAt, revokedAt: null, grantedAt: new Date() };
    const grant = await tx.patientDoctorGrant.upsert({ where,
      create: { patientId, doctorId: body.doctorId, ...data }, update: { ...data, version: { increment: 1 } } });
    await tx.patientDoctorGrantEvent.create({ data: { grantId: grant.id, action: 'granted', snapshot: snapshot(grant) } });
    return { result: 'OK', value: grant };
  });
}
export async function revokeGrant(patientId: string, grantId: string, input: unknown) {
  const body = revokeSchema.parse(input);
  const initial = await prisma.patientDoctorGrant.findFirst({ where: { id: grantId, patientId } });
  if (!initial) fail(404, 'GRANT_NOT_FOUND');
  return prisma.$transaction(async tx => {
    await lockPair(tx, patientId, initial!.doctorId); await activePatient(tx, patientId);
    const old = await tx.patientDoctorGrant.findFirst({ where: { id: grantId, patientId } });
    if (!old) return fail(404, 'GRANT_NOT_FOUND');
    if (old.revokedAt) return { result: 'OK', value: old };
    if (old.version !== body.expectedVersion) fail(409, 'GRANT_VERSION_CONFLICT');
    const grant = await tx.patientDoctorGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), version: { increment: 1 } } });
    await tx.patientDoctorGrantEvent.create({ data: { grantId, action: 'revoked', snapshot: snapshot(grant) } });
    return { result: 'OK', value: grant };
  });
}
function pageResult<T extends { id: string }>(rows: T[], limit: number) {
  const value = rows.slice(0, limit);
  return { result: 'OK', value, nextCursor: rows.length > limit ? value.at(-1)!.id : null };
}
export async function listOwnGrants(patientId: string, query: unknown) {
  const p = pageSchema.parse(query);
  const rows = await prisma.patientDoctorGrant.findMany({ where: { patientId, ...(p.cursor ? { id: { gt: p.cursor } } : {}) },
    orderBy: { id: 'asc' }, take: p.limit + 1, include: { doctor: { select: { username: true } } } });
  return pageResult(rows, p.limit);
}
export async function listGrantedPatients(doctorId: string, query: unknown) {
  const p = pageSchema.parse(query);
  return prisma.$transaction(async tx => {
    await lockDoctor(tx, doctorId); await doctorApproved(tx, doctorId);
    const rows = await tx.patientDoctorGrant.findMany({ where: { doctorId, revokedAt: null,
      expiresAt: { gt: new Date() }, patient: { role: 'patient', status: 'active' },
      ...(p.cursor ? { id: { gt: p.cursor } } : {}) }, orderBy: { id: 'asc' }, take: p.limit + 1,
      select: { id: true, scopes: true, expiresAt: true, patient: { select: { id: true, username: true } } } });
    return pageResult(rows, p.limit);
  });
}
export async function readPatient(doctorId: string, patientId: string, scope: 'summary' | 'questionnaire' | 'medical-history', query: unknown) {
  const p = pageSchema.parse(query);
  return prisma.$transaction(async tx => {
    await lockPair(tx, patientId, doctorId); await doctorApproved(tx, doctorId);
    const grant = await tx.patientDoctorGrant.findFirst({ where: { patientId, doctorId,
      revokedAt: null, expiresAt: { gt: new Date() }, scopes: { has: scope },
      patient: { role: 'patient', status: 'active' } }, select: { id: true } });
    // Same denial for missing patient, missing relation, expiry, scope and revocation.
    if (!grant) fail(404, 'PATIENT_ACCESS_NOT_FOUND');
    const patient = await tx.user.findUnique({ where: { id: patientId }, select: { id: true, username: true } });
    if (scope === 'summary') return { result: 'OK', patient, summary: { counts: {
      answers: await tx.questionnaireAnswer.count({ where: { userId: patientId } }),
      medicalNotes: await tx.medicalHistoryNote.count({ where: { userId: patientId } }),
    } } };
    const where = { userId: patientId, ...(p.cursor ? { id: { gt: p.cursor } } : {}) };
    if (scope === 'medical-history') {
      const rows = await tx.medicalHistoryNote.findMany({ where, orderBy: { id: 'asc' }, take: p.limit + 1,
        select: { id: true, noteType: true, noteText: true, createdAt: true, updatedAt: true } });
      return { ...pageResult(rows, p.limit), patient };
    }
    const rows = await tx.questionnaireAnswer.findMany({ where, orderBy: { id: 'asc' }, take: p.limit + 1,
      select: { id: true, questionId: true, answerValue: true, updatedAt: true,
        question: { select: { questionText: true, answerType: true } } } });
    return { ...pageResult(rows, p.limit), patient };
  });
}
