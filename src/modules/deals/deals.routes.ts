import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';

const router = Router();

const dealSchema = z.object({
  name: z.string().min(1),
  customerId: z.string().optional().or(z.literal('')),
  leadId: z.string().optional().or(z.literal('')),
  stage: z.string().default('NEW'),
  value: z.coerce.number().min(0),
  currency: z.string().default('USD'),
  assignedUserId: z.string().optional().or(z.literal('')),
  expectedCloseAt: z.string().optional().or(z.literal('')),
  notes: z.string().optional().or(z.literal('')),
  status: z.string().optional(),
});

router.get('/', requireAuth, requirePermission('leads.read'), async (req: AuthRequest, res) => {
  const deals = await prisma.deal.findMany({
    where: { organizationId: req.user!.organizationId },
    include: {
      customer: true,
      lead: true,
      assignedUser: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({ data: deals, total: deals.length });
});

router.post('/', requireAuth, requirePermission('leads.write'), async (req: AuthRequest, res) => {
  const parsed = dealSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const payload = parsed.data;
  const deal = await prisma.deal.create({
    data: {
      organizationId: req.user!.organizationId,
      name: payload.name,
      customerId: payload.customerId || null,
      leadId: payload.leadId || null,
      stage: payload.stage,
      value: payload.value,
      currency: payload.currency,
      assignedUserId: payload.assignedUserId || null,
      expectedCloseAt: payload.expectedCloseAt ? new Date(payload.expectedCloseAt) : null,
      notes: payload.notes || null,
      status: payload.status || 'OPEN',
    },
  });

  return res.status(201).json({ message: 'Deal created', data: deal });
});

router.patch('/:id', requireAuth, requirePermission('leads.write'), async (req: AuthRequest, res) => {
  const parsed = dealSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const result = await prisma.deal.updateMany({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    data: {
      ...parsed.data,
      customerId: parsed.data.customerId === '' ? null : parsed.data.customerId,
      leadId: parsed.data.leadId === '' ? null : parsed.data.leadId,
      assignedUserId: parsed.data.assignedUserId === '' ? null : parsed.data.assignedUserId,
      expectedCloseAt: parsed.data.expectedCloseAt ? new Date(parsed.data.expectedCloseAt) : undefined,
      notes: parsed.data.notes === '' ? null : parsed.data.notes,
      value: parsed.data.value !== undefined ? parsed.data.value : undefined,
    },
  });

  if (result.count === 0) return res.status(404).json({ message: 'Deal not found' });

  const updated = await prisma.deal.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
  return res.json({ message: 'Deal updated', data: updated });
});

export default router;
