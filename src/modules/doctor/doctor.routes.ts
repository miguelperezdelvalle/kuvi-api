import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import { requireRole } from '../../shared/auth/current-user.js';

async function buildPatientSummary(patientId: string) {
  const [answersCount, notesCount, sharesCount, latestAnswer, latestNote] =
    await Promise.all([
      prisma.questionnaireAnswer.count({
        where: { userId: patientId },
      }),
      prisma.medicalHistoryNote.count({
        where: { userId: patientId },
      }),
      prisma.sharedAccess.count({
        where: { ownerUserId: patientId },
      }),
      prisma.questionnaireAnswer.findFirst({
        where: { userId: patientId },
        orderBy: { updatedAt: 'desc' },
        include: { question: true },
      }),
      prisma.medicalHistoryNote.findFirst({
        where: { userId: patientId },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

  return {
    counts: {
      answers: answersCount,
      medicalNotes: notesCount,
      sharedAccesses: sharesCount,
    },
    latest: {
      answer: latestAnswer
        ? {
            id: latestAnswer.id,
            questionText: latestAnswer.question.questionText,
            answerValue: latestAnswer.answerValue,
            updatedAt: latestAnswer.updatedAt,
          }
        : null,
      note: latestNote
        ? {
            id: latestNote.id,
            noteType: latestNote.noteType,
            noteText: latestNote.noteText,
            updatedAt: latestNote.updatedAt,
          }
        : null,
    },
  };
}

export const doctorRoutes: FastifyPluginAsync = async (app) => {
  app.get('/patients', async (request, reply) => {
    const doctor = await requireRole(request, reply, 'doctor');
    if (!doctor) return;

    const patients = await prisma.user.findMany({
      where: {
        role: 'patient',
      },
      include: {
        patientProfile: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const value = await Promise.all(
      patients.map(async (patient) => {
        const summary = await buildPatientSummary(patient.id);

        return {
          id: patient.id,
          username: patient.username,
          status: patient.status,
          alias: patient.patientProfile?.alias ?? null,
          sex: patient.patientProfile?.sex ?? null,
          phone: patient.patientProfile?.phone ?? null,
          ...summary,
        };
      }),
    );

    return {
      result: 'OK',
      count: value.length,
      value,
    };
  });

  app.get('/patients/:id/summary', async (request, reply) => {
    const doctor = await requireRole(request, reply, 'doctor');
    if (!doctor) return;

    const params = z.object({
      id: z.string().min(1),
    }).parse(request.params);

    const patient = await prisma.user.findUnique({
      where: { id: params.id },
      include: {
        patientProfile: true,
      },
    });

    if (!patient) {
      return reply.code(404).send({
        result: 'KO',
        message: 'Patient not found',
      });
    }

    if (patient.role !== 'patient') {
      return reply.code(403).send({
        result: 'KO',
        message: 'Forbidden',
      });
    }

    const summary = await buildPatientSummary(patient.id);

    return {
      result: 'OK',
      patient: {
        id: patient.id,
        username: patient.username,
        status: patient.status,
        alias: patient.patientProfile?.alias ?? null,
        sex: patient.patientProfile?.sex ?? null,
        phone: patient.patientProfile?.phone ?? null,
      },
      ...summary,
    };
  });
};
