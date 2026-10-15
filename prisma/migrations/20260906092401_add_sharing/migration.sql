-- CreateTable
CREATE TABLE "SharedAccess" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'summary',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SharedAccess_shareToken_key" ON "SharedAccess"("shareToken");

-- CreateIndex
CREATE INDEX "SharedAccess_ownerUserId_idx" ON "SharedAccess"("ownerUserId");

-- CreateIndex
CREATE INDEX "SharedAccess_shareToken_idx" ON "SharedAccess"("shareToken");

-- AddForeignKey
ALTER TABLE "SharedAccess" ADD CONSTRAINT "SharedAccess_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
