CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "monthlyPrice" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "contactLimit" INTEGER,
    "emailLimit" INTEGER,
    "smsLimit" INTEGER,
    "voiceMinuteLimit" INTEGER,
    "phoneNumberLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRIALING',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canceledAt" TIMESTAMP(3),
    "providerName" TEXT,
    "externalCustomerId" TEXT,
    "externalSubscriptionId" TEXT,
    "externalPriceId" TEXT,
    "paymentStatus" TEXT,
    "lastWebhookEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UsageRecord"
    ADD COLUMN "subscriptionId" TEXT,
    ADD COLUMN "planId" TEXT,
    ADD COLUMN "sourceType" TEXT,
    ADD COLUMN "sourceId" TEXT,
    ADD COLUMN "campaignId" TEXT,
    ADD COLUMN "campaignRecipientId" TEXT,
    ADD COLUMN "messageId" TEXT,
    ADD COLUMN "telecomCallId" TEXT,
    ADD COLUMN "telecomMessageId" TEXT,
    ADD COLUMN "providerId" TEXT,
    ADD COLUMN "unitPrice" DECIMAL(18,6),
    ADD COLUMN "currency" TEXT,
    ADD COLUMN "amount" DECIMAL(18,6),
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'RECORDED',
    ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");
CREATE UNIQUE INDEX "UsageRecord_idempotencyKey_key" ON "UsageRecord"("idempotencyKey");
CREATE INDEX "Subscription_planId_status_idx" ON "Subscription"("planId", "status");
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");
CREATE INDEX "UsageRecord_organizationId_category_periodStart_periodEnd_idx" ON "UsageRecord"("organizationId", "category", "periodStart", "periodEnd");
CREATE INDEX "UsageRecord_organizationId_sourceType_sourceId_idx" ON "UsageRecord"("organizationId", "sourceType", "sourceId");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
