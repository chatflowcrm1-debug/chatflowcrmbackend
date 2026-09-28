import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const prisma = new PrismaClient();
async function main() {
  const organization = await prisma.organization.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!organization) throw new Error('No organization');
  const customer = await prisma.customer.create({ data: { organizationId: organization.id, name: 'DF Final Customer', email: 'df-final-customer@example.test', phone: '+15550007777', company: 'DF Final Company', source: 'E2E' } });
  const lead = await prisma.lead.create({ data: { organizationId: organization.id, customerId: customer.id, name: 'DF Final Lead', email: 'df-final-lead@example.test', company: 'DF Final Company', source: 'E2E', status: 'QUALIFIED', value: 6000, probability: 60 } });
  console.log('DF_FIXTURE_READY');
}
main().catch(()=>process.exitCode=1).finally(()=>prisma.$disconnect());
