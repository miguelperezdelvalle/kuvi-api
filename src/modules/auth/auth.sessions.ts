import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/db/prisma.js';
import { env } from '../../app/env.js';

export const refreshHash = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export class AuthSessions {
  async create(userId: string) {
    const id = randomUUID(), refreshToken = newToken();
    const expiresAt = new Date(Date.now() + env.AUTH_SESSION_TTL_SECONDS * 1000);
    await prisma.authSession.create({ data: {
      id, userId, expiresAt,
      refreshTokens: { create: { tokenHash: refreshHash(refreshToken) } },
    } });
    return { id, refreshToken, expiresAt };
  }

  async rotate(refreshToken: string) {
    const tokenHash = refreshHash(refreshToken);
    const known = await prisma.authRefreshToken.findUnique({ where: { tokenHash } });
    if (!known) return null;
    return prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth:${known.sessionId}`}, 0))`;
      const token = await tx.authRefreshToken.findUnique({ where: { tokenHash },
        include: { session: { include: { user: true } } } });
      if (!token) return null;
      const session = token.session;
      if (session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'active') return null;
      if (token.usedAt) {
        // Commit revocation on replay. Throwing here would roll it back.
        await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
        return null;
      }
      const next = newToken();
      await tx.authRefreshToken.update({ where: { tokenHash }, data: { usedAt: new Date() } });
      await tx.authRefreshToken.create({ data: { tokenHash: refreshHash(next), sessionId: session.id } });
      return { id: session.id, refreshToken: next, expiresAt: session.expiresAt, user: session.user };
    });
  }

  async revoke(refreshToken: string) {
    const known = await prisma.authRefreshToken.findUnique({ where: { tokenHash: refreshHash(refreshToken) } });
    if (!known) return;
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth:${known.sessionId}`}, 0))`;
      await tx.authSession.updateMany({ where: { id: known.sessionId, revokedAt: null },
        data: { revokedAt: new Date() } });
    });
  }
}
