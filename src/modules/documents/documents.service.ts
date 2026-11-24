import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { prisma } from '../../infrastructure/db/prisma.js';

export const MAX_DOCUMENT_BODY = 14 * 1024 * 1024;
const MAX_CONTENT = 10 * 1024 * 1024;
export interface DocumentLimits { quotaBytes: number; maxDocuments: number }
export class DocumentError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const invalid = () => new DocumentError(400, 'INVALID_ENCRYPTED_DOCUMENT', 'El archivo cifrado no es válido.');
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const base64 = (max: number, exact?: number) => z.string().max(4 * Math.ceil(max / 3)).refine(value => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > max || (exact !== undefined && bytes.length !== exact)) return false;
  return value === bytes.toString('base64url') || value === bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_');
});
const box = (max: number, exact?: number) => z.object({ nonce: base64(12, 12),
  ciphertext: base64(max, exact), tag: base64(16, 16) }).strict();
const envelope = z.object({ format: z.literal('kuvi-document'), version: z.literal(1),
  ownerId: id, vaultId: id, documentId: id, key: box(32, 32), metadata: box(4096).refine(value => value.ciphertext.length > 0),
  content: box(MAX_CONTENT).refine(value => value.ciphertext.length > 0) }).strict();

export function documentId(value: unknown): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
export function documentLimits(options: Partial<DocumentLimits> = {}): DocumentLimits {
  const quotaBytes = options.quotaBytes ?? Number(process.env.DOCUMENT_BACKUP_QUOTA_BYTES ?? 250 * 1024 * 1024);
  const maxDocuments = options.maxDocuments ?? Number(process.env.DOCUMENT_BACKUP_MAX_FILES ?? 100);
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1 || quotaBytes > 20 * 1024 ** 3 ||
      !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 5000) {
    throw new Error('Invalid document backup limits');
  }
  return { quotaBytes, maxDocuments };
}
export function parseDocument(userId: string, requestedId: string, input: unknown) {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > MAX_DOCUMENT_BODY) throw invalid();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); }
  catch { throw invalid(); }
  const parsed = envelope.safeParse(value);
  if (!parsed.success || parsed.data.ownerId !== userId || parsed.data.documentId !== requestedId) throw invalid();
  return { bytes: input, vaultId: parsed.data.vaultId,
    sha256: createHash('sha256').update(input).digest('hex') };
}
const select = { documentId: true, sha256: true, sizeBytes: true, createdAt: true } as const;

export async function putDocument(userId: string, requestedId: string, input: unknown, limits: DocumentLimits) {
  const document = parseDocument(userId, documentId(requestedId), input);
  return prisma.$transaction(async tx => {
    // Every writer for an account takes the same lock before checking quotas.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`documents:${userId}`}))::text`;
    const existing = await tx.documentBackup.findUnique({ where: { userId_documentId: { userId, documentId: requestedId } } });
    if (existing) {
      if (existing.sha256 !== document.sha256 || !Buffer.from(existing.content).equals(document.bytes)) {
        throw new DocumentError(409, 'DOCUMENT_BACKUP_CONFLICT', 'Ya existe una copia distinta. No se sustituyó el respaldo.');
      }
      return { result: 'OK', documentId: requestedId, sha256: existing.sha256, sizeBytes: existing.sizeBytes, created: false };
    }
    const vault = await tx.documentBackupVault.findUnique({ where: { userId } });
    if (vault && vault.vaultId !== document.vaultId) {
      throw new DocumentError(409, 'DOCUMENT_VAULT_MISMATCH', 'El respaldo pertenece a otra clave de recuperación. No se modificó.');
    }
    const usage = await tx.documentBackup.aggregate({ where: { userId }, _sum: { sizeBytes: true }, _count: true });
    if (usage._count >= limits.maxDocuments || (usage._sum.sizeBytes ?? 0) + document.bytes.length > limits.quotaBytes) {
      throw new DocumentError(409, 'DOCUMENT_QUOTA_EXCEEDED', 'El respaldo alcanzó su límite de espacio o cantidad de documentos.');
    }
    if (!vault) await tx.documentBackupVault.create({ data: { userId, vaultId: document.vaultId } });
    const saved = await tx.documentBackup.create({ data: { userId, documentId: requestedId,
      content: new Uint8Array(document.bytes), sha256: document.sha256, sizeBytes: document.bytes.length } });
    return { result: 'OK', documentId: requestedId, sha256: saved.sha256, sizeBytes: saved.sizeBytes, created: true };
  }, { maxWait: 15000, timeout: 30000 });
}

export async function listDocuments(userId: string, cursor: unknown, limits: DocumentLimits) {
  if (cursor !== undefined) documentId(cursor);
  const [vault, usage, rows] = await Promise.all([
    prisma.documentBackupVault.findUnique({ where: { userId } }),
    prisma.documentBackup.aggregate({ where: { userId }, _sum: { sizeBytes: true }, _count: true }),
    prisma.documentBackup.findMany({ where: { userId, ...(cursor ? { documentId: { gt: cursor as string } } : {}) },
      orderBy: { documentId: 'asc' }, take: 51, select }),
  ]);
  return { result: 'OK', vaultId: vault?.vaultId ?? null, quotaBytes: limits.quotaBytes,
    maxDocuments: limits.maxDocuments, usedBytes: usage._sum.sizeBytes ?? 0, count: usage._count,
    items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.documentId : null };
}

export async function getDocument(userId: string, requestedId: string) {
  const row = await prisma.documentBackup.findUnique({ where: { userId_documentId: { userId, documentId: documentId(requestedId) } } });
  if (!row) throw new DocumentError(404, 'DOCUMENT_BACKUP_NOT_FOUND', 'No se encontró esa copia de respaldo.');
  return row;
}

export async function deleteDocument(userId: string, requestedId: string, expectedHash: unknown) {
  documentId(requestedId);
  const match = typeof expectedHash === 'string' ? /^(?:"([a-f0-9]{64})"|([a-f0-9]{64}))$/.exec(expectedHash) : null;
  if (!match) throw invalid();
  const expected = match[1] ?? match[2];
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`documents:${userId}`}))::text`;
    const row = await tx.documentBackup.findUnique({ where: { userId_documentId: { userId, documentId: requestedId } } });
    if (!row) return { result: 'OK', deleted: false };
    if (row.sha256 !== expected) throw new DocumentError(409, 'DOCUMENT_BACKUP_CONFLICT', 'La copia cambió. Actualiza antes de eliminarla.');
    await tx.documentBackup.delete({ where: { userId_documentId: { userId, documentId: requestedId } } });
    return { result: 'OK', deleted: true };
  });
}
