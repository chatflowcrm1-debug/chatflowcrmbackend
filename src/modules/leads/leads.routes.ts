import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';

const router = Router();

const leadSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional().or(z.literal('')),
  company: z.string().optional().or(z.literal('')),
  source: z.string().optional().or(z.literal('')),
  status: z.string().optional(),
  value: z.coerce.number().optional(),
  probability: z.coerce.number().optional(),
  assignedUserId: z.string().optional().or(z.literal('')),
  notes: z.string().optional().or(z.literal('')),
  customerId: z.string().optional().or(z.literal('')),
});

router.get('/', requireAuth, requirePermission('leads.read'), async (req: AuthRequest, res) => {
  const leads = await prisma.lead.findMany({
    where: { organizationId: req.user!.organizationId },
    include: {
      assignedUser: { select: { id: true, firstName: true, lastName: true } },
      customer: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ data: leads, total: leads.length });
});

router.post('/', requireAuth, requirePermission('leads.write'), async (req: AuthRequest, res) => {
  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const payload = parsed.data;
  const lead = await prisma.lead.create({
    data: {
      organizationId: req.user!.organizationId,
      name: payload.name,
      email: payload.email || null,
      phone: payload.phone || null,
      company: payload.company || null,
      source: payload.source || 'MANUAL',
      status: payload.status || 'NEW',
      value: payload.value ? payload.value : null,
      probability: payload.probability || 0,
      assignedUserId: payload.assignedUserId || null,
      notes: payload.notes || null,
      customerId: payload.customerId || null,
    },
  });

  return res.status(201).json({ message: 'Lead created', data: lead });
});

router.patch('/:id', requireAuth, requirePermission('leads.write'), async (req: AuthRequest, res) => {
  const parsed = leadSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const lead = await prisma.lead.updateMany({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    data: {
      ...parsed.data,
      value: parsed.data.value !== undefined ? parsed.data.value : undefined,
      assignedUserId: parsed.data.assignedUserId === '' ? null : parsed.data.assignedUserId,
      customerId: parsed.data.customerId === '' ? null : parsed.data.customerId,
      notes: parsed.data.notes === '' ? null : parsed.data.notes,
      email: parsed.data.email === '' ? null : parsed.data.email,
      phone: parsed.data.phone === '' ? null : parsed.data.phone,
      company: parsed.data.company === '' ? null : parsed.data.company,
      source: parsed.data.source === '' ? null : parsed.data.source,
    },
  });

  if (lead.count === 0) return res.status(404).json({ message: 'Lead not found' });
  const updated = await prisma.lead.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
  return res.json({ message: 'Lead updated', data: updated });
});

router.delete('/:id', requireAuth, requirePermission('leads.write'), async (req: AuthRequest, res) => {
  const deleted = await prisma.lead.deleteMany({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });

  if (deleted.count === 0) return res.status(404).json({ message: 'Lead not found' });
  return res.json({ message: 'Lead deleted' });
});

export default router;
