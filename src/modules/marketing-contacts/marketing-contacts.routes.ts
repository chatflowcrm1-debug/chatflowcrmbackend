import { Router } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';
import {
  isValidMarketingPhone,
  normalizeMarketingDisplayValue,
  normalizeMarketingEmail,
  normalizeMarketingPhone,
} from './marketing-contact-normalization';
import { importMarketingContactsFromCsv, MARKETING_CONTACT_IMPORT_MAX_BYTES } from './marketing-contact-import';

const router = Router();
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MARKETING_CONTACT_IMPORT_MAX_BYTES },
  fileFilter: (_req, file, callback) => callback(null, file.originalname.toLowerCase().endsWith('.csv')),
});

const contactSchema = z.object({
  email: z.string().trim().max(255).optional().nullable().or(z.literal('')),
  phone: z.string().trim().max(50).optional().nullable().or(z.literal('')),
  firstName: z.string().trim().max(80).optional().nullable().or(z.literal('')),
  lastName: z.string().trim().max(80).optional().nullable().or(z.literal('')),
  company: z.string().trim().max(120).optional().nullable().or(z.literal('')),
  customerId: z.string().optional().nullable(),
  customFields: z.record(z.any()).optional().nullable(),
  status: z.string().trim().min(1).max(40).optional(),
});
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional().default(''),
  status: z.string().trim().optional().default(''),
  hasEmail: z.enum(['true', 'false']).optional(),
  hasPhone: z.enum(['true', 'false']).optional(),
});

function isValidEmail(value?: string | null) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function hasContactIdentityOrName(input: Partial<z.infer<typeof contactSchema>>) {
  return [input.email, input.phone, input.firstName, input.lastName, input.company, input.customerId]
    .some((value) => typeof value === 'string' && value.trim().length > 0);
}

function validateContactInput(input: Partial<z.infer<typeof contactSchema>>) {
  if (input.email && !isValidEmail(input.email)) return 'Invalid email address';
  if (input.phone && !isValidMarketingPhone(input.phone)) return 'Invalid phone number';
  return null;
}

async function ensureCustomerInOrganization(organizationId: string, customerId?: string | null) {
  if (!customerId) return null;
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
    select: { id: true },
  });
  return customer?.id || false;
}

async function findDuplicateWarning(organizationId: string, email?: string | null, phone?: string | null, excludeId?: string) {
  const normalizedEmail = normalizeMarketingEmail(email);
  const normalizedPhone = normalizeMarketingPhone(phone);
  const OR = [
    ...(normalizedEmail ? [{ normalizedEmail }] : []),
    ...(normalizedPhone ? [{ normalizedPhone }] : []),
  ];
  if (!OR.length) return false;

  return Boolean(await prisma.marketingContact.findFirst({
    where: {
      organizationId,
      OR,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  }));
}

router.get('/contacts', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid contact list query', issues: parsed.error.issues });
  const { page, pageSize, search, status } = parsed.data;
  const hasEmail = parsed.data.hasEmail === undefined ? undefined : parsed.data.hasEmail === 'true';
  const hasPhone = parsed.data.hasPhone === undefined ? undefined : parsed.data.hasPhone === 'true';
  const where = {
    organizationId: req.user!.organizationId,
    ...(status ? { status } : {}),
    ...(hasEmail === true ? { normalizedEmail: { not: null } } : hasEmail === false ? { normalizedEmail: null } : {}),
    ...(hasPhone === true ? { normalizedPhone: { not: null } } : hasPhone === false ? { normalizedPhone: null } : {}),
    ...(search ? {
      OR: [
        { email: { contains: search, mode: 'insensitive' as const } },
        { phone: { contains: search, mode: 'insensitive' as const } },
        { firstName: { contains: search, mode: 'insensitive' as const } },
        { lastName: { contains: search, mode: 'insensitive' as const } },
        { company: { contains: search, mode: 'insensitive' as const } },
      ],
    } : {}),
  };
  const [data, total] = await Promise.all([
    prisma.marketingContact.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
    prisma.marketingContact.count({ where }),
  ]);
  return res.json({ data, total, page, pageSize });
});

router.get('/contacts/:id', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => {
  const contact = await prisma.marketingContact.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
  if (!contact) return res.status(404).json({ message: 'Marketing contact not found' });
  return res.json({ data: contact });
});

router.post('/contacts', requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  const input = parsed.data;
  if (!hasContactIdentityOrName(input)) {
    return res.status(400).json({ message: 'At least one contact identity or name field is required' });
  }
  const validationError = await validateContactInput(input);
  if (validationError) return res.status(400).json({ message: validationError });

  const customerId = await ensureCustomerInOrganization(req.user!.organizationId, input.customerId);
  if (customerId === false) return res.status(400).json({ message: 'Customer not found in this organization' });
  const duplicateWarning = await findDuplicateWarning(req.user!.organizationId, input.email, input.phone);
  const contact = await prisma.marketingContact.create({
    data: {
      organizationId: req.user!.organizationId,
      customerId,
      email: normalizeMarketingDisplayValue(input.email),
      normalizedEmail: normalizeMarketingEmail(input.email),
      phone: normalizeMarketingDisplayValue(input.phone),
      normalizedPhone: normalizeMarketingPhone(input.phone),
      firstName: normalizeMarketingDisplayValue(input.firstName),
      lastName: normalizeMarketingDisplayValue(input.lastName),
      company: normalizeMarketingDisplayValue(input.company),
      status: input.status || 'ACTIVE',
      ...(input.customFields !== undefined ? { customFields: input.customFields === null ? Prisma.DbNull : input.customFields } : {}),
    },
  });
  return res.status(201).json({ message: 'Marketing contact created', duplicateWarning, data: contact });
});

router.patch('/contacts/:id', requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
  const parsed = contactSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  const input = parsed.data;
  if (!Object.keys(input).length) return res.status(400).json({ message: 'At least one contact field is required' });
  const organizationId = req.user!.organizationId;
  const existing = await prisma.marketingContact.findFirst({ where: { id: req.params.id, organizationId } });
  if (!existing) return res.status(404).json({ message: 'Marketing contact not found' });

  const validationError = await validateContactInput(input);
  if (validationError) return res.status(400).json({ message: validationError });
  let customerId = existing.customerId;
  if (input.customerId !== undefined) {
    const ownedCustomerId = await ensureCustomerInOrganization(organizationId, input.customerId);
    if (ownedCustomerId === false) return res.status(400).json({ message: 'Customer not found in this organization' });
    customerId = ownedCustomerId;
  }

  const email = input.email !== undefined ? normalizeMarketingDisplayValue(input.email) : existing.email;
  const phone = input.phone !== undefined ? normalizeMarketingDisplayValue(input.phone) : existing.phone;
  const duplicateWarning = await findDuplicateWarning(organizationId, email, phone, existing.id);
  const data = await prisma.marketingContact.update({
    where: { id: existing.id },
    data: {
      ...(input.customerId !== undefined ? { customerId } : {}),
      ...(input.email !== undefined ? { email, normalizedEmail: normalizeMarketingEmail(email) } : {}),
      ...(input.phone !== undefined ? { phone, normalizedPhone: normalizeMarketingPhone(phone) } : {}),
      ...(input.firstName !== undefined ? { firstName: normalizeMarketingDisplayValue(input.firstName) } : {}),
      ...(input.lastName !== undefined ? { lastName: normalizeMarketingDisplayValue(input.lastName) } : {}),
      ...(input.company !== undefined ? { company: normalizeMarketingDisplayValue(input.company) } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields === null ? Prisma.DbNull : input.customFields } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
  return res.json({ message: 'Marketing contact updated', duplicateWarning, data });
});

router.delete('/contacts/:id', requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
  const archived = await prisma.marketingContact.updateMany({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    data: { status: 'ARCHIVED' },
  });
  if (!archived.count) return res.status(404).json({ message: 'Marketing contact not found' });
  return res.json({ message: 'Marketing contact archived' });
});

router.post('/contacts/import', requireAuth, requirePermission('customers.write'), (req: AuthRequest, res, next) => {
  uploadCsv.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'CSV file exceeds the 2 MB limit' });
    if (error) return res.status(400).json({ message: 'A CSV file is required' });
    return next();
  });
}, async (req: AuthRequest, res) => {
  if (!req.file) return res.status(400).json({ message: 'A CSV file is required' });
  const preview = String(req.query.preview || req.body.preview || '').toLowerCase() === 'true';
  try {
    const summary = await importMarketingContactsFromCsv(req.user!.organizationId, req.file.buffer, preview);
    return res.json({ data: summary });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to import marketing contacts' });
  }
});

export default router;