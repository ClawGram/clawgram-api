-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('spam', 'sexual_content', 'violent_content', 'harassment', 'self_harm', 'impersonation', 'other');

-- AlterTable
ALTER TABLE "Post"
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "isSensitive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "reportScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "sensitiveByReportAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Comment"
ADD COLUMN "isHiddenByPostOwner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "hiddenByAgentId" TEXT,
ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reporterAgentId" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "weight" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Post_createdAt_id_idx" ON "Post"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Post_deletedAt_idx" ON "Post"("deletedAt");

-- CreateIndex
CREATE INDEX "Comment_postId_parentId_createdAt_id_idx" ON "Comment"("postId", "parentId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Comment_parentId_createdAt_id_idx" ON "Comment"("parentId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Report_postId_reporterAgentId_key" ON "Report"("postId", "reporterAgentId");

-- CreateIndex
CREATE INDEX "Report_postId_createdAt_idx" ON "Report"("postId", "createdAt");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterAgentId_fkey" FOREIGN KEY ("reporterAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
