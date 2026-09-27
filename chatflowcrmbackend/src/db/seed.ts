import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('DemoPass123!', 12);

  const organization = await prisma.organization.upsert({
    where: { slug: 'demo-chatflow' },
    update: {},
    create: {
      name: 'Demo ChatFlow',
      slug: 'demo-chatflow',
      status: 'ACTIVE',
      currency: 'USD',
      timezone: 'UTC',
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: 'owner@demo.chatflow' },
    update: {},
    create: {
      email: 'owner@demo.chatflow',
      passwordHash,
      firstName: 'Demo',
      lastName: 'Owner',
      organizationId: organization.id,
    },
  });

  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: owner.id } },
    update: {},
    create: {
      organizationId: organization.id,
      userId: owner.id,
      role: 'OWNER',
      title: 'Owner',
      isActive: true,
    },
  });

  const teamUsers = [
    { email: 'manager@demo.chatflow', firstName: 'Demo', lastName: 'Manager', role: 'MANAGER' },
    { email: 'sales@demo.chatflow', firstName: 'Demo', lastName: 'Sales', role: 'SALES' },
    { email: 'agent@demo.chatflow', firstName: 'Demo', lastName: 'Agent', role: 'AGENT' },
  ];

  for (const user of teamUsers) {
    const createdUser = await prisma.user.upsert({
      where: { email: user.email },
      update: {},
      create: {
        email: user.email,
        passwordHash,
        firstName: user.firstName,
        lastName: user.lastName,
        organizationId: organization.id,
      },
    });

    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: createdUser.id } },
      update: {},
      create: {
        organizationId: organization.id,
        userId: createdUser.id,
        role: user.role,
        title: user.role,
        isActive: true,
      },
    });
  }

  const stageNames = ['New', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
  for (const [index, name] of stageNames.entries()) {
    await prisma.pipelineStage.upsert({
      where: { organizationId_name: { organizationId: organization.id, name } },
      update: {},
      create: { organizationId: organization.id, name, order: index },
    });
  }

  const tag1 = await prisma.tag.upsert({
    where: { organizationId_name: { organizationId: organization.id, name: 'Hot lead' } },
    update: {},
    create: { organizationId: organization.id, name: 'Hot lead', color: '#F59E0B' },
  });

  const customer1 = await prisma.customer.create({
    data: {
      organizationId: organization.id,
      name: 'Ava Johnson',
      phone: '+1 415 555 0101',
      email: 'ava@example.com',
      company: 'NorthStar Labs',
      country: 'United States',
      city: 'San Francisco',
      status: 'ACTIVE',
      source: 'Website',
      notes: 'Development demo customer',
    },
  });

  await prisma.customerTag.createMany({
    data: [{ organizationId: organization.id, customerId: customer1.id, tagId: tag1.id }],
    skipDuplicates: true,
  });

  const lead1 = await prisma.lead.create({
    data: {
      organizationId: organization.id,
      customerId: customer1.id,
      name: 'Ava Johnson',
      email: 'ava@example.com',
      phone: '+1 415 555 0101',
      company: 'NorthStar Labs',
      source: 'Website',
      status: 'QUALIFIED',
      value: 12500,
      probability: 82,
    },
  });

  await prisma.deal.create({
    data: {
      organizationId: organization.id,
      customerId: customer1.id,
      leadId: lead1.id,
      name: 'NorthStar Labs Expansion',
      value: 12500,
      currency: 'USD',
      stage: 'PROPOSAL',
      status: 'OPEN',
    },
  });

  await prisma.followUp.create({
    data: {
      organizationId: organization.id,
      customerId: customer1.id,
      leadId: lead1.id,
      type: 'WHATSAPP',
      dueAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      priority: 'HIGH',
      status: 'UPCOMING',
      notes: 'Follow up on proposal review',
    },
  });

  console.log('Development seed complete for demo organization.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
