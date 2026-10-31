import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';
import { ClinicalAccessError, lockDoctor } from './clinical-access.service.js';

const userId = z.string().trim().min(1).max(160);
const reference = z.string().trim().min(3).max(200);
export const onboardingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), username: z.string().trim().min(3).max(32),
    password: z.string().min(12).max(72).refine(s => Buffer.byteLength(s, 'utf8') <= 72),
    verificationReference: reference }).strict(),
  z.object({ action: z.literal('approve'), userId, verificationReference: reference }).strict(),
  z.object({ action: z.literal('revoke'), userId, reason: reference }).strict(),
]);

// Internal operator capability only. No HTTP route imports or exposes this.
export async function onboardDoctor(input: unknown, operator: string) {
  const action = onboardingSchema.parse(input);
  z.string().trim().min(1).max(100).parse(operator);
  if (action.action === 'create') {
    const passwordHash = await bcrypt.hash(action.password, 10);
    return prisma.$transaction(async tx => {
      const user = await tx.user.create({ data: { username: action.username, passwordHash, role: 'doctor', status: 'active' } });
      await tx.doctorApproval.create({ data: { userId: user.id, approvedAt: new Date(), approvedBy: operator,
        verificationReference: action.verificationReference,
        events: { create: { operator, action: 'created-approved', reference: action.verificationReference } } } });
      return { result: 'OK', userId: user.id, action: 'created-approved' };
    });
  }
  return prisma.$transaction(async tx => {
    await lockDoctor(tx, action.userId);
    const user = await tx.user.findUnique({ where: { id: action.userId }, include: { doctorApproval: true } });
    if (!user || user.role !== 'doctor') throw new ClinicalAccessError(404, 'DOCTOR_NOT_FOUND');
    if (action.action === 'approve') {
      if (user.status !== 'active') throw new ClinicalAccessError(403, 'INACTIVE_USER');
      await tx.doctorApproval.upsert({ where: { userId: user.id },
        create: { userId: user.id, approvedAt: new Date(), approvedBy: operator, verificationReference: action.verificationReference },
        update: { approvedAt: new Date(), approvedBy: operator, verificationReference: action.verificationReference, revokedAt: null } });
      await tx.doctorApprovalEvent.create({ data: { doctorId: user.id, operator, action: 'approved', reference: action.verificationReference } });
    } else {
      if (!user.doctorApproval) throw new ClinicalAccessError(404, 'DOCTOR_APPROVAL_NOT_FOUND');
      if (!user.doctorApproval.revokedAt) {
        await tx.doctorApproval.update({ where: { userId: user.id }, data: { revokedAt: new Date() } });
        await tx.doctorApprovalEvent.create({ data: { doctorId: user.id, operator, action: 'revoked', reference: action.reason } });
      }
      await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      const grants = await tx.patientDoctorGrant.findMany({ where: { doctorId: user.id, revokedAt: null } });
      for (const grant of grants) {
        const revoked = await tx.patientDoctorGrant.update({ where: { id: grant.id },
          data: { revokedAt: new Date(), version: { increment: 1 } } });
        await tx.patientDoctorGrantEvent.create({ data: { grantId: grant.id, action: 'doctor-approval-revoked',
          snapshot: JSON.parse(JSON.stringify({ ...revoked, operator })) } });
      }
    }
    return { result: 'OK', userId: user.id, action: action.action };
  });
}
