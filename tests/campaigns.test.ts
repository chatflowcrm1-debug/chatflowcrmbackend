import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { signJwt } from '../src/modules/auth/auth.service';

const findMany = jest.fn();
const marketingContactFindMany = jest.fn();
const create = jest.fn();
const campaignFindFirst = jest.fn();
const campaignUpdate = jest.fn();

jest.mock('../src/db/prisma', () => ({
  prisma: {
    customer: { findMany },
    marketingContact: { findMany: marketingContactFindMany },
    campaign: { create, findFirst: campaignFindFirst, findMany: jest.fn(), update: campaignUpdate },
  },
}));

import campaignRoutes from '../src/modules/campaigns/campaigns.routes';

const app = express();
app.use(express.json());
app.use('/api/campaigns', campaignRoutes);

async function request(body?: Record<string, unknown>, path = '/api/campaigns', method = 'POST') {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${signJwt({ id: 'user-a', email: 'a@example.com', organizationId: 'org-a', role: 'OWNER', permissions: [] })}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const campaignBody = { name: 'Launch', type: 'EMAIL', audience: 'SELECTED', customerIds: ['customer-a'], subject: 'Hello', content: 'Welcome' };

describe('campaign recipient selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([{ id: 'customer-a', email: 'a@example.com', phone: null }]);
    marketingContactFindMany.mockResolvedValue([{ id: 'contact-a', customerId: 'customer-a', email: 'a@example.com', phone: null }]);
    create.mockResolvedValue({ id: 'campaign-a', _count: { recipients: 1 } });
    campaignUpdate.mockResolvedValue({ id: 'campaign-a', _count: { recipients: 1 } });
    campaignFindFirst.mockResolvedValue(null);
  });

  it('creates selected marketing-only recipients with a null customerId', async () => {
    marketingContactFindMany.mockResolvedValue([{ id: 'contact-a', customerId: null, email: 'a@example.com', phone: null }]);
    const response = await request({ ...campaignBody, customerIds: [], marketingContactIds: ['contact-a'] });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ recipients: { create: [{ marketingContactId: 'contact-a', customerId: null, destination: 'a@example.com' }] } }) }));
    expect(findMany).not.toHaveBeenCalled();
  });

  it('resolves legacy selected Customer IDs through linked MarketingContacts', async () => {
    const response = await request(campaignBody);
    expect(response.status).toBe(201);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-a', id: { in: ['customer-a'] } } }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ recipients: { create: [{ marketingContactId: 'contact-a', customerId: 'customer-a', destination: 'a@example.com' }] } }) }));
  });

  it('supports multiple MarketingContacts linked to one Customer without using the legacy customer unique key', async () => {
    marketingContactFindMany.mockResolvedValue([
      { id: 'contact-a', customerId: 'customer-a', email: 'a@example.com', phone: null },
      { id: 'contact-b', customerId: 'customer-a', email: 'b@example.com', phone: null },
    ]);
    const response = await request({ ...campaignBody, customerIds: [], marketingContactIds: ['contact-a', 'contact-b'] });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ recipients: { create: [
        { marketingContactId: 'contact-a', customerId: null, destination: 'a@example.com' },
        { marketingContactId: 'contact-b', customerId: null, destination: 'b@example.com' },
      ] } }),
    }));
  });

  it('rejects selected MarketingContact IDs outside the organization', async () => {
    marketingContactFindMany.mockResolvedValue([]);
    const response = await request({ ...campaignBody, customerIds: [], marketingContactIds: ['foreign-contact'] });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects selected Customer IDs outside the organization', async () => {
    findMany.mockResolvedValue([]);
    const response = await request(campaignBody);
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an empty selected audience', async () => {
    const response = await request({ ...campaignBody, customerIds: [], marketingContactIds: [] });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('deduplicates repeated selected MarketingContact IDs', async () => {
    const response = await request({ ...campaignBody, customerIds: [], marketingContactIds: ['contact-a', 'contact-a'] });
    expect(response.status).toBe(201);
    expect(marketingContactFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-a', status: 'ACTIVE', id: { in: ['contact-a'] } }) }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ recipients: { create: [{ marketingContactId: 'contact-a', customerId: 'customer-a', destination: 'a@example.com' }] } }) }));
  });

  it('resolves ALL organization MarketingContacts by the campaign channel', async () => {
    marketingContactFindMany.mockResolvedValue([
      { id: 'email-contact', customerId: null, email: 'email@example.com', phone: null },
      { id: 'sms-contact', customerId: null, email: null, phone: '+12125550101' },
    ]);
    const emailResponse = await request({ ...campaignBody, audience: 'ALL', customerIds: [] });
    expect(emailResponse.status).toBe(201);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ recipients: { create: [{ marketingContactId: 'email-contact', customerId: null, destination: 'email@example.com' }] } }) }));

    const smsResponse = await request({ name: 'SMS', type: 'SMS', audience: 'ALL', customerIds: [], content: 'Hello' });
    expect(smsResponse.status).toBe(201);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ recipients: { create: [{ marketingContactId: 'sms-contact', customerId: null, destination: '+12125550101' }] } }) }));
  });

  it('allows ALL campaigns with MarketingContacts and no CRM Customers', async () => {
    marketingContactFindMany.mockResolvedValue([{ id: 'contact-a', customerId: null, email: 'a@example.com', phone: null }]);
    findMany.mockResolvedValue([]);
    const response = await request({ ...campaignBody, audience: 'ALL', customerIds: [] });
    expect(response.status).toBe(201);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('requests only active MarketingContacts for ALL audiences', async () => {
    const response = await request({ ...campaignBody, audience: 'ALL', customerIds: [] });
    expect(response.status).toBe(201);
    expect(marketingContactFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: 'org-a', status: 'ACTIVE' },
    }));
  });

  it('rejects selected contacts with no destination for the requested channel', async () => {
    marketingContactFindMany.mockResolvedValue([{ id: 'contact-a', customerId: null, email: null, phone: null }]);
    const response = await request({ ...campaignBody, customerIds: [], marketingContactIds: ['contact-a'] });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns historical Customer-only recipients and their CampaignEvents unchanged', async () => {
    const event = { id: 'event-a', campaignId: 'campaign-a', campaignRecipientId: 'recipient-a', type: 'SENT', metadata: null };
    const historicalCampaign = {
      id: 'campaign-a',
      organizationId: 'org-a',
      recipients: [{
        id: 'recipient-a',
        campaignId: 'campaign-a',
        customerId: 'customer-a',
        marketingContactId: null,
        destination: 'a@example.com',
        status: 'SENT',
        sentAt: '2026-09-01T00:00:00.000Z',
        deliveredAt: null,
        failedAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        customer: { id: 'customer-a', name: 'Customer A', email: 'a@example.com', phone: null },
        marketingContact: null,
        events: [event],
      }],
      events: [event],
    };
    campaignFindFirst.mockResolvedValue(historicalCampaign);
    const response = await request(undefined, '/api/campaigns/campaign-a', 'GET');
    const payload = await response.json() as { data: typeof historicalCampaign };
    expect(response.status).toBe(200);
    expect(payload.data.recipients[0]).toMatchObject({
      id: 'recipient-a',
      campaignId: 'campaign-a',
      customerId: 'customer-a',
      marketingContactId: null,
      destination: 'a@example.com',
      status: 'SENT',
      sentAt: '2026-09-01T00:00:00.000Z',
      events: [event],
    });
    expect(payload.data.events).toEqual([event]);
  });

  it('does not replace existing recipients or their events when PATCH changes the audience', async () => {
    const historicalEvent = { id: 'event-a', campaignRecipientId: 'recipient-a' };
    campaignFindFirst.mockResolvedValue({
      id: 'campaign-a',
      organizationId: 'org-a',
      type: 'EMAIL',
      status: 'DRAFT',
      subject: 'Hello',
      recipients: [{ id: 'recipient-a', customerId: 'customer-a', marketingContactId: 'contact-a', events: [historicalEvent] }],
    });
    marketingContactFindMany.mockResolvedValue([{ id: 'contact-b', customerId: null, email: 'b@example.com', phone: null }]);
    const response = await request(
      { audience: 'SELECTED', customerIds: [], marketingContactIds: ['contact-b'] },
      '/api/campaigns/campaign-a',
      'PATCH',
    );
    expect(response.status).toBe(400);
    expect(campaignUpdate).not.toHaveBeenCalled();
  });
});