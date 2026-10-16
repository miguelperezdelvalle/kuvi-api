-- CreateTable
CREATE TABLE "Medication" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "ingredients" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "stock" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "stockVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Medication_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "MedicationTreatment" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "doctor" TEXT NOT NULL,
    "dose" DECIMAL(18,6) NOT NULL,
    "schedule" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "reminders" BOOLEAN NOT NULL DEFAULT true,
    "lowStockDays" INTEGER NOT NULL DEFAULT 3,
    "lowStockUnits" DECIMAL(18,6) NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicationTreatment_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "MedicationIntake" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "treatmentId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6),
    "unit" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "overrideWarning" BOOLEAN NOT NULL DEFAULT false,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicationIntake_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "MedicationStockMovement" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "treatmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "balanceAfter" DECIMAL(18,6) NOT NULL,
    "intakeId" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationStockMovement_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "MedicationOperation" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationOperation_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE INDEX "MedicationIntake_userId_treatmentId_occurredAt_idx" ON "MedicationIntake"("userId", "treatmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "MedicationStockMovement_userId_treatmentId_createdAt_idx" ON "MedicationStockMovement"("userId", "treatmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationTreatment" ADD CONSTRAINT "MedicationTreatment_userId_id_fkey" FOREIGN KEY ("userId", "id") REFERENCES "Medication"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationIntake" ADD CONSTRAINT "MedicationIntake_userId_treatmentId_fkey" FOREIGN KEY ("userId", "treatmentId") REFERENCES "MedicationTreatment"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationStockMovement" ADD CONSTRAINT "MedicationStockMovement_userId_treatmentId_fkey" FOREIGN KEY ("userId", "treatmentId") REFERENCES "MedicationTreatment"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

