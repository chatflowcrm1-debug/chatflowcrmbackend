import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';
import { sensitiveActionRateLimit } from '../../middleware/rate-limit';

const router = Router();
const campaignTypes = ['EMAIL', 'SMS'] as const;
const campaignStatuses = ['DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'PAUSED', 'CANCELLED', 'FAILED'] as const;
const recipientModes = ['ALL', 'SELECTED'] as const;

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(campaignTypes),
  audience: z.enum(recipientModes).default('ALL'),
  customerIds: z.array(z.string().min(1)).default([]),
  subject: z.string().trim().max(200).optional(),
  content: z.string().trim().min(1).max(10000),
  scheduledAt: z.string().datetime().optional().nullable(),
});

const updateSchema = campaignSchema.partial();

function destinationFor(type: string, customer: { email: string | null; phone: string | null }) {
  return type === 'EMAIL' ? customer.email : customer.phone;
}

async function getOwnedCampaign(id: string, organizationId: string) {
  return prisma.campaign.findFirst({
    where: { id, organizationId },
    include: {
      recipients: { include: { customer: { select: { id: true, name: true, email: true, phone: true } }, events: true }, orderBy: { createdAt: 'asc' } },
      events: { orderBy: { createdAt: 'asc' } },
    },
  });
}

async function resolveRecipients(organizationId: string, type: string, audience: 'ALL' | 'SELECTED', customerIds: string[]) {
  if (audience === 'SELECTED') {
    const uniqueIds = [...new Set(customerIds)];
    const customers = await prisma.customer.findMany({ where: { organizationId, id: { in: uniqueIds } }, select: { id: true, email: true, phone: true } });
    if (customers.length !== uniqueIds.length) throw new Error('One or more selected customers are not in this organization');
    return customers.map((customer) => ({ customerId: customer.id, destination: destinationFor(type, customer) })).filter((recipient): recipient is { customerId: string; destination: string } => Boolean(recipient.destination));
  }

  const customers = await prisma.customer.findMany({ where: { organizationId }, select: { id: true, email: true, phone: true } });
  return customers.map((customer) => ({ customerId: customer.id, destination: destinationFor(type, customer) })).filter((recipient): recipient is { customerId: string; destination: string } => Boolean(recipient.destination));
}

router.get('/', requireAuth, requirePermission('campaigns.read'), async (req: AuthRequest, res) => {
  const campaigns = await prisma.campaign.findMany({ where: { organizationId: req.user!.organizationId }, include: { _count: { select: { recipients: true } } }, orderBy: { createdAt: 'desc' } });
  return res.json({ data: campaigns });
});

router.get('/:id', requireAuth, requirePermission('campaigns.read'), async (req: AuthRequest, res) => {
  const campaign = await getOwnedCampaign(req.params.id, req.user!.organizationId);
  if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
  return res.json({ data: campaign });
});

router.post('/', sensitiveActionRateLimit, requireAuth, requirePermission('campaigns.write'), async (req: AuthRequest, res) => {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  const input = parsed.data;
  if (input.type === 'EMAIL' && !input.subject) return res.status(400).json({ message: 'Email campaigns require a subject' });
  if (input.audience === 'SELECTED' && input.customerIds.length === 0) return res.status(400).json({ message: 'Select at least one customer' });
  if (input.scheduledAt && new Date(input.scheduledAt).getTime() <= Date.now()) return res.status(400).json({ message: 'Scheduled time must be in the future' });

  try {
    const recipients = await resolveRecipients(req.user!.organizationId, input.type, input.audience, input.customerIds);
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: req.user!.organizationId,
        name: input.name,
        type: input.type,
        status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT',
        subject: input.type === 'EMAIL' ? input.subject : null,
        content: input.content,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        recipients: { create: recipients },
      },
      include: { _count: { select: { recipients: true } } },
    });
    return res.status(201).json({ message: 'Campaign created in mock mode', data: campaign });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to create campaign' });
  }
});

router.patch('/:id', sensitiveActionRateLimit, requireAuth, requirePermission('campaigns.write'), async (req: AuthRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  const existing = await getOwnedCampaign(req.params.id, req.user!.organizationId);
  if (!existing) return res.status(404).json({ message: 'Campaign not found' });
  if (existing.status !== 'DRAFT') return res.status(400).json({ message: 'Only draft campaigns can be edited' });
  const input = parsed.data;
  const nextType = input.type || existing.type;
  const nextSubject = input.subject !== undefined ? input.subject : existing.subject;
  if (nextType === 'EMAIL' && !nextSubject) return res.status(400).json({ message: 'Email campaigns require a subject' });
  if (input.scheduledAt && new Date(input.scheduledAt).getTime() <= Date.now()) return res.status(400).json({ message: 'Scheduled time must be in the future' });

  try {
    const audience = input.audience || 'SELECTED';
    const customerIds = input.customerIds || existing.recipients.map((recipient) => recipient.customerId);
    const resolved = input.audience || input.customerIds ? await resolveRecipients(req.user!.organizationId, nextType, audience, customerIds) : null;
    const campaign = await prisma.$transaction(async (transaction) => {
      if (resolved) await transaction.campaignRecipient.deleteMany({ where: { campaignId: existing.id } });
      return transaction.campaign.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.subject !== undefined ? { subject: nextType === 'EMAIL' ? input.subject : null } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT' } : {}),
          ...(resolved ? { recipients: { create: resolved } } : {}),
        },
        include: { _count: { select: { recipients: true } } },
      });
    });
    return res.json({ message: 'Campaign updated', data: campaign });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to update campaign' });
  }
});

router.delete('/:id', sensitiveActionRateLimit, requireAuth, requirePermission('campaigns.write'), async (req: AuthRequest, res) => {
  const campaign = await getOwnedCampaign(req.params.id, req.user!.organizationId);
  if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
  if (!['DRAFT', 'CANCELLED'].includes(campaign.status)) return res.status(400).json({ message: 'Only draft or cancelled campaigns can be deleted' });
  await prisma.campaign.delete({ where: { id: campaign.id } });
  return res.json({ message: 'Campaign deleted' });
});

router.post('/:id/schedule', sensitiveActionRateLimit, requireAuth, requirePermission('campaigns.write'), async (req: AuthRequest, res) => {
  const parsed = z.object({ scheduledAt: z.string().datetime() }).safeParse(req.body);
  if (!parsed.success || new Date(parsed.data.scheduledAt).getTime() <= Date.now()) return res.status(400).json({ message: 'A future scheduled time is required' });
  const updated = await prisma.campaign.updateMany({ where: { id: req.params.id, organizationId: req.user!.organizationId, status: 'DRAFT' }, data: { scheduledAt: new Date(parsed.data.scheduledAt), status: 'SCHEDULED' } });
  if (!updated.count) return res.status(404).json({ message: 'Draft campaign not found' });
  return res.json({ message: 'Campaign scheduled in mock mode', data: await getOwnedCampaign(req.params.id, req.user!.organizationId) });
});

router.post('/:id/cancel', sensitiveActionRateLimit, requireAuth, requirePermission('campaigns.write'), async (req: AuthRequest, res) => {
  const updated = await prisma.campaign.updateMany({ where: { id: req.params.id, organizationId: req.user!.organizationId, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { status: 'CANCELLED' } });
  if (!updated.count) return res.status(404).json({ message: 'Campaign cannot be cancelled in its current state' });
  return res.json({ message: 'Campaign cancelled', data: await getOwnedCampaign(req.params.id, req.user!.organizationId) });
});

export default router;
