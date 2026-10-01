import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { signJwt } from '../src/modules/auth/auth.service';
import { PermissionName } from '../src/types';

const mockCustomerFindFirst = jest.fn();
const mockMarketingContactFindMany = jest.fn();
const mockMarketingContactCount = jest.fn();
const mockMarketingContactFindFirst = jest.fn();
const mockMarketingContactCreate = jest.fn();
const mockMarketingContactUpdate = jest.fn();
const mockMarketingContactUpdateMany = jest.fn();
const mockMarketingContactCreateMany = jest.fn();

jest.mock('../src/db/prisma', () => ({
  prisma: {
    customer: { findFirst: mockCustomerFindFirst },
    marketingContact: {
      findMany: mockMarketingContactFindMany,
      count: mockMarketingContactCount,
      findFirst: mockMarketingContactFindFirst,
      create: mockMarketingContactCreate,
      update: mockMarketingContactUpdate,
      updateMany: mockMarketingContactUpdateMany,
      createMany: mockMarketingContactCreateMany,
    },
  },
}));

import marketingContactRoutes from '../src/modules/marketing-contacts/marketing-contacts.routes';

const app = express();
app.use(express.json());
app.use('/api/marketing', marketingContactRoutes);

async function request(path: string, options: RequestInit = {}, permissions: readonly PermissionName[] = ['customers.read', 'customers.write']) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fetch(`http://127.0.0.1:${port}/api/marketing${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${signJwt({ id: 'user-a', email: 'a@example.com', organizationId: 'org-a', role: 'AGENT', permissions })}`,
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomerFindFirst.mockResolvedValue({ id: 'customer-a' });
  mockMarketingContactFindMany.mockResolvedValue([]);
  mockMarketingContactCount.mockResolvedValue(0);
  mockMarketingContactFindFirst.mockResolvedValue(null);
  mockMarketingContactCreate.mockImplementation(async ({ data }) => ({ id: 'contact-a', ...data }));
  mockMarketingContactUpdate.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockMarketingContactUpdateMany.mockResolvedValue({ count: 1 });
});

describe('marketing contact API', () => {
  it('creates a marketing-only contact and normalizes email and phone', async () => {
    const response = await request('/contacts', {
      method: 'POST',
      body: JSON.stringify({ email: ' Person@Example.com ', phone: '+1 (212) 555-0100', firstName: ' Ada ' }),
    });
    const payload = await response.json() as { data: Record<string, unknown> };
    expect(response.status).toBe(201);
    expect(payload.data).toMatchObject({
      organizationId: 'org-a',
      customerId: null,
      email: 'Person@Example.com',
      normalizedEmail: 'person@example.com',
      phone: '+1 (212) 555-0100',
      normalizedPhone: '12125550100',
      firstName: 'Ada',
    });
    expect(mockCustomerFindFirst).not.toHaveBeenCalled();
  });

  it('creates a Customer-linked contact after checking organization ownership', async () => {
    const response = await request('/contacts', {
      method: 'POST',
      body: JSON.stringify({ customerId: 'customer-a', lastName: 'Lovelace' }),
    });
    expect(response.status).toBe(201);
    expect(mockCustomerFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'customer-a', organizationId: 'org-a' } }));
    expect(mockMarketingContactCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: 'customer-a' }) }));
  });

  it('rejects a Customer from another organization', async () => {
    mockCustomerFindFirst.mockResolvedValue(null);
    const response = await request('/contacts', { method: 'POST', body: JSON.stringify({ customerId: 'foreign', email: 'a@example.com' }) });
    expect(response.status).toBe(400);
    expect(mockMarketingContactCreate).not.toHaveBeenCalled();
  });

  it('rejects invalid email and phone input', async () => {
    const invalidEmail = await request('/contacts', { method: 'POST', body: JSON.stringify({ email: 'not-an-email' }) });
    const invalidPhone = await request('/contacts', { method: 'POST', body: JSON.stringify({ phone: '---' }) });
    expect(invalidEmail.status).toBe(400);
    expect(invalidPhone.status).toBe(400);
    expect(mockMarketingContactCreate).not.toHaveBeenCalled();
  });

  it('allows a duplicate identity while returning a warning', async () => {
    mockMarketingContactFindFirst.mockResolvedValue({ id: 'existing-contact' });
    const response = await request('/contacts', { method: 'POST', body: JSON.stringify({ email: 'same@example.com', phone: '+12125550100' }) });
    const payload = await response.json() as { duplicateWarning: boolean };
    expect(response.status).toBe(201);
    expect(payload.duplicateWarning).toBe(true);
    expect(mockMarketingContactCreate).toHaveBeenCalled();
  });

  it('lists contacts with tenant, search, filter, and pagination constraints', async () => {
    mockMarketingContactFindMany.mockResolvedValue([{ id: 'contact-a' }]);
    mockMarketingContactCount.mockResolvedValue(1);
    const response = await request('/contacts?page=2&pageSize=10&search=ada&status=ACTIVE&hasEmail=true&hasPhone=false');
    const payload = await response.json() as { data: unknown[]; total: number; page: number; pageSize: number };
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(mockMarketingContactFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: 'org-a', status: 'ACTIVE', normalizedEmail: { not: null }, normalizedPhone: null }),
      skip: 10,
      take: 10,
    }));
  });

  it('rejects invalid pagination and boolean filters', async () => {
    expect((await request('/contacts?page=0')).status).toBe(400);
    expect((await request('/contacts?hasEmail=yes')).status).toBe(400);
  });

  it('gets contacts only within the authenticated organization', async () => {
    mockMarketingContactFindFirst.mockResolvedValueOnce({ id: 'contact-a', organizationId: 'org-a' });
    expect((await request('/contacts/contact-a')).status).toBe(200);
    expect(mockMarketingContactFindFirst).toHaveBeenCalledWith({ where: { id: 'contact-a', organizationId: 'org-a' } });
    mockMarketingContactFindFirst.mockResolvedValueOnce(null);
    expect((await request('/contacts/foreign-contact')).status).toBe(404);
  });

  it('updates contact fields and permits clearing its Customer relation', async () => {
    mockMarketingContactFindFirst.mockResolvedValue({ id: 'contact-a', organizationId: 'org-a', customerId: 'customer-a', email: 'old@example.com', phone: null });
    const response = await request('/contacts/contact-a', { method: 'PATCH', body: JSON.stringify({ customerId: null, email: '' }) });
    expect(response.status).toBe(200);
    expect(mockMarketingContactUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'contact-a' },
      data: expect.objectContaining({ customerId: null, email: null, normalizedEmail: null }),
    }));
  });

  it('archives rather than hard-deletes contacts', async () => {
    const response = await request('/contacts/contact-a', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(mockMarketingContactUpdateMany).toHaveBeenCalledWith({
      where: { id: 'contact-a', organizationId: 'org-a' },
      data: { status: 'ARCHIVED' },
    });
  });

  it('requires the configured read permission', async () => {
    expect((await request('/contacts', {}, [])).status).toBe(403);
  });
});