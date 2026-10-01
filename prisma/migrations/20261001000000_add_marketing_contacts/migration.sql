BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "CampaignRecipient" cr
        JOIN "Campaign" c ON c."id" = cr."campaignId"
        JOIN "Customer" cu ON cu."id" = cr."customerId"
        WHERE c."organizationId" <> cu."organizationId"
    ) THEN
        RAISE EXCEPTION 'CampaignRecipient organization does not match its Campaign and Customer';
    END IF;
END;
$$;

CREATE TABLE "MarketingContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "email" TEXT,
    "normalizedEmail" TEXT,
    "phone" TEXT,
    "normalizedPhone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketingContact_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CampaignRecipient"
    ADD COLUMN "marketingContactId" TEXT,
    ALTER COLUMN "customerId" DROP NOT NULL;

INSERT INTO "MarketingContact" (
    "id",
    "organizationId",
    "customerId",
    "email",
    "normalizedEmail",
    "phone",
    "normalizedPhone",
    "firstName",
    "lastName",
    "company",
    "status",
    "customFields",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    c."organizationId",
    c."id",
    c."email",
    NULLIF(lower(btrim(COALESCE(c."email", ''))), ''),
    c."phone",
    NULLIF(regexp_replace(COALESCE(c."phone", ''), '[^0-9]', '', 'g'), ''),
    NULL,
    NULL,
    c."company",
    c."status",
    jsonb_build_object('legacyCustomerName', c."name"),
    c."createdAt",
    c."updatedAt"
FROM "Customer" c;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Customer" c
        LEFT JOIN "MarketingContact" mc
          ON mc."customerId" = c."id"
         AND mc."organizationId" = c."organizationId"
        GROUP BY c."id"
        HAVING COUNT(mc."id") <> 1
    ) THEN
        RAISE EXCEPTION 'Customer to MarketingContact backfill did not produce exactly one contact per Customer';
    END IF;
END;
$$;

UPDATE "CampaignRecipient" cr
SET "marketingContactId" = mc."id"
FROM "Campaign" c
JOIN "Customer" cu
  ON cu."organizationId" = c."organizationId"
JOIN "MarketingContact" mc
  ON mc."customerId" = cu."id"
 AND mc."organizationId" = cu."organizationId"
WHERE c."id" = cr."campaignId"
  AND cu."id" = cr."customerId"
  AND cr."marketingContactId" IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "CampaignRecipient" cr
        JOIN "Campaign" c ON c."id" = cr."campaignId"
        JOIN "Customer" cu ON cu."id" = cr."customerId"
        WHERE c."organizationId" <> cu."organizationId"
           OR cr."marketingContactId" IS NULL
    ) THEN
        RAISE EXCEPTION 'CampaignRecipient to MarketingContact backfill is incomplete or crosses organizations';
    END IF;
END;
$$;

ALTER TABLE "MarketingContact"
    ADD CONSTRAINT "MarketingContact_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "MarketingContact_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CampaignRecipient"
    ADD CONSTRAINT "CampaignRecipient_marketingContactId_fkey"
    FOREIGN KEY ("marketingContactId") REFERENCES "MarketingContact"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MarketingContact_organizationId_status_idx"
    ON "MarketingContact"("organizationId", "status");
CREATE INDEX "MarketingContact_organizationId_customerId_idx"
    ON "MarketingContact"("organizationId", "customerId");
CREATE INDEX "MarketingContact_organizationId_normalizedEmail_idx"
    ON "MarketingContact"("organizationId", "normalizedEmail");
CREATE INDEX "MarketingContact_organizationId_normalizedPhone_idx"
    ON "MarketingContact"("organizationId", "normalizedPhone");
CREATE INDEX "MarketingContact_organizationId_firstName_idx"
    ON "MarketingContact"("organizationId", "firstName");
CREATE INDEX "MarketingContact_organizationId_lastName_idx"
    ON "MarketingContact"("organizationId", "lastName");
CREATE INDEX "CampaignRecipient_marketingContactId_idx"
    ON "CampaignRecipient"("marketingContactId");
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_marketingContactId_key"
    ON "CampaignRecipient"("campaignId", "marketingContactId");

COMMIT;