import { physicianMetrics } from './physicians.metrics.js';
import { prisma } from '../../infrastructure/db/prisma.js';
const until = new Date();
const since = process.argv[2] ? new Date(process.argv[2]) : new Date(until.getTime() - 90 * 86400000);
try { console.log(JSON.stringify({ since, until,
  unlinkedAppointments: await prisma.appointment.count({ where: { directoryDoctorId: null } }),
  value: await physicianMetrics(since, until) }, null, 2)); }
finally { await prisma.$disconnect(); }
