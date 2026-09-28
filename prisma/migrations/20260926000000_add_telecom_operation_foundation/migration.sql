CREATE TABLE "TelecomOperation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT,
    "phoneNumberId" TEXT,
    "telecomCallId" TEXT,
    "telecomMessageId" TEXT,
    "operationType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKeyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "providerResourceType" TEXT,
    "providerResourceId" TEXT,
    "providerError" TEXT,
    "providerResponseRef" TEXT,
    "providerAcceptedAt" TIMESTAMP(3),
    "providerResolvedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "failureClass" TEXT,
    "reasonCode" TEXT,
    "reconciliationState" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciliationError" TEXT,
    "compensationState" TEXT,
    "compensationStartedAt" TIMESTAMP(3),
    "compensationCompletedAt" TIMESTAMP(3),
    "compensationError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    CONSTRAINT "TelecomOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelecomOperation_organizationId_operationType_idempotencyKeyHash_key"
    ON "TelecomOperation"("organizationId", "operationType", "idempotencyKeyHash");

CREATE INDEX "TelecomOperation_organizationId_createdAt_idx"
    ON "TelecomOperation"("organizationId", "createdAt");

CREATE INDEX "TelecomOperation_status_nextAttemptAt_leaseUntil_idx"
    ON "TelecomOperation"("status", "nextAttemptAt", "leaseUntil");

CREATE INDEX "TelecomOperation_provider_providerResourceType_providerResourceId_idx"
    ON "TelecomOperation"("provider", "providerResourceType", "providerResourceId");

ALTER TABLE "TelecomOperation" ADD CONSTRAINT "TelecomOperation_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TelecomOperation" ADD CONSTRAINT "TelecomOperation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TelecomOperation" ADD CONSTRAINT "TelecomOperation_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TelecomOperation" ADD CONSTRAINT "TelecomOperation_phoneNumberId_fkey"
    FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TelecomOperation" ADD CONSTRAINT "TelecomOperation_telecomCallId_fkey"
    FOREIGN KEY ("telecomCallId") REFERENCES "TelecomCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TelecomOperation" ADD CONSTRAINT "TelecomOperation_telecomMessageId_fkey"
    FOREIGN KEY ("telecomMessageId") REFERENCES "TelecomMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
