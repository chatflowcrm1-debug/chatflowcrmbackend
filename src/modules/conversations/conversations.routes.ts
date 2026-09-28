import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';
import { sensitiveActionRateLimit } from '../../middleware/rate-limit';
import { MockWhatsAppProvider } from '../whatsapp/providers/MockWhatsAppProvider';

const router = Router();
const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
const updateSchema = z.object({ status: z.string().min(1).optional(), assignedUserId: z.string().nullable().optional(), read: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const messageSchema = z.object({ body: z.string().trim().min(1).max(10000), recipient: z.string().optional() });

router.get('/', requireAuth, requirePermission('conversations.read'), async (req: AuthRequest, res) => {
  const { page, pageSize } = pageSchema.parse(req.query);
  const organizationId = req.user!.organizationId;
  const where = { organizationId };
  const [items, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true, company: true } },
        assignedUser: { select: { id: true, firstName: true, lastName: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.conversation.count({ where }),
  ]);

  return res.json({ data: items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

router.get('/:id/messages', requireAuth, requirePermission('conversations.read'), async (req: AuthRequest, res) => {
  const { page, pageSize } = pageSchema.parse(req.query);
  const organizationId = req.user!.organizationId;
  const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, organizationId }, select: { id: true } });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

  const [items, total] = await Promise.all([
    prisma.message.findMany({ where: { conversationId: conversation.id, organizationId }, orderBy: { createdAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.message.count({ where: { conversationId: conversation.id, organizationId } }),
  ]);

  return res.json({ data: items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

router.patch('/:id', requireAuth, requirePermission('conversations.write'), async (req: AuthRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  const organizationId = req.user!.organizationId;
  const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, organizationId }, select: { id: true } });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

  if (parsed.data.assignedUserId) {
    const member = await prisma.organizationMember.findFirst({ where: { organizationId, userId: parsed.data.assignedUserId, isActive: true }, select: { id: true } });
    if (!member) return res.status(400).json({ message: 'Assigned user is not an active organization member' });
  }

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: parsed.data.status,
      assignedUserId: parsed.data.assignedUserId,
      ...(parsed.data.read ? { unreadCount: 0 } : {}),
    },
  });
  return res.json({ message: 'Conversation updated', data: updated });
});

router.post('/:id/messages', sensitiveActionRateLimit, requireAuth, requirePermission('conversations.write'), async (req: AuthRequest, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  const organizationId = req.user!.organizationId;
  const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, organizationId }, include: { whatsappAccount: true } });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
  if (!conversation.whatsappAccount) return res.status(409).json({ message: 'Conversation has no WhatsApp account' });
  if (conversation.whatsappAccount.provider !== 'MOCK') return res.status(503).json({ message: 'Configured WhatsApp provider is not available for outbound messages' });

  const providerResult: { success: boolean; providerMessageId?: string; error?: string } = await new MockWhatsAppProvider().sendMessage({ to: parsed.data.recipient || conversation.externalContactId, content: parsed.data.body });
  if (!providerResult.success || !providerResult.providerMessageId) return res.status(502).json({ message: providerResult.error || 'Message delivery failed' });

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({ data: { organizationId, conversationId: conversation.id, provider: 'MOCK', direction: 'OUTBOUND', body: parsed.data.body, providerMessageId: providerResult.providerMessageId, status: 'SENT', senderId: conversation.whatsappAccount!.phoneNumber || conversation.whatsappAccount!.displayName, recipientId: parsed.data.recipient || conversation.externalContactId } });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: created.createdAt } });
    return created;
  });

  return res.status(201).json({ message: 'Message sent through Mock WhatsApp provider', data: message });
});

export default router;
