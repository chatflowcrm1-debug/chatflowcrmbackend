import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';

const router = Router();

const followUpSchema = z.object({
  customerId: z.string().optional().or(z.literal('')),
  leadId: z.string().optional().or(z.literal('')),
  assignedUserId: z.string().optional().or(z.literal('')),
  type: z.string().default('CALL'),
  dueAt: z.string().min(1),
  priority: z.string().default('MEDIUM'),
  status: z.string().default('UPCOMING'),
  notes: z.string().optional().or(z.literal('')),
});

router.get('/', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => {
  const items = await prisma.followUp.findMany({
    where: { organizationId: req.user!.organizationId },
    include: { customer: true, lead: true, assignedUser: true },
    orderBy: { dueAt: 'asc' },
  });

  return res.json({ data: items, total: items.length });
});

router.post('/', requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
  const parsed = followUpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const item = await prisma.followUp.create({
    data: {
      organizationId: req.user!.organizationId,
      customerId: parsed.data.customerId || null,
      leadId: parsed.data.leadId || null,
      assignedUserId: parsed.data.assignedUserId || null,
      type: parsed.data.type,
      dueAt: new Date(parsed.data.dueAt),
      priority: parsed.data.priority,
      status: parsed.data.status,
      notes: parsed.data.notes || null,
    },
  });

  return res.status(201).json({ message: 'Follow-up created', data: item });
});

export default router;
