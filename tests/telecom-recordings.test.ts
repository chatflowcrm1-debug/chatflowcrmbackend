import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

const webhookEvents = new Map<string, any>();
const telecomCalls = new Map<string, any>();
const recordings = new Map<string, any>();
let recordingRecord: any = null;

const prismaMock: any = {
  phoneNumber: {
    findFirst: jest.fn(async ({ where }: any) => {
      if (where?.provider === 'telnyx' && where?.status === 'ACTIVE') {
        return { id: 'phone-1', organizationId: 'org-a', provider: 'telnyx' };
      }
      return null;
    }),
    findUnique: jest.fn(async () => ({ phoneNumber: '+15551234567' })),
  },
  telecomCall: {
    findFirst: jest.fn(async ({ where }: any) => {
      if (where.providerCallId) {
        return [...telecomCalls.values()].find((candidate) =>
          candidate.providerCallId === where.providerCallId
          && (!where.organizationId || candidate.organizationId === where.organizationId),
        ) || null;
      }
      return null;
    }),
    findUnique: jest.fn(async ({ where }: any) => [...telecomCalls.values()].find((candidate) => candidate.id === where.id) || null),
    create: jest.fn(async ({ data }: any) => {
      const created = { id: `call-${telecomCalls.size + 1}`, ...data };
      telecomCalls.set(`${data.organizationId}:${data.providerCallId}`, created);
      return created;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const call = [...telecomCalls.values()].find((candidate) => candidate.id === where.id);
      Object.assign(call, data);
      return call;
    }),
  },
  recording: {
    findUnique: jest.fn(async ({ where }: any) => {
      if (where?.callId) return recordings.get(where.callId) || null;
      if (where?.id) return recordings.get(where.id) || null;
      return null;
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      if (where?.callId) return recordings.get(where.callId) || null;
      if (where?.providerRecordingId) return [...recordings.values()].find((candidate) => candidate.providerRecordingId === where.providerRecordingId) || null;
      return null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const created = { id: `recording-${recordings.size + 1}`, ...data };
      recordings.set(data.callId, created);
      recordings.set(created.id, created);
      recordingRecord = created;
      return created;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const record = recordings.get(where.id) || recordings.get(where.callId) || recordingRecord;
      if (record) Object.assign(record, data);
      return record;
    }),
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
      return data;
    }),
    update: jest.fn(async ({ data }: any) => data),
  },
  $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(prismaMock)),
};

jest.mock('../src/db/prisma', () => ({ prisma: prismaMock }));
jest.mock('../src/config/env', () => ({ env: { telnyxPublicKey: '', corsOrigins: ['http://localhost:3000'] } }));

import telecomWebhookRoutes from '../src/modules/telecom/telecom.webhook.routes';
import { verifyTelnyxWebhookSignature } from '../src/modules/telecom/telecom.webhook';
import { env } from '../src/config/env';

const keyPair = crypto.generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedBody(body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const signature = crypto.sign(null, Buffer.from(`${timestamp}.${rawBody.toString('utf8')}`), keyPair.privateKey).toString('base64');
  return { rawBody, timestamp, signature };
}

const app = express();
app.use(express.json({ verify: (req, _res, buffer) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));
app.use('/api/telecom', telecomWebhookRoutes);

async function request(body: unknown) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const signed = signedBody(body);
  try {
    return await fetch(`http://127.0.0.1:${port}/api/telecom/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'telnyx-signature-ed25519': signed.signature,
        'telnyx-timestamp': signed.timestamp,
      },
      body: signed.rawBody,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

beforeEach(() => {
  env.telnyxPublicKey = publicKey;
  webhookEvents.clear();
  telecomCalls.clear();
  recordings.clear();
  recordingRecord = null;
  jest.clearAllMocks();
  telecomCalls.set('org-a:call-control-recording', {
    id: 'call-1',
    organizationId: 'org-a',
    provider: 'telnyx',
    providerCallId: 'call-control-recording',
    status: 'COMPLETED',
    recordingId: null,
  });
});

describe('telecom recording metadata lifecycle', () => {
  it('creates recording metadata for a completed call and updates it safely on duplicate provider events', async () => {
    const body = {
      data: {
        id: 'recording-event-1',
        event_type: 'recording.saved',
        occurred_at: new Date().toISOString(),
        payload: {
          id: 'recording-1',
          recording_id: 'recording-1',
          call_control_id: 'call-control-recording',
          recording_url: 'https://example.com/recording.mp3',
          duration_seconds: 84,
        },
      },
    };

    const first = await request(body);
    expect(first.status).toBe(200);
    expect(prismaMock.recording.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        callId: 'call-1',
        providerRecordingId: 'recording-1',
        storageUrl: 'https://example.com/recording.mp3',
        durationSeconds: 84,
        status: 'COMPLETED',
      }),
    });
    expect(prismaMock.telecomCall.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: expect.objectContaining({ recordingId: 'recording-1' }),
    });

    const second = await request({
      data: {
        id: 'recording-event-2',
        event_type: 'recording.saved',
        occurred_at: new Date().toISOString(),
        payload: {
          id: 'recording-1',
          recording_id: 'recording-1',
          call_control_id: 'call-control-recording',
          recording_url: 'https://example.com/recording.mp3',
          duration_seconds: 96,
        },
      },
    });
    expect(second.status).toBe(200);
    expect(prismaMock.recording.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.recording.update).toHaveBeenCalledWith(
      { where: { id: 'recording-1' }, data: expect.objectContaining({ status: 'COMPLETED', durationSeconds: 96 }) },
    );
  });

  it('ignores a recording event for an unknown or unmatched call', async () => {
    const response = await request({
      data: {
        id: 'recording-event-unknown',
        event_type: 'recording.saved',
        occurred_at: new Date().toISOString(),
        payload: {
          id: 'recording-unknown',
          recording_id: 'recording-unknown',
          call_control_id: 'call-control-unknown',
          recording_url: 'https://example.com/unknown.mp3',
          duration_seconds: 30,
        },
      },
    });

    expect(response.status).toBe(200);
    expect(prismaMock.recording.create).not.toHaveBeenCalled();
  });

  it('accepts a valid recording webhook signature', () => {
    const rawBody = Buffer.from(JSON.stringify({ data: { id: 'event-1', event_type: 'recording.saved', payload: { recording_id: 'rec-1' } } }));
    const timestamp = `${Math.floor(Date.now() / 1000)}`;
    const signature = crypto.sign(null, Buffer.from(`${timestamp}.${rawBody.toString('utf8')}`), keyPair.privateKey).toString('base64');
    expect(verifyTelnyxWebhookSignature(rawBody, signature, timestamp, publicKey)).toBe(true);
  });
});
