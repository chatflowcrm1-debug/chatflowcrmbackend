import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';
import { env } from '../../config/env';
import { webhookRateLimit } from '../../middleware/rate-limit';

const router = Router();

router.get('/accounts', requireAuth, requirePermission('conversations.read'), async (req: AuthRequest, res) => {
  const accounts = await prisma.whatsAppAccount.findMany({ where: { organizationId: req.user!.organizationId }, orderBy: { createdAt: 'desc' } });
  return res.json({ data: accounts });
});

const connectSchema = z.object({
  phoneNumberId: z.string().min(1),
  displayName: z.string().min(1),
  phoneNumber: z.string().optional(),
});

router.post('/connect', requireAuth, requirePermission('settings.manage'), async (req: AuthRequest, res) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const account = await prisma.whatsAppAccount.upsert({
    where: { organizationId_phoneNumberId: { organizationId: req.user!.organizationId, phoneNumberId: parsed.data.phoneNumberId } },
    update: { displayName: parsed.data.displayName, phoneNumber: parsed.data.phoneNumber, status: 'CONNECTED', provider: 'MOCK' },
    create: { id: crypto.randomUUID(), organizationId: req.user!.organizationId, provider: 'MOCK', phoneNumberId: parsed.data.phoneNumberId, displayName: parsed.data.displayName, phoneNumber: parsed.data.phoneNumber, status: 'CONNECTED' },
  });
  return res.status(201).json({ message: 'Mock WhatsApp account registered for development', data: account });
});

const inboundSchema = z.object({
  eventId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  contactId: z.string().min(1),
  contactName: z.string().optional(),
  customerId: z.string().optional(),
  messageId: z.string().min(1),
  text: z.string().min(1).max(10000),
  from: z.string().optional(),
  to: z.string().optional(),
});

export function verifyWebhookSignature(payload: string, signature: string | undefined, secret = env.metaAppSecret || env.whatsappVerifyToken) {
  if (!secret || !signature) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  const provided = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return provided.length === calculated.length && crypto.timingSafeEqual(provided, calculated);
}

router.post('/webhook', webhookRateLimit, async (req, res) => {
  const rawPayload = JSON.stringify(req.body);
  if (!verifyWebhookSignature(rawPayload, req.header('x-chatflow-signature'))) return res.status(401).json({ message: 'Invalid webhook signature' });
  const parsed = inboundSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Unsupported webhook payload', issues: parsed.error.issues });

  const account = await prisma.whatsAppAccount.findFirst({ where: { phoneNumberId: parsed.data.phoneNumberId, provider: 'MOCK' } });
  if (!account) return res.status(404).json({ message: 'WhatsApp account not found' });
  if (parsed.data.customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: parsed.data.customerId, organizationId: account.organizationId }, select: { id: true } });
    if (!customer) return res.status(400).json({ message: 'Customer does not belong to the WhatsApp account organization' });
  }
  const payloadHash = crypto.createHash('sha256').update(rawPayload).digest('hex');

  try {
    await prisma.$transaction(async (tx) => {
      await tx.webhookEvent.create({ data: { id: crypto.randomUUID(), organizationId: account.organizationId, provider: 'MOCK', externalEventId: parsed.data.eventId, payloadHash } });
      const conversation = await tx.conversation.upsert({
        where: { organizationId_channel_externalContactId: { organizationId: account.organizationId, channel: 'WHATSAPP', externalContactId: parsed.data.contactId } },
        update: { whatsappAccountId: account.id, title: parsed.data.contactName, lastMessageAt: new Date(), unreadCount: { increment: 1 }, ...(parsed.data.customerId ? { customerId: parsed.data.customerId } : {}) },
        create: { organizationId: account.organizationId, whatsappAccountId: account.id, channel: 'WHATSAPP', externalContactId: parsed.data.contactId, title: parsed.data.contactName, customerId: parsed.data.customerId, unreadCount: 1, lastMessageAt: new Date() },
      });
      await tx.message.create({ data: { organizationId: account.organizationId, conversationId: conversation.id, provider: 'MOCK', direction: 'INBOUND', body: parsed.data.text, providerMessageId: parsed.data.messageId, status: 'RECEIVED', senderId: parsed.data.from || parsed.data.contactId, recipientId: parsed.data.to || account.phoneNumberId } });
      await tx.webhookEvent.update({ where: { provider_externalEventId: { provider: 'MOCK', externalEventId: parsed.data.eventId } }, data: { processedAt: new Date() } });
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return res.status(200).json({ ok: true, duplicate: true });
    throw error;
  }

  return res.status(200).json({ ok: true, processed: true });
});

export default router;
