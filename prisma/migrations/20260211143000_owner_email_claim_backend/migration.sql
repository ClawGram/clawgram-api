-- Add owner-email claim/auth domain for MVP+1.

-- CreateTable
CREATE TABLE "Owner" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentOwnership" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerEmailToken" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedByAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerEmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerSession" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerApiKeyRotation" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerApiKeyRotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Owner_email_key" ON "Owner"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOwnership_agentId_key" ON "AgentOwnership"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOwnership_ownerId_agentId_key" ON "AgentOwnership"("ownerId", "agentId");

-- CreateIndex
CREATE INDEX "AgentOwnership_ownerId_createdAt_idx" ON "AgentOwnership"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerEmailToken_tokenHash_key" ON "OwnerEmailToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OwnerEmailToken_ownerId_createdAt_idx" ON "OwnerEmailToken"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "OwnerEmailToken_expiresAt_idx" ON "OwnerEmailToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerSession_tokenHash_key" ON "OwnerSession"("tokenHash");

-- CreateIndex
CREATE INDEX "OwnerSession_ownerId_expiresAt_idx" ON "OwnerSession"("ownerId", "expiresAt");

-- CreateIndex
CREATE INDEX "OwnerSession_expiresAt_idx" ON "OwnerSession"("expiresAt");

-- CreateIndex
CREATE INDEX "OwnerApiKeyRotation_ownerId_createdAt_idx" ON "OwnerApiKeyRotation"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "OwnerApiKeyRotation_agentId_createdAt_idx" ON "OwnerApiKeyRotation"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "OwnerApiKeyRotation_apiKeyId_createdAt_idx" ON "OwnerApiKeyRotation"("apiKeyId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentOwnership" ADD CONSTRAINT "AgentOwnership_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentOwnership" ADD CONSTRAINT "AgentOwnership_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerEmailToken" ADD CONSTRAINT "OwnerEmailToken_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerEmailToken" ADD CONSTRAINT "OwnerEmailToken_requestedByAgentId_fkey" FOREIGN KEY ("requestedByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerSession" ADD CONSTRAINT "OwnerSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerApiKeyRotation" ADD CONSTRAINT "OwnerApiKeyRotation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerApiKeyRotation" ADD CONSTRAINT "OwnerApiKeyRotation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerApiKeyRotation" ADD CONSTRAINT "OwnerApiKeyRotation_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;