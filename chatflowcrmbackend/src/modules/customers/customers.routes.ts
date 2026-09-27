import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';

const router = Router();

const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  company: z.string().optional().or(z.literal('')),
  address: z.string().optional().or(z.literal('')),
  city: z.string().optional().or(z.literal('')),
  country: z.string().optional().or(z.literal('')),
  status: z.string().optional(),
  source: z.string().optional().or(z.literal('')),
  assignedUserId: z.string().optional().or(z.literal('')),
  notes: z.string().optional().or(z.literal('')),
});

router.get('/', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => {
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '');

  const customers = await prisma.customer.findMany({
    where: {
      organizationId: req.user!.organizationId,
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { company: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    },
    include: {
      assignedUser: { select: { id: true, firstName: true, lastName: true, email: true } },
      customerTags: { include: { tag: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ data: customers, total: customers.length });
});

router.get('/:id', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => {
  const customer = await prisma.customer.findFirst({
    where: {
      id: req.params.id,
      organizationId: req.user!.organizationId,
    },
    include: {
      assignedUser: { select: { id: true, firstName: true, lastName: true, email: true } },
      customerTags: { include: { tag: true } },
      customerNotes: { include: { user: { select: { firstName: true, lastName: true } } } },
      leads: true,
      deals: true,
      followUps: true,
    },
  });

  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const customerWithNotesShape = {
    ...customer,
    notes: customer.customerNotes,
  };

  return res.json({ data: customerWithNotesShape });
});

router.post('/', requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const payload = parsed.data;

  const customer = await prisma.customer.create({
    data: {
      organizationId: req.user!.organizationId,
      name: payload.name,
      phone: payload.phone || null,
      email: payload.email || null,
      company: payload.company || null,
      address: payload.address || null,
      city: payload.city || null,
      country: payload.country || null,
      status: payload.status || 'ACTIVE',
      source: payload.source || 'MANUAL',
      assignedUserId: payload.assignedUserId || null,
      notes: payload.notes || null,
    },
    include: {
      assignedUser: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  return res.status(201).json({ message: 'Customer created', data: customer });
});

router.patch('/:id', requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
  const parsed = customerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const customer = await prisma.customer.updateMany({
    where: {
      id: req.params.id,
      organizationId: req.user!.organizationId,
    },
    data: {
      ...parsed.data,
      assignedUserId: parsed.data.assignedUserId === '' ? null : parsed.data.assignedUserId,
      phone: parsed.data.phone === '' ? null : parsed.data.phone,
      email: parsed.data.email === '' ? null : parsed.data.email,
      company: parsed.data.company === '' ? null : parsed.data.company,
      address: parsed.data.address === '' ? null : parsed.data.address,
      city: parsed.data.city === '' ? null : parsed.data.city,
      country: parsed.data.country === '' ? null : parsed.data.country,
      source: parsed.data.source === '' ? null : parsed.data.source,
      notes: parsed.data.notes === '' ? null : parsed.data.notes,
    },
  });

  if (customer.count === 0) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const updated = await prisma.customer.findFirst({
    where: {
      id: req.params.id,
      organizationId: req.user!.organizationId,
    },
  });

  return res.json({ message: 'Customer updated', data: updated });
});

router.delete('/:id', requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
  const deleted = await prisma.customer.deleteMany({
    where: {
      id: req.params.id,
      organizationId: req.user!.organizationId,
    },
  });

  if (deleted.count === 0) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  return res.json({ message: 'Customer deleted' });
});

export default router;
