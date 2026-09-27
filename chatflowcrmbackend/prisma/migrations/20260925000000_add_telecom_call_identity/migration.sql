-- CreateIndex
CREATE UNIQUE INDEX "TelecomCall_provider_providerCallId_key" ON "TelecomCall"("provider", "providerCallId");
