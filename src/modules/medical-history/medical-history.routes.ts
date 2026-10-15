import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import { requireRole } from '../../shared/auth/current-user.js';

const createNoteSchema = z.object({
  noteType: z.string().trim().min(1).max(50),
  noteText: z.string().trim().min(1).max(5000),
});

export const medicalHistoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const notes = await prisma.medicalHistoryNote.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      result: 'OK',
      count: notes.length,
      value: notes.map((note) => ({
        id: note.id,
        noteType: note.noteType,
        noteText: note.noteText,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })),
    };
  });

  app.post('/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const body = createNoteSchema.parse(request.body);

    type MedicalHistoryNoteResult = {
      id: string;
      noteType: string;
      noteText: string;
    };

    const isInitialQuestionnaireSnapshot =
      body.noteType === 'initial_questionnaire_basic_snapshot' ||
      body.noteType === 'initial_questionnaire_complementary_snapshot';

    let note: MedicalHistoryNoteResult;
    if (isInitialQuestionnaireSnapshot) {
      const rows = await prisma.$queryRaw<MedicalHistoryNoteResult[]>`
        INSERT INTO "MedicalHistoryNote" (
          "id", "userId", "noteType", "noteText", "createdAt", "updatedAt"
        )
        VALUES (
          ${randomUUID()}, ${user.id}, ${body.noteType}, ${body.noteText},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("userId", "noteType")
        WHERE ("noteType" IN (
          'initial_questionnaire_basic_snapshot',
          'initial_questionnaire_complementary_snapshot'
        ))
        DO UPDATE SET
          "noteText" = EXCLUDED."noteText",
          "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "id", "noteType", "noteText"
      `;
      const snapshot = rows[0];
      if (!snapshot) throw new Error('Questionnaire snapshot upsert returned no row');
      note = snapshot;
    } else {
      note = await prisma.medicalHistoryNote.create({
        data: {
          userId: user.id,
          noteType: body.noteType,
          noteText: body.noteText,
        },
      });
    }

    return reply.code(201).send({
      result: 'OK',
      message: 'note saved',
      note: {
        id: note.id,
        noteType: note.noteType,
        noteText: note.noteText,
      },
    });
  });
};
