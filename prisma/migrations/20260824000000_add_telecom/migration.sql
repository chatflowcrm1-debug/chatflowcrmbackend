CREATE TABLE "TelecomAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelecomAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "telecomAccountId" TEXT,
    "assignedUserId" TEXT,
    "provider" TEXT NOT NULL,
    "providerNumberId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "numberType" TEXT NOT NULL,
    "areaCode" TEXT,
    "capabilities" TEXT[] NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelecomCall" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "customerId" TEXT,
    "phoneNumberId" TEXT,
    "provider" TEXT NOT NULL,
    "providerCallId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "recordingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelecomCall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallEvent" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "providerEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "providerRecordingId" TEXT,
    "storageUrl" TEXT,
    "durationSeconds" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelecomMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "customerId" TEXT,
    "phoneNumberId" TEXT,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelecomMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelecomMessageEvent" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "providerEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelecomMessageEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhoneNumber_organizationId_phoneNumber_key" ON "PhoneNumber"("organizationId", "phoneNumber");
CREATE UNIQUE INDEX "Recording_callId_key" ON "Recording"("callId");
CREATE INDEX "TelecomAccount_organizationId_status_idx" ON "TelecomAccount"("organizationId", "status");
CREATE INDEX "PhoneNumber_organizationId_country_numberType_idx" ON "PhoneNumber"("organizationId", "country", "numberType");
CREATE INDEX "TelecomCall_organizationId_createdAt_idx" ON "TelecomCall"("organizationId", "createdAt");
CREATE INDEX "TelecomCall_organizationId_customerId_idx" ON "TelecomCall"("organizationId", "customerId");
CREATE INDEX "CallEvent_callId_createdAt_idx" ON "CallEvent"("callId", "createdAt");
CREATE INDEX "Recording_organizationId_createdAt_idx" ON "Recording"("organizationId", "createdAt");
CREATE INDEX "TelecomMessage_organizationId_createdAt_idx" ON "TelecomMessage"("organizationId", "createdAt");
CREATE INDEX "TelecomMessage_organizationId_customerId_idx" ON "TelecomMessage"("organizationId", "customerId");
CREATE INDEX "TelecomMessageEvent_messageId_createdAt_idx" ON "TelecomMessageEvent"("messageId", "createdAt");
CREATE INDEX "UsageRecord_organizationId_periodStart_periodEnd_idx" ON "UsageRecord"("organizationId", "periodStart", "periodEnd");

ALTER TABLE "TelecomAccount" ADD CONSTRAINT "TelecomAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_telecomAccountId_fkey" FOREIGN KEY ("telecomAccountId") REFERENCES "TelecomAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TelecomCall" ADD CONSTRAINT "TelecomCall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TelecomCall" ADD CONSTRAINT "TelecomCall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TelecomCall" ADD CONSTRAINT "TelecomCall_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TelecomCall" ADD CONSTRAINT "TelecomCall_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "TelecomCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_callId_fkey" FOREIGN KEY ("callId") REFERENCES "TelecomCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TelecomMessage" ADD CONSTRAINT "TelecomMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TelecomMessage" ADD CONSTRAINT "TelecomMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TelecomMessage" ADD CONSTRAINT "TelecomMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TelecomMessage" ADD CONSTRAINT "TelecomMessage_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TelecomMessageEvent" ADD CONSTRAINT "TelecomMessageEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TelecomMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
