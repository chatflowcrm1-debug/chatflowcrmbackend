import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const prisma = new PrismaClient();

async function main() {
  const organization = await prisma.organization.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!organization) throw new Error('No organization');
  const customer = await prisma.customer.create({ data: { organizationId: organization.id, name: 'Deals E2E Customer', email: 'deals-e2e-customer@example.test', phone: '+15550008888', company: 'Deals E2E Company', source: 'E2E' } });
  const lead = await prisma.lead.create({ data: { organizationId: organization.id, customerId: customer.id, name: 'Deals E2E Lead', email: 'deals-e2e-lead@example.test', company: 'Deals E2E Company', source: 'E2E', status: 'QUALIFIED', value: 5000, probability: 50 } });
  console.log(`E2E_FIXTURE_READY=${organization.id}:${customer.id}:${lead.id}`);
}

main().catch(() => process.exitCode = 1).finally(() => prisma.$disconnect());
