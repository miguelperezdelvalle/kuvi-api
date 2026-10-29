import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../app/env.js';

// Internal report only: no route accessible to patients or unaffiliated doctors.
// Counts derive from current appointment rows, never synchronization events.
export async function physicianMetrics(since: Date, until = new Date(), limit = 100) {
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since > until ||
      !Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('Invalid report range');
  const schema = new URL(env.DATABASE_URL).searchParams.get('schema') ?? 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw Error('Invalid database schema');
  const appointments = Prisma.raw(`"${schema}"."Appointment"`);
  const physicians = Prisma.raw(`"${schema}"."Physician"`);
  return prisma.$queryRaw`
    WITH per_patient AS (
      SELECT "directoryDoctorId" AS physician, "userId",
        COUNT(*) FILTER (WHERE status = 'completed' AND start <= ${until}) AS completed,
        COUNT(*) FILTER (WHERE status = 'completed' AND start >= ${since} AND start <= ${until}) AS recent
      FROM ${appointments} WHERE "directoryDoctorId" IS NOT NULL AND "createdAt" <= ${until}
      GROUP BY "directoryDoctorId", "userId"
    ), totals AS (
      SELECT "directoryDoctorId" AS physician,
        COUNT(*)::int AS "registeredAppointments",
        COUNT(DISTINCT "userId")::int AS "distinctPatients",
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS "cancelledAppointments",
        COUNT(*) FILTER (WHERE status = 'no_show')::int AS "missedAppointments",
        COUNT(*) FILTER (WHERE status = 'completed' AND start <= ${until})::int AS "completedAppointments",
        COUNT(*) FILTER (WHERE status = 'completed' AND start >= ${since} AND start <= ${until})::int AS "recentCompletedAppointments",
        COUNT(DISTINCT "userId") FILTER (WHERE status = 'completed' AND start >= ${since} AND start <= ${until})::int AS "recentDistinctPatients",
        MAX(start) FILTER (WHERE status = 'completed' AND start <= ${until}) AS "lastCompletedAt"
      FROM ${appointments} WHERE "directoryDoctorId" IS NOT NULL AND "createdAt" <= ${until} GROUP BY "directoryDoctorId"
    ), repeat_patients AS (
      SELECT physician, COUNT(*) FILTER (WHERE completed >= 2)::int AS "returningPatients",
        COUNT(*) FILTER (WHERE recent >= 2)::int AS "recentReturningPatients" FROM per_patient GROUP BY physician
    )
    SELECT p.id, p.name, p."affiliationStatus", t."registeredAppointments", t."distinctPatients",
      t."completedAppointments", t."recentCompletedAppointments", t."recentDistinctPatients",
      t."cancelledAppointments", t."missedAppointments", r."returningPatients", r."recentReturningPatients", t."lastCompletedAt"
    FROM ${physicians} p JOIN totals t ON t.physician = p.id JOIN repeat_patients r ON r.physician = p.id
    ORDER BY t."recentDistinctPatients" DESC, t."recentCompletedAppointments" DESC, p.id LIMIT ${limit}`;
}
