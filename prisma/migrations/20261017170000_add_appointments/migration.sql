-- CreateTable
CREATE TABLE "Appointment" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "doctorId" TEXT,
    "doctorName" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "mapUrl" TEXT,
    "consultationUrl" TEXT,
    "modality" TEXT NOT NULL DEFAULT 'in_person',
    "origin" TEXT NOT NULL DEFAULT 'patient',
    "bookingStatus" TEXT NOT NULL DEFAULT 'recorded',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "archivedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL DEFAULT '',
    "preparation" TEXT NOT NULL DEFAULT '',
    "patientNotes" TEXT NOT NULL DEFAULT '',
    "followUpAt" TIMESTAMP(3),
    "previousAppointmentId" TEXT,
    "reminder24h" BOOLEAN NOT NULL DEFAULT true,
    "reminder1h" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "AppointmentEvent" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "AppointmentClinicalNote" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentClinicalNote_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "Prescription" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "doctorName" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "supersedesId" TEXT,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "AppointmentOperation" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentOperation_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE INDEX "Appointment_userId_start_id_idx" ON "Appointment"("userId", "start", "id");

-- CreateIndex
CREATE INDEX "Appointment_doctorId_start_id_idx" ON "Appointment"("doctorId", "start", "id");

-- CreateIndex
CREATE INDEX "AppointmentEvent_userId_appointmentId_createdAt_idx" ON "AppointmentEvent"("userId", "appointmentId", "createdAt");

-- CreateIndex
CREATE INDEX "Prescription_userId_appointmentId_issuedAt_idx" ON "Prescription"("userId", "appointmentId", "issuedAt");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_userId_previousAppointmentId_fkey" FOREIGN KEY ("userId", "previousAppointmentId") REFERENCES "Appointment"("userId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_userId_appointmentId_fkey" FOREIGN KEY ("userId", "appointmentId") REFERENCES "Appointment"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentClinicalNote" ADD CONSTRAINT "AppointmentClinicalNote_userId_appointmentId_fkey" FOREIGN KEY ("userId", "appointmentId") REFERENCES "Appointment"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentClinicalNote" ADD CONSTRAINT "AppointmentClinicalNote_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_userId_appointmentId_fkey" FOREIGN KEY ("userId", "appointmentId") REFERENCES "Appointment"("userId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_userId_supersedesId_fkey" FOREIGN KEY ("userId", "supersedesId") REFERENCES "Prescription"("userId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

