import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../infrastructure/db/prisma.js';
import { requireRole } from '../../shared/auth/current-user.js';

export const summaryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const [answersCount, notesCount, sharesCount] = await Promise.all([
      prisma.questionnaireAnswer.count({
        where: { userId: user.id },
      }),
      prisma.medicalHistoryNote.count({
        where: { userId: user.id },
      }),
      prisma.sharedAccess.count({
        where: { ownerUserId: user.id },
      }),
    ]);

    const latestAnswer = await prisma.questionnaireAnswer.findFirst({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      include: { question: true },
    });

    const latestNote = await prisma.medicalHistoryNote.findFirst({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      result: 'OK',
      summary: {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.status,
          alias: user.patientProfile?.alias ?? null,
          sex: user.patientProfile?.sex ?? null,
          phone: user.patientProfile?.phone ?? null,
        },
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
      },
    };
  });
};
