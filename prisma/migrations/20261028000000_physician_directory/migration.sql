CREATE TABLE "Physician" (
 "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "specialties" JSONB NOT NULL,
 "offices" JSONB NOT NULL, "affiliationStatus" TEXT NOT NULL DEFAULT 'external',
 "fetchedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "Physician_affiliation_check" CHECK ("affiliationStatus" IN ('external','candidate','contacted','affiliated'))
);
CREATE TABLE "PhysicianSource" (
 "id" TEXT PRIMARY KEY, "physicianId" TEXT NOT NULL REFERENCES "Physician"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "provider" TEXT NOT NULL, "profileUrl" TEXT NOT NULL, "externalId" TEXT,
 "fetchedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "PhysicianSource_provider_profileUrl_key" ON "PhysicianSource"("provider", "profileUrl");
CREATE UNIQUE INDEX "PhysicianSource_provider_externalId_key" ON "PhysicianSource"("provider", "externalId");
ALTER TABLE "Appointment" ADD COLUMN "directoryDoctorId" TEXT;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_directoryDoctorId_fkey" FOREIGN KEY ("directoryDoctorId") REFERENCES "Physician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Appointment_directoryDoctorId_status_start_idx" ON "Appointment"("directoryDoctorId", "status", "start");
