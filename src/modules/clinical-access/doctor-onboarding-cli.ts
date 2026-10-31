import { userInfo } from 'node:os';
import { onboardDoctor } from './doctor-onboarding.js';
import { ClinicalAccessError } from './clinical-access.service.js';
import { prisma } from '../../infrastructure/db/prisma.js';

try {
  if (process.env.KUVI_OPERATOR_CONFIRM !== '1') throw new ClinicalAccessError(403, 'OPERATOR_CONFIRMATION_REQUIRED');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 8192) throw new ClinicalAccessError(400, 'INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  const result = await onboardDoctor(JSON.parse(Buffer.concat(chunks).toString('utf8')), userInfo().username);
  console.log(JSON.stringify(result));
} catch (error) {
  // Never print input, password, hashes, database configuration or raw errors.
  const code = error instanceof ClinicalAccessError ? error.code :
    typeof error === 'object' && error && 'code' in error && error.code === 'P2002' ? 'ACCOUNT_ALREADY_EXISTS' : 'ONBOARDING_FAILED';
  console.error(JSON.stringify({ result: 'KO', code })); process.exitCode = 1;
} finally { await prisma.$disconnect(); }
