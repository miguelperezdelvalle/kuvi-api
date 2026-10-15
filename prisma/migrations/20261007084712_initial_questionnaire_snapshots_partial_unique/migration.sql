BEGIN;

-- Keep only the most recent questionnaire snapshot for each patient and snapshot type.
WITH ranked_snapshots AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "noteType"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "MedicalHistoryNote"
  WHERE "noteType" IN (
    'initial_questionnaire_basic_snapshot',
    'initial_questionnaire_complementary_snapshot'
  )
)
DELETE FROM "MedicalHistoryNote" AS note
USING ranked_snapshots
WHERE note."id" = ranked_snapshots."id"
  AND ranked_snapshots.rn > 1;

-- CreateIndex
CREATE UNIQUE INDEX "MedicalHistoryNote_userId_noteType_key"
ON "MedicalHistoryNote"("userId", "noteType")
WHERE ("noteType" IN ('initial_questionnaire_basic_snapshot', 'initial_questionnaire_complementary_snapshot'));

COMMIT;
