import { createHash } from 'node:crypto';
import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { operationSchema, listSchema } from './appointments.schema.js';

export class AppointmentError extends Error {
  constructor(public status: number, public code: string, public details: unknown = null) { super(code); }
}
export type Actor = { id: string; role: string };
function fail(status: number, code: string): never { throw new AppointmentError(status, code); }
const key = (userId: string, id: string) => ({ userId_id: { userId, id } });
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function scope(actor: Actor, userId: string) {
  if (actor.role !== 'doctor' && (actor.role !== 'patient' || actor.id !== userId)) fail(403, 'FORBIDDEN');
}
const include = { clinicalNotes: { orderBy: { createdAt: 'asc' as const } },
  prescriptions: { orderBy: { issuedAt: 'asc' as const } },
  events: { orderBy: { createdAt: 'desc' as const }, take: 100 } };

export async function getAppointment(actor: Actor, userId: string, id: string) {
  scope(actor, userId);
  const value = await prisma.appointment.findFirst({ where: { userId, id,
    ...(actor.role === 'doctor' ? { doctorId: actor.id } : {}) }, include });
  if (!value) fail(404, 'APPOINTMENT_NOT_FOUND');
  return { result: 'OK', value };
}

export async function listAppointments(actor: Actor, input: unknown) {
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError(400, 'INVALID_QUERY', parsed.error.flatten());
  const q = parsed.data;
  if (!['patient', 'doctor'].includes(actor.role)) fail(403, 'FORBIDDEN');
  let after: { userId: string; id: string } | undefined;
  if (q.cursor) {
    try {
      const v = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(v) || v.length !== 2 || v.some(x => typeof x !== 'string' || x.length > 160)) throw Error();
      after = { userId: v[0], id: v[1] };
    } catch { fail(400, 'INVALID_CURSOR'); }
  }
  const rows = await prisma.appointment.findMany({ where: {
    ...(actor.role === 'patient' ? { userId: actor.id } : { doctorId: actor.id }),
    ...(q.archived === 'all' ? {} : { archivedAt: q.archived === 'true' ? { not: null } : null }),
    ...(after ? { OR: [{ userId: { gt: after.userId } }, { userId: after.userId, id: { gt: after.id } }] } : {}),
  }, orderBy: [{ userId: 'asc' }, { id: 'asc' }], take: q.limit + 1 });
  const more = rows.length > q.limit;
  const value = rows.slice(0, q.limit);
  const last = value.at(-1);
  return { result: 'OK', value, nextCursor: more && last ? Buffer.from(JSON.stringify([last.userId, last.id])).toString('base64url') : null };
}

export async function applyAppointmentOperation(actor: Actor, userId: string, input: unknown) {
  scope(actor, userId);
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError(400, 'INVALID_APPOINTMENT_OPERATION', parsed.error.flatten());
  const op = parsed.data, a = op.action;
  const hash = createHash('sha256').update(canonical({ actorId: actor.id, action: a })).digest('hex');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`appointments:${userId}`}, 0))`;
    const active = await tx.user.findUnique({ where: { id: actor.id } });
    if (!active || active.status !== 'active' || active.role !== actor.role) fail(403, 'INACTIVE_OR_INVALID_ACTOR');
    const old = await tx.appointment.findUnique({ where: key(userId, a.id) });
    if (actor.role === 'doctor' && (!old || old.doctorId !== actor.id)) fail(404, 'APPOINTMENT_NOT_FOUND');
    const retry = await tx.appointmentOperation.findUnique({ where: key(userId, op.operationId) });
    if (retry) {
      if (retry.actorId !== actor.id || retry.requestHash !== hash) fail(409, 'OPERATION_ID_REUSED');
      return retry.result;
    }
    if ((old?.version ?? 0) !== a.expectedVersion) throw new AppointmentError(409, 'VERSION_CONFLICT', { currentVersion: old?.version ?? 0 });
    if (!old && a.type !== 'save') fail(404, 'APPOINTMENT_NOT_FOUND');
    if (old?.archivedAt && !['archive', 'revoke_prescription'].includes(a.type)) fail(409, 'APPOINTMENT_ARCHIVED');
    const patientOnly = () => { if (actor.role !== 'patient') fail(403, 'PATIENT_ACTION_REQUIRED'); };
    const clinician = () => {
      if (actor.role !== 'doctor') fail(403, 'DOCTOR_ACTION_REQUIRED');
      if (!old || old.bookingStatus !== 'confirmed' || !['scheduled', 'completed'].includes(old.status)) fail(409, 'CONSULTATION_NOT_CONFIRMED');
      if (old.start > new Date()) fail(409, 'CONSULTATION_NOT_STARTED');
    };
    if (a.type === 'save') {
      patientOnly();
      if (old && old.status !== 'scheduled') fail(409, 'APPOINTMENT_CLOSED');
      const p = a.appointment;
      if (old && old.doctorId !== p.doctorId) fail(409, 'DOCTOR_CHANGE_REQUIRES_NEW_APPOINTMENT');
      if (old && old.previousAppointmentId !== p.previousAppointmentId) fail(409, 'FOLLOW_UP_LINK_IMMUTABLE');
      if (p.doctorId) {
        const doctor = await tx.user.findUnique({ where: { id: p.doctorId } });
        if (!doctor || doctor.role !== 'doctor' || doctor.status !== 'active') fail(400, 'INVALID_DOCTOR');
      }
      if (p.previousAppointmentId) {
        const previous = await tx.appointment.findUnique({ where: key(userId, p.previousAppointmentId) });
        if (!previous || previous.id === a.id || previous.end > new Date(p.start)) fail(400, 'INVALID_PREVIOUS_APPOINTMENT');
      }
      const changed = !old || old.start.toISOString() !== new Date(p.start).toISOString() ||
        old.end.toISOString() !== new Date(p.end).toISOString() || old.location !== p.location ||
        old.address !== p.address || old.consultationUrl !== p.consultationUrl || old.modality !== p.modality;
      const data = { ...p, start: new Date(p.start), end: new Date(p.end),
        followUpAt: p.followUpAt ? new Date(p.followUpAt) : null,
        bookingStatus: changed ? (p.doctorId ? 'requested' : 'recorded') : old!.bookingStatus };
      await tx.appointment.upsert({ where: key(userId, a.id),
        create: { userId, id: a.id, ...data, origin: 'patient' }, update: { ...data, version: { increment: 1 } } });
    } else {
      if (!old) return fail(404, 'APPOINTMENT_NOT_FOUND');
      let data: Prisma.AppointmentUncheckedUpdateInput = { version: { increment: 1 } };
      switch (a.type) {
        case 'patient_notes':
          patientOnly();
          if (a.followUpAt && new Date(a.followUpAt) < old.end) fail(400, 'FOLLOW_UP_PRECEDES_APPOINTMENT_END');
          data.patientNotes = a.text;
          data.followUpAt = a.followUpAt ? new Date(a.followUpAt) : null;
          break;
        case 'archive':
          patientOnly(); data.archivedAt = a.archived ? new Date() : null; break;
        case 'confirm':
          if (actor.role !== 'doctor') fail(403, 'DOCTOR_ACTION_REQUIRED');
          if (old.status !== 'scheduled' || old.end <= new Date()) fail(409, 'APPOINTMENT_NOT_SCHEDULABLE');
          data.bookingStatus = 'confirmed'; break;
        case 'reschedule':
          if (old.status !== 'scheduled') fail(409, 'APPOINTMENT_CLOSED');
          if (new Date(a.start) <= new Date()) fail(400, 'RESCHEDULE_REQUIRES_FUTURE_DATE');
          if (old.followUpAt && old.followUpAt < new Date(a.end)) fail(409, 'REVIEW_FOLLOW_UP_DATE');
          data = { ...data, start: new Date(a.start), end: new Date(a.end), timezone: a.timezone,
            bookingStatus: old.doctorId ? 'requested' : 'recorded' }; break;
        case 'status':
          if (old.status !== 'scheduled' && a.status !== old.status) fail(409, 'APPOINTMENT_CLOSED');
          if (a.status === 'no_show' && old.end > new Date()) fail(400, 'APPOINTMENT_NOT_ENDED');
          if (a.status === 'completed' && old.start > new Date()) fail(400, 'APPOINTMENT_NOT_STARTED');
          data.status = a.status; break;
        case 'clinical_note':
          clinician();
          await tx.appointmentClinicalNote.create({ data: { userId, id: a.noteId, appointmentId: a.id, doctorId: actor.id, text: a.text } }); break;
        case 'issue_prescription': {
          clinician();
          if (a.supersedesId) {
            const prior = await tx.prescription.findUnique({ where: key(userId, a.supersedesId) });
            if (!prior || prior.appointmentId !== a.id || prior.doctorId !== actor.id || prior.revokedAt || prior.id === a.prescriptionId)
              fail(400, 'INVALID_SUPERSEDED_PRESCRIPTION');
            await tx.prescription.update({ where: key(userId, prior.id), data: { revokedAt: new Date(), revocationReason: `Replaced by ${a.prescriptionId}` } });
          }
          await tx.prescription.create({ data: { userId, id: a.prescriptionId, appointmentId: a.id, doctorId: actor.id,
            doctorName: old.doctorName, instructions: a.instructions, items: json(a.items), supersedesId: a.supersedesId } });
          break;
        }
        case 'revoke_prescription': {
          if (actor.role !== 'doctor') fail(403, 'DOCTOR_ACTION_REQUIRED');
          const prescription = await tx.prescription.findUnique({ where: key(userId, a.prescriptionId) });
          if (!prescription || prescription.appointmentId !== a.id || prescription.doctorId !== actor.id) fail(404, 'PRESCRIPTION_NOT_FOUND');
          if (prescription.revokedAt) fail(409, 'PRESCRIPTION_ALREADY_REVOKED');
          await tx.prescription.update({ where: key(userId, a.prescriptionId), data: { revokedAt: new Date(), revocationReason: a.reason } }); break;
        }
      }
      await tx.appointment.update({ where: key(userId, a.id), data });
    }
    const current = await tx.appointment.findUniqueOrThrow({ where: key(userId, a.id) });
    await tx.appointmentEvent.create({ data: { userId, id: op.operationId, appointmentId: a.id, actorId: actor.id,
      kind: a.type, snapshot: json({ actorRole: actor.role, before: old, after: current, action: a }) } });
    const result = { result: 'OK', operationId: op.operationId, id: a.id, version: current.version };
    await tx.appointmentOperation.create({ data: { userId, id: op.operationId, actorId: actor.id, requestHash: hash, result } });
    return result;
  }, { timeout: 30000 });
}
