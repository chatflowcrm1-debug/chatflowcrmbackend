import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

const webhookEvents = new Map<string, any>();
const phoneNumber = { id: 'phone-1', organizationId: 'org-a' };
const telecomMessages = new Map<string, any>();
const conversations = new Map<string, any>();
const crmMessages: any[] = [];
const telecomCalls = new Map<string, any>();
const customers = [{ id: 'customer-a', organizationId: 'org-a', name: 'Customer A', phone: '+15550001111' }];
let registrationDelay = 0;

const prismaMock: any = {
  phoneNumber: {
    findMany: jest.fn(async ({ where }: any) => {
      const matches = where.provider === 'telnyx' && where.status === 'ACTIVE'
        && ((!where.providerNumberId && !where.phoneNumber)
          || (where.providerNumberId === 'telnyx-number-1' || where.phoneNumber === '+15551234567'));
      return matches ? [phoneNumber] : [];
    }),
    findUnique: jest.fn(async () => ({ phoneNumber: '+15551234567' })),
  },
  customer: {
    findMany: jest.fn(async ({ where }: any) => customers.filter((customer) => customer.organizationId === where.organizationId)),
  },
  conversation: {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = `${where.organizationId_channel_externalContactId.organizationId}:${where.organizationId_channel_externalContactId.channel}:${where.organizationId_channel_externalContactId.externalContactId}`;
      const existing = conversations.get(key);
      if (existing) { Object.assign(existing, update); return existing; }
      const created = { id: `conversation-${conversations.size + 1}`, ...create };
      conversations.set(key, created);
      return created;
    }),
  },
  message: {
    create: jest.fn(async ({ data }: any) => { const created = { id: `crm-message-${crmMessages.length + 1}`, ...data }; crmMessages.push(created); return created; }),
  },
  telecomMessage: {
    findUnique: jest.fn(async ({ where }: any) => {
      if (where.id) return [...telecomMessages.values()].find((candidate) => candidate.id === where.id) || null;
      return telecomMessages.get(`${where.provider_providerMessageId.provider}:${where.provider_providerMessageId.providerMessageId}`) || null;
    }),
    update: jest.fn(async ({ where, data }: any) => { const message = [...telecomMessages.values()].find((candidate) => candidate.id === where.id); Object.assign(message, data); return message; }),
    create: jest.fn(async ({ data }: any) => {
      const key = `${data.provider}:${data.providerMessageId}`;
      if (telecomMessages.has(key)) {
        const error = new Error('Unique constraint');
        (error as Error & { code?: string }).code = 'P2002';
        throw error;
      }
      const created = { id: `telecom-message-${telecomMessages.size + 1}`, ...data };
      telecomMessages.set(key, created);
      return created;
    }),
  },
  telecomCall: {
    findFirst: jest.fn(async ({ where }: any) => telecomCalls.get(`${where.organizationId}:${where.providerCallId}`) || null),
    findUnique: jest.fn(async ({ where }: any) => [...telecomCalls.values()].find((candidate) => candidate.id === where.id) || null),
    create: jest.fn(async ({ data }: any) => { const created = { id: `call-${telecomCalls.size + 1}`, ...data }; telecomCalls.set(`${data.organizationId}:${data.providerCallId}`, created); return created; }),
    update: jest.fn(async ({ where, data }: any) => { const call = [...telecomCalls.values()].find((candidate) => candidate.id === where.id); Object.assign(call, data); return call; }),
  },
  telecomOperation: {
    findMany: jest.fn(async () => []),
  },
  webhookEvent: {
    create: jest.fn(async ({ data }: any) => {
      const key = `${data.provider}:${data.externalEventId}`;
      if (webhookEvents.has(key)) {
        const error = new Error('Unique constraint');
        (error as Error & { code?: string }).code = 'P2002';
        throw error;
      }
      webhookEvents.set(key, data);
      if (registrationDelay) await new Promise((resolve) => setTimeout(resolve, registrationDelay));
      return data;
    }),
    update: jest.fn(async ({ data }: any) => data),
  },
  $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(prismaMock)),
};

jest.mock('../src/db/prisma', () => ({ prisma: prismaMock }));
jest.mock('../src/config/env', () => ({ env: { telnyxPublicKey: '', corsOrigins: ['http://localhost:3000'], telecomProvider: 'mock', telnyxApiKey: '', telnyxConnectionId: '', telnyxWebhookToleranceSeconds: 300, telnyxRequestTimeoutMs: 10000, jwtSecret: 'test-secret', jwtRefreshSecret: 'test-refresh-secret', appUrl: 'http://localhost:3000', apiUrl: 'http://localhost:4000' } }));

import app from '../src/app';
import { parseTelnyxWebhookEvent, verifyTelnyxWebhookSignature } from '../src/modules/telecom/telecom.webhook';
import { env } from '../src/config/env';

const keyPair = crypto.generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedBody(body: unknown, timestampOverride?: string) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = timestampOverride || `${Math.floor(Date.now() / 1000)}`;
  const signature = crypto.sign(null, Buffer.from(`${timestamp}.${rawBody.toString('utf8')}`), keyPair.privateKey).toString('base64');
  return { rawBody, timestamp, signature };
}

async function request(body: unknown, signature: 'valid' | 'invalid' | 'missing' = 'valid', timestampOverride?: string) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const signed = signedBody(body, timestampOverride);
  try {
    return await fetch(`http://127.0.0.1:${port}/api/telecom/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature === 'valid' ? { 'telnyx-signature-ed25519': signed.signature, 'telnyx-timestamp': signed.timestamp } : {}),
        ...(signature === 'invalid' ? { 'telnyx-signature-ed25519': 'invalid-signature', 'telnyx-timestamp': signed.timestamp } : {}),
      },
      body: signed.rawBody,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function event(overrides: Record<string, unknown> = {}) {
  const { eventType, ...payloadOverrides } = overrides;
  return { data: { id: 'event-1', event_type: eventType || 'call.initiated', occurred_at: new Date().toISOString(), payload: { phone_number_id: 'telnyx-number-1', call_control_id: 'call-control-foundation', from: { phone_number: '+15550001111' }, to: '+15551234567', ...payloadOverrides } } };
}

function inboundEvent(overrides: Record<string, unknown> = {}) {
  return { data: { id: 'sms-event-1', event_type: 'message.received', occurred_at: new Date().toISOString(), payload: { id: 'telnyx-message-1', phone_number_id: 'telnyx-number-1', from: { phone_number: '+15550001111' }, to: [{ phone_number: '+15551234567' }], text: 'Hello from Telnyx', ...overrides } } };
}

beforeEach(() => {
  env.telnyxPublicKey = publicKey;
  webhookEvents.clear();
  telecomMessages.clear();
  conversations.clear();
  crmMessages.length = 0;
  telecomCalls.clear();
  registrationDelay = 0;
  jest.clearAllMocks();
});

describe('Telnyx webhook foundation', () => {
  it('accepts a valid signed webhook', async () => {
    const body = event();
    const signed = signedBody(body);
    expect(verifyTelnyxWebhookSignature(signed.rawBody, signed.signature, signed.timestamp, publicKey)).toBe(true);
    const response = await request(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, registered: true, organizationResolved: true });
  });

  it('rejects invalid and missing signatures without creating an event', async () => {
    const invalid = await request(event(), 'invalid');
    expect(invalid.status).toBe(401);
    const missing = await request(event(), 'missing');
    expect(missing.status).toBe(401);
    expect(webhookEvents.size).toBe(0);
  });

  it('rejects expired and future timestamps even when the signature is valid', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await request(event({ id: 'expired-event' }), 'valid', `${now - 301}`);
    const future = await request(event({ id: 'future-event' }), 'valid', `${now + 301}`);
    expect(expired.status).toBe(401);
    expect(future.status).toBe(401);
  });

  it('rejects malformed timestamps and accepts a recent signed timestamp', async () => {
    const malformed = await request(event({ id: 'malformed-timestamp-event' }), 'valid', 'not-a-timestamp');
    const recent = await request(event({ id: 'recent-event' }), 'valid', `${Math.floor(Date.now() / 1000)}`);
    expect(malformed.status).toBe(401);
    expect(recent.status).toBe(200);
  });

  it('rejects malformed payloads and missing event IDs safely', async () => {
    const malformed = await request({ hello: 'world' });
    expect(malformed.status).toBe(400);
    const missingId = await request({ data: { event_type: 'call.initiated', payload: {} } });
    expect(missingId.status).toBe(400);
  });

  it('acknowledges unknown event types without processing business data', async () => {
    const response = await request(event({ event_type: 'future.unknown' }));
    expect(response.status).toBe(200);
    expect(webhookEvents.size).toBe(1);
  });

  it('does not create a second event for a duplicate', async () => {
    expect((await request(event())).status).toBe(200);
    const duplicate = await request(event());
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect(webhookEvents.size).toBe(1);
  });

  it('allows only one concurrent duplicate registration', async () => {
    registrationDelay = 10;
    const results = await Promise.all([request(event()), request(event())]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 200]);
    expect(webhookEvents.size).toBe(1);
    const payloads = await Promise.all(results.map((response) => response.json() as Promise<{ duplicate?: boolean }>));
    expect(payloads.filter((payload) => payload.duplicate)).toHaveLength(1);
  });

  it('does not trust attacker-controlled organization data or unknown numbers', async () => {
    const response = await request(event({ organizationId: 'attacker-org', phone_number_id: 'unknown-number', to: '+19999999999' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ organizationResolved: false });
    expect(webhookEvents.get('TELNYX:event-1').organizationId).toBeUndefined();
  });

  it('uses the E.164 number when a webhook omits the provider number ID', async () => {
    const body = inboundEvent() as { data: { payload: Record<string, unknown> } };
    delete body.data.payload.phone_number_id;
    const response = await request(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ organizationResolved: true });
  });

  it('does not assign an ambiguous provider number to an organization', async () => {
    prismaMock.phoneNumber.findMany.mockResolvedValueOnce([
      phoneNumber,
      { id: 'phone-2', organizationId: 'org-b' },
    ]);
    const body = event();
    body.data.id = 'ambiguous-event';
    const response = await request(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ organizationResolved: false });
    expect(webhookEvents.get('TELNYX:ambiguous-event').organizationId).toBeUndefined();
  });

  it('does not include secrets in signature errors', async () => {
    const response = await request(event(), 'invalid');
    const body = await response.text();
    expect(body).not.toContain('BEGIN PUBLIC KEY');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('key');
  });

  it('normalizes event fields without requiring organization data', () => {
    expect(parseTelnyxWebhookEvent(event())).toMatchObject({ externalEventId: 'event-1', eventType: 'call.initiated' });
    expect(parseTelnyxWebhookEvent({ data: { id: 'x', event_type: 'x', payload: 'not-object' } })).toMatchObject({ payload: {} });
  });

  it('creates an inbound TelecomMessage, conversation, and CRM Message for a matching customer', async () => {
    const response = await request(inboundEvent());
    expect(response.status).toBe(200);
    expect(telecomMessages.size).toBe(1);
    expect([...telecomMessages.values()][0]).toMatchObject({ organizationId: 'org-a', customerId: 'customer-a', direction: 'INBOUND', provider: 'telnyx', status: 'RECEIVED' });
    expect(conversations.size).toBe(1);
    expect(crmMessages).toHaveLength(1);
    expect(crmMessages[0]).toMatchObject({ organizationId: 'org-a', direction: 'INBOUND', provider: 'telnyx' });
  });

  it('reuses the conversation and rejects duplicate provider messages', async () => {
    expect((await request(inboundEvent())).status).toBe(200);
    expect((await request({ ...inboundEvent(), data: { ...inboundEvent().data, id: 'sms-event-2' } })).status).toBe(200);
    expect(conversations.size).toBe(1);
    expect(telecomMessages.size).toBe(1);
    expect(crmMessages).toHaveLength(1);
  });

  it('does not create two messages for concurrent events with the same provider message ID', async () => {
    const first = inboundEvent();
    const second = inboundEvent({ id: 'telnyx-message-1' });
    second.data.id = 'sms-event-concurrent-2';
    const results = await Promise.all([request(first), request(second)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 200]);
    expect(telecomMessages.size).toBe(1);
    expect(crmMessages).toHaveLength(1);
  });

  it('retains unknown senders without creating customers and rejects unknown destinations', async () => {
    const unknownSender = await request(inboundEvent({ from: { phone_number: '+15559999999' }, id: 'telnyx-message-unknown' }));
    expect(unknownSender.status).toBe(200);
    expect([...telecomMessages.values()][0].customerId).toBeNull();
    const unknownDestination = await request(inboundEvent({ to: [{ phone_number: '+15550000000' }], id: 'telnyx-message-unknown-destination' }));
    expect(unknownDestination.status).toBe(200);
    expect(telecomMessages.size).toBe(1);
  });

  it('updates outbound SMS statuses monotonically and ignores stale events', async () => {
    telecomMessages.set('telnyx:outbound-message-1', { id: 'outbound-1', provider: 'telnyx', providerMessageId: 'outbound-message-1', status: 'QUEUED' });
    const statusEvent = (eventType: string, id: string) => request({ data: { id, event_type: eventType, occurred_at: new Date().toISOString(), payload: { id: 'outbound-message-1' } } });
    expect((await statusEvent('message.sent', 'status-sent')).status).toBe(200);
    expect([...telecomMessages.values()][0].status).toBe('SENT');
    expect((await statusEvent('message.delivered', 'status-delivered')).status).toBe(200);
    expect([...telecomMessages.values()][0].status).toBe('DELIVERED');
    expect((await statusEvent('message.queued', 'status-queued')).status).toBe(200);
    expect([...telecomMessages.values()][0].status).toBe('DELIVERED');
  });

  it('does not move a failed outbound SMS back to sent', async () => {
    telecomMessages.set('telnyx:outbound-message-failed', { id: 'outbound-failed', provider: 'telnyx', providerMessageId: 'outbound-message-failed', status: 'FAILED' });
    const response = await request({ data: { id: 'status-after-failed', event_type: 'message.sent', occurred_at: new Date().toISOString(), payload: { id: 'outbound-message-failed' } } });
    expect(response.status).toBe(200);
    expect([...telecomMessages.values()].find((message) => message.id === 'outbound-failed').status).toBe('FAILED');
  });

  it('keeps media metadata processing-safe without downloading media', async () => {
    const response = await request(inboundEvent({ media: [{ url: 'https://provider.invalid/media' }] }));
    expect(response.status).toBe(200);
    expect([...telecomMessages.values()][0]).toMatchObject({ direction: 'INBOUND' });
  });

  it('creates and advances one inbound call through its lifecycle', async () => {
    const base = { id: 'call-message-1', call_control_id: 'call-control-1', from: { phone_number: '+15550001111' }, to: '+15551234567' };
    const sendCallEvent = (eventType: string) => request({ data: { id: `call-event-${eventType}`, event_type: eventType, occurred_at: new Date().toISOString(), payload: { phone_number_id: 'telnyx-number-1', ...base } } });
    expect((await sendCallEvent('call.initiated')).status).toBe(200);
    expect((await sendCallEvent('call.ringing')).status).toBe(200);
    expect((await sendCallEvent('call.answered')).status).toBe(200);
    expect((await sendCallEvent('call.completed')).status).toBe(200);
    expect(telecomCalls.size).toBe(1);
    expect([...telecomCalls.values()][0]).toMatchObject({ organizationId: 'org-a', customerId: 'customer-a', providerCallId: 'call-control-1', direction: 'INBOUND', status: 'COMPLETED' });
  });

  it('does not regress a completed call when an old event arrives', async () => {
    const base = { call_control_id: 'call-control-stale', from: { phone_number: '+15550001111' }, to: '+15551234567' };
    const send = (id: string, eventType: string) => request({ data: { id, event_type: eventType, occurred_at: new Date().toISOString(), payload: { phone_number_id: 'telnyx-number-1', ...base } } });
    await send('stale-complete', 'call.completed');
    await send('stale-ringing', 'call.ringing');
    expect([...telecomCalls.values()].find((call) => call.providerCallId === 'call-control-stale')).toMatchObject({ status: 'COMPLETED' });
  });

  it('ignores ambiguous provider-resource matches during webhook reconciliation', async () => {
    telecomMessages.set('telnyx:ambiguous-message', { id: 'message-ambiguous', provider: 'telnyx', providerMessageId: 'ambiguous-message', status: 'QUEUED', organizationId: 'org-a' });
    prismaMock.telecomOperation.findMany.mockResolvedValueOnce([
      { id: 'op-1', organizationId: 'org-a', provider: 'telnyx', providerResourceType: 'TELECOM_MESSAGE', providerResourceId: 'ambiguous-message' },
      { id: 'op-2', organizationId: 'org-a', provider: 'telnyx', providerResourceType: 'TELECOM_MESSAGE', providerResourceId: 'ambiguous-message' },
    ]);

    const response = await request({ data: { id: 'status-ambiguous', event_type: 'message.sent', occurred_at: new Date().toISOString(), payload: { id: 'ambiguous-message' } } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, registered: true });
    expect(prismaMock.telecomOperation.findMany).toHaveBeenCalled();
  });

  it('returns a transient error when database processing fails', async () => {
    prismaMock.webhookEvent.create.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await request(inboundEvent({ id: 'transient-event' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: 'Webhook processing failed' });
  });
});
