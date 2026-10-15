-- CreateTable
CREATE TABLE "QuestionnaireQuestion" (
    "id" TEXT NOT NULL,
    "groupId" INTEGER NOT NULL,
    "askLevel" INTEGER NOT NULL DEFAULT 0,
    "dependencyAskLevel" INTEGER NOT NULL DEFAULT 0,
    "askGroup" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "answerType" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionnaireQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionnaireQuestion_askGroup_groupId_idx" ON "QuestionnaireQuestion"("askGroup", "groupId");
