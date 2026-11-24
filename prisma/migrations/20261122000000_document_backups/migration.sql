CREATE TABLE "DocumentBackupVault" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "vaultId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentBackupVault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "DocumentBackup" (
  "userId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "sha256" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentBackup_pkey" PRIMARY KEY ("userId", "documentId"),
  CONSTRAINT "DocumentBackup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DocumentBackup_size_check" CHECK ("sizeBytes" = octet_length("content") AND "sizeBytes" > 0 AND "sizeBytes" <= 14680064),
  CONSTRAINT "DocumentBackup_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);
