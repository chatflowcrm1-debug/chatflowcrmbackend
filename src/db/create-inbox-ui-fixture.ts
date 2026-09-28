import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const prisma = new PrismaClient();
prisma.organization.findFirst({ where: { name: { startsWith: 'Inbox UI ' } }, orderBy: { createdAt: 'desc' } }).then((organization) => {
  if (!organization) throw new Error('Test organization not found');
  const organizationId = organization.id;
  const suffix = Date.now().toString();
  return prisma.whatsAppAccount.upsert({
    where: { organizationId_phoneNumberId: { organizationId, phoneNumberId: `inbox-ui-phone-${suffix}` } },
  update: {},
  create: { id: crypto.randomUUID(), organizationId, provider: 'MOCK', phoneNumberId: `inbox-ui-phone-${suffix}`, displayName: 'Inbox UI Test', phoneNumber: `+1555${suffix.slice(-8)}`, status: 'CONNECTED' },
  }).then((account) => prisma.conversation.create({
  data: {
    organizationId,
    whatsappAccountId: account.id,
    channel: 'WHATSAPP',
    externalContactId: `+1555${suffix.slice(-7)}`,
    title: `Inbox UI Contact ${suffix}`,
    status: 'OPEN',
    unreadCount: 1,
    lastMessageAt: new Date(),
    messages: { create: { organizationId, provider: 'MOCK', direction: 'INBOUND', body: 'Initial inbound message', providerMessageId: `inbox-ui-initial-${suffix}`, status: 'RECEIVED', senderId: `+1555${suffix.slice(-7)}`, recipientId: `+1555${suffix.slice(-8)}` } },
  },
  }));
}).then(() => console.log('INBOX_UI_FIXTURE_CREATED')).catch((error) => { console.log(`INBOX_UI_FIXTURE_ERROR=${error.code || 'UNKNOWN'}`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
