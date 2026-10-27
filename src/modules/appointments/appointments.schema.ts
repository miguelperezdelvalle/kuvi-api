import { z } from 'zod';

export const id = z.string().trim().min(1).max(160);
const text = (max: number) => z.string().trim().max(max);
const date = z.iso.datetime({ offset: true });
const url = z.url().max(2000).refine(v => {
  const u = new URL(v);
  return u.protocol === 'https:' && !u.username && !u.password;
}, 'Use an HTTPS URL without credentials');
const timezone = text(100).refine(v => {
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return v.length > 0; } catch { return false; }
}, 'Invalid timezone');
const version = z.number().int().min(1);
const appointment = z.object({
  doctorId: id.nullable(), doctorName: text(200).min(1), specialty: text(200).min(1),
  start: date, end: date, timezone, location: text(500), address: text(1000).default(''),
  mapUrl: url.nullable().default(null), consultationUrl: url.nullable().default(null),
  modality: z.enum(['in_person', 'video']), reason: text(2000).default(''),
  preparation: text(4000).default(''), patientNotes: text(8000).default(''),
  followUpAt: date.nullable().default(null), previousAppointmentId: id.nullable().default(null),
  reminder24h: z.boolean(), reminder1h: z.boolean(),
}).strict().superRefine((a, ctx) => {
  if (new Date(a.end) <= new Date(a.start)) ctx.addIssue({ code: 'custom', message: 'End must follow start' });
  if (a.modality === 'in_person' && !a.location) ctx.addIssue({ code: 'custom', message: 'Location required' });
  if (a.modality === 'video' && !a.consultationUrl) ctx.addIssue({ code: 'custom', message: 'Consultation URL required' });
  if (a.followUpAt && new Date(a.followUpAt) < new Date(a.end)) ctx.addIssue({ code: 'custom', message: 'Follow-up precedes appointment end' });
});
const item = z.object({
  id, name: text(200).min(1), ingredients: text(2000).default(''),
  strength: text(200).default(''), form: text(100).default(''),
  dose: text(500).min(1), route: text(200).min(1), frequency: text(1000).min(1),
  duration: text(500).min(1), instructions: text(2000).default(''),
  asNeeded: z.boolean().default(false), maxDailyDose: text(500).default(''),
}).strict();
export const operationSchema = z.object({ operationId: id,
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('save'), id, expectedVersion: z.number().int().min(0), appointment }).strict(),
    z.object({ type: z.literal('status'), id, expectedVersion: version,
      status: z.enum(['scheduled', 'cancelled', 'completed', 'no_show']), reason: text(1000).min(1) }).strict(),
    z.object({ type: z.literal('archive'), id, expectedVersion: version, archived: z.boolean() }).strict(),
    z.object({ type: z.literal('patient_notes'), id, expectedVersion: version, text: text(8000),
      followUpAt: date.nullable() }).strict(),
    z.object({ type: z.literal('confirm'), id, expectedVersion: version }).strict(),
    z.object({ type: z.literal('reschedule'), id, expectedVersion: version, start: date, end: date,
      timezone, reason: text(1000).min(1) }).strict(),
    z.object({ type: z.literal('clinical_note'), id, expectedVersion: version, noteId: id, text: text(8000).min(1) }).strict(),
    z.object({ type: z.literal('issue_prescription'), id, expectedVersion: version, prescriptionId: id,
      instructions: text(8000).default(''), items: z.array(item).min(1).max(50), supersedesId: id.nullable().default(null) }).strict(),
    z.object({ type: z.literal('revoke_prescription'), id, expectedVersion: version,
      prescriptionId: id, reason: text(2000).min(1) }).strict(),
  ]) }).strict().superRefine(({ action: a }, ctx) => {
    if (a.type === 'reschedule' && new Date(a.end) <= new Date(a.start))
      ctx.addIssue({ code: 'custom', message: 'End must follow start' });
    if (a.type === 'issue_prescription' && new Set(a.items.map(i => i.id)).size !== a.items.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate prescription item ID' });
  });
export const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1000).optional(), archived: z.enum(['true', 'false', 'all']).default('all'),
}).strict();
