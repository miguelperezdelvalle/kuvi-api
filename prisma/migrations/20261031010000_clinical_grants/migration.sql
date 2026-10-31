BEGIN;
CREATE TABLE "DoctorApproval" (
 "userId" TEXT PRIMARY KEY,
 "approvedAt" TIMESTAMP(3) NOT NULL,
 "approvedBy" TEXT NOT NULL,
 "verificationReference" TEXT NOT NULL,
 "revokedAt" TIMESTAMP(3),
 CONSTRAINT "DoctorApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "DoctorApprovalEvent" (
 "id" TEXT PRIMARY KEY, "doctorId" TEXT NOT NULL, "operator" TEXT NOT NULL,
 "action" TEXT NOT NULL, "reference" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DoctorApprovalEvent_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "DoctorApproval"("userId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DoctorApprovalEvent_doctorId_createdAt_idx" ON "DoctorApprovalEvent"("doctorId", "createdAt");
CREATE TABLE "PatientDoctorGrant" (
 "id" TEXT PRIMARY KEY, "patientId" TEXT NOT NULL, "doctorId" TEXT NOT NULL,
 "scopes" TEXT[] NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
 "version" INTEGER NOT NULL DEFAULT 1, "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "PatientDoctorGrant_scopes_check" CHECK (cardinality("scopes") BETWEEN 1 AND 3 AND "scopes" <@ ARRAY['summary','questionnaire','medical-history']::TEXT[]),
 CONSTRAINT "PatientDoctorGrant_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "PatientDoctorGrant_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PatientDoctorGrant_patientId_doctorId_key" ON "PatientDoctorGrant"("patientId", "doctorId");
CREATE INDEX "PatientDoctorGrant_doctorId_revokedAt_expiresAt_idx" ON "PatientDoctorGrant"("doctorId", "revokedAt", "expiresAt");
CREATE TABLE "PatientDoctorGrantEvent" (
 "id" TEXT PRIMARY KEY, "grantId" TEXT NOT NULL, "action" TEXT NOT NULL, "snapshot" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PatientDoctorGrantEvent_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "PatientDoctorGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PatientDoctorGrantEvent_grantId_createdAt_idx" ON "PatientDoctorGrantEvent"("grantId", "createdAt");
COMMIT;
