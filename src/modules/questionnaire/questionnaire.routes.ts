import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import { requireRole } from '../../shared/auth/current-user.js';

const submitAnswersSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().trim().min(1),
        value: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1),
});

export const questionnaireRoutes: FastifyPluginAsync = async (app) => {
  app.get('/vegetative-functions', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const questions = await prisma.questionnaireQuestion.findMany({
      where: {
        askGroup: 'FuncionesVegetativas',
        active: true,
      },
      orderBy: {
        groupId: 'asc',
      },
    });

    return {
      value: questions.map((question) => ({
        keyForidTable: question.id,
        keyForidgroup: question.groupId,
        keyForasklevel: question.askLevel,
        keyFordependecyasklevel: question.dependencyAskLevel,
        keyForaskgroup: question.askGroup,
        keyForquestion: question.questionText,
        answertype: question.answerType,
      })),
      Count: questions.length,
    };
  });

  app.post('/answers', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const body = submitAnswersSchema.parse(request.body);

    const questionIds = [...new Set(body.answers.map((answer) => answer.questionId))];

    const questions = await prisma.questionnaireQuestion.findMany({
      where: {
        id: { in: questionIds },
        active: true,
      },
    });

    if (questions.length !== questionIds.length) {
      return reply.code(400).send({
        result: 'KO',
        message: 'Some questions do not exist or are inactive',
      });
    }

    const questionMap = new Map(questions.map((question) => [question.id, question]));

    const saved = [];

    for (const answer of body.answers) {
      const question = questionMap.get(answer.questionId);

      if (!question) {
        continue;
      }

      const record = await prisma.questionnaireAnswer.upsert({
        where: {
          userId_questionId: {
            userId: user.id,
            questionId: question.id,
          },
        },
        update: {
          answerValue: answer.value,
        },
        create: {
          userId: user.id,
          questionId: question.id,
          answerValue: answer.value,
        },
      });

      saved.push({
        answerId: record.id,
        questionId: record.questionId,
      });
    }

    return {
      result: 'OK',
      message: 'answers saved',
      savedCount: saved.length,
      saved,
    };
  });

  app.get('/answers/me', async (request, reply) => {
    const user = await requireRole(request, reply, 'patient');
    if (!user) return;

    const answers = await prisma.questionnaireAnswer.findMany({
      where: {
        userId: user.id,
      },
      include: {
        question: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      result: 'OK',
      count: answers.length,
      value: answers.map((answer) => ({
        answerId: answer.id,
        questionId: answer.questionId,
        questionText: answer.question.questionText,
        askGroup: answer.question.askGroup,
        answerType: answer.question.answerType,
        value: answer.answerValue,
        createdAt: answer.createdAt,
        updatedAt: answer.updatedAt,
      })),
    };
  });
};
