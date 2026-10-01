import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { signJwt } from '../src/modules/auth/auth.service';

const findMany = jest.fn();
const create = jest.fn();

jest.mock('../src/db/prisma', () => ({
  prisma: {
    customer: { findMany },
    campaign: { create, findFirst: jest.fn(), findMany: jest.fn() },
  },
}));

import campaignRoutes from '../src/modules/campaigns/campaigns.routes';

const app = express();
app.use(express.json());
app.use('/api/campaigns', campaignRoutes);

async function request(body: Record<string, unknown>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/campaigns`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signJwt({ id: 'user-a', email: 'a@example.com', organizationId: 'org-a', role: 'OWNER', permissions: [] })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
    create.mockResolvedValue({ id: 'campaign-a', _count: { recipients: 1 } });
  });

  it('accepts selected customers owned by the organization', async () => {
    const response = await request(campaignBody);
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ recipients: { create: [{ customerId: 'customer-a', destination: 'a@example.com' }] } }) }));
  });

  it('rejects selected customers outside the organization', async () => {
    findMany.mockResolvedValue([]);
    const response = await request(campaignBody);
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an empty selected audience', async () => {
    const response = await request({ ...campaignBody, customerIds: [] });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});