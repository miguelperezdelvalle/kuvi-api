-- CreateTable
CREATE TABLE "MedicalHistoryNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noteType" TEXT NOT NULL,
    "noteText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicalHistoryNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MedicalHistoryNote_userId_idx" ON "MedicalHistoryNote"("userId");

-- CreateIndex
CREATE INDEX "MedicalHistoryNote_noteType_idx" ON "MedicalHistoryNote"("noteType");

-- AddForeignKey
ALTER TABLE "MedicalHistoryNote" ADD CONSTRAINT "MedicalHistoryNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
