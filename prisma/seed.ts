import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { env } from '../src/app/env.js';

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter,
});

const vegetativeQuestions = [
  {
    groupId: 1,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Duerme bien?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 2,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Cuántas horas duerme al día?',
    answerType: 'OP',
    active: true,
  },
  {
    groupId: 3,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Le cuesta dormirse o mantener el sueño?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 4,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Cuántas veces se despierta por la noche?',
    answerType: 'OP',
    active: true,
  },
  {
    groupId: 5,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Siente molestias o dolor cuando orina?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 6,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Se despierta por la noche para ir al baño?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 7,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Con qué frecuencia va al baño?',
    answerType: 'OP',
    active: true,
  },
  {
    groupId: 8,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Tiene pérdidas de orina?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 9,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Hace de vientre de forma regular?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 10,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Suda más o menos de lo habitual?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 11,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Ha tenido cambios de peso no voluntarios últimamente?',
    answerType: 'YN',
    active: true,
  },
  {
    groupId: 12,
    askLevel: 0,
    dependencyAskLevel: 0,
    askGroup: 'FuncionesVegetativas',
    questionText: '¿Ha notado cambios en su libido?',
    answerType: 'YN',
    active: true,
  },
];

async function main() {
  await prisma.questionnaireQuestion.deleteMany({
    where: { askGroup: 'FuncionesVegetativas' },
  });

  await prisma.questionnaireQuestion.createMany({
    data: vegetativeQuestions,
  });

  console.log('Seed completed: FuncionesVegetativas questions loaded.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
