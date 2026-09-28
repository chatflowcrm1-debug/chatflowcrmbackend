import http from 'http';
import net from 'net';
import app from '../src/app';
import { prisma } from '../src/db/prisma';
import { signJwt } from '../src/modules/auth/auth.service';
import { computeRequestHash, ensureTelecomOperation, hashValue } from '../src/modules/telecom/telecom.operations';
import { MockTelecomProvider } from '../src/modules/telecom/providers/MockTelecomProvider';
import { TelnyxTelecomProvider } from '../src/modules/telecom/providers/TelnyxTelecomProvider';

const organizationA = 'org-a';
const organizationB = 'org-b';
const rawIdempotencyKey = 'sensitive-key-for-test';
const phoneNumberId = 'phone-1';

type StoredOperation = {
  id: string;
  organizationId: string;
  userId: string;
  customerId: string | null;
  phoneNumberId: string | null;
  operationType: string;
  provider: string;
  status: string;
  idempotencyKeyHash: string;
  requestHash: string;
  metadata: Record<string, unknown>;
  attemptCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type RequestOptions = {
  organizationId?: string;
  idempotencyKey?: string;
  path: string;
  body: Record<string, unknown>;
};

let operations: StoredOperation[];
let nextOperationId: number;
let server: http.Server;
let forceConcurrentInitialMisses: boolean;
let initialLookups: number;
let releaseInitialLookups: () => void;
let initialLookupsReleased: Promise<void>;
let providerSpies: jest.SpyInstance[];
let consoleSpies: jest.SpyInstance[];

const smsBody = {
  phoneNumberId,
  toNumber: '+12125550102',
  customerId: 'customer-a',
  body: 'Hello',
};
const callBody = {
  phoneNumberId,
  toNumber: '+12125550102',
  customerId: 'customer-a',
  recordingEnabled: false,
};
const purchaseBody = { providerNumberId: 'available-number-1' };

function makeOperationRequest(options: RequestOptions) {
  const token = signJwt({
    id: 'user-a',
    email: 'user-a@example.com',
    organizationId: options.organizationId || organizationA,
    role: 'OWNER',
    permissions: ['customers.write', 'settings.manage'],
  });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;

  return new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
    const request = http.request({
      method: 'POST',
      host: '127.0.0.1',
      port: (server.address() as net.AddressInfo).port,
      path: `/api/telecom${options.path}`,
      headers,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on('error', reject);
    request.write(JSON.stringify(options.body));
    request.end();
  });
}

function operationOptions(path: string, body: Record<string, unknown>, idempotencyKey = rawIdempotencyKey, organizationId = organizationA): RequestOptions {
  return { path, body, idempotencyKey, organizationId };
}

function operationLookupKey(operation: Pick<StoredOperation, 'organizationId' | 'operationType' | 'idempotencyKeyHash'>) {
  return `${operation.organizationId}|${operation.operationType}|${operation.idempotencyKeyHash}`;
}

describe('telecom durable operation creation and idempotency', () => {
  beforeAll((done) => {
    server = http.createServer(app).listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    operations = [];
    nextOperationId = 0;
    forceConcurrentInitialMisses = false;
    initialLookups = 0;
    initialLookupsReleased = new Promise<void>((resolve) => {
      releaseInitialLookups = resolve;
    });

    jest.spyOn(prisma.phoneNumber, 'findFirst').mockImplementation((async (args: any) => ({
      id: args.where.id,
      organizationId: args.where.organizationId,
      phoneNumber: '+12125550101',
      capabilities: ['sms', 'voice'],
    } as never)) as any);
    jest.spyOn(prisma.customer, 'findFirst').mockImplementation((async (args: any) => ({
      id: args.where.id,
      organizationId: args.where.organizationId,
    } as never)) as any);
    jest.spyOn(prisma.telecomOperation, 'findFirst').mockImplementation((async (args: any) => {
      if (forceConcurrentInitialMisses && initialLookups < 2) {
        initialLookups += 1;
        if (initialLookups === 2) releaseInitialLookups();
        await initialLookupsReleased;
        return null as never;
      }
      const where = args.where;
      return (operations.find((operation) => (
        operation.organizationId === where.organizationId
        && operation.operationType === where.operationType
        && operation.idempotencyKeyHash === where.idempotencyKeyHash
      )) || null) as never;
    }) as any);
    jest.spyOn(prisma.telecomOperation, 'create').mockImplementation((async ({ data }: any) => {
      const row = {
        id: `operation-${++nextOperationId}`,
        ...data,
        status: data.status || 'PENDING',
        metadata: data.metadata || {},
        attemptCount: 0,
        version: 0,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      } as StoredOperation;
      if (operations.some((operation) => operationLookupKey(operation) === operationLookupKey(row))) {
        const error = new Error('Unique constraint failed') as Error & { code: string };
        error.code = 'P2002';
        throw error;
      }
      operations.push(row);
      return row as never;
    }) as any);
    jest.spyOn(prisma.telecomCall, 'create').mockImplementation((async () => {
      throw new Error('TelecomCall creation is outside Phase 2J.1');
    }) as any);
    jest.spyOn(prisma.telecomMessage, 'create').mockImplementation((async () => {
      throw new Error('TelecomMessage creation is outside Phase 2J.1');
    }) as any);
    jest.spyOn(prisma.phoneNumber, 'create').mockImplementation((async () => {
      throw new Error('PhoneNumber creation is outside Phase 2J.1');
    }) as any);

    providerSpies = [
      jest.spyOn(MockTelecomProvider.prototype, 'purchaseNumber').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(MockTelecomProvider.prototype, 'sendSMS').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(MockTelecomProvider.prototype, 'makeCall').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'purchaseNumber').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'sendSMS').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'makeCall').mockRejectedValue(new Error('Provider action must not run')),
    ];
    consoleSpies = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });

  afterEach(() => {
    expect(providerSpies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    const consoleCalls = consoleSpies.flatMap((spy) => spy.mock.calls.flat());
    expect(consoleCalls.join(' ')).not.toContain(rawIdempotencyKey);
    jest.restoreAllMocks();
  });

  it.each([
    ['/numbers/purchase', purchaseBody, undefined],
    ['/numbers/purchase', purchaseBody, '   '],
    ['/messages', smsBody, undefined],
    ['/messages', smsBody, '   '],
    ['/calls', callBody, undefined],
    ['/calls', callBody, '   '],
  ])('requires a nonblank idempotency key for %s', async (path, body, idempotencyKey) => {
    const response = await makeOperationRequest({ path, body, idempotencyKey });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ message: 'Idempotency-Key header is required' });
    expect(prisma.telecomOperation.create).not.toHaveBeenCalled();
    expect(operations).toHaveLength(0);
  });

  it.each([
    ['/numbers/purchase', purchaseBody, 'NUMBER_PURCHASE'],
    ['/messages', smsBody, 'SMS_SEND'],
    ['/calls', callBody, 'VOICE_CALL'],
  ])('creates one pending %s operation without dispatching a provider', async (path, body, operationType) => {
    const response = await makeOperationRequest(operationOptions(path, body));
    const operation = JSON.parse(response.body).data;

    expect(response.statusCode).toBe(201);
    expect(operation).toMatchObject({ operationType, status: 'PENDING' });
    expect(operation.id).toBeTruthy();
    expect(operation.createdAt).toBeTruthy();
    expect(Object.keys(operation).sort()).toEqual(['createdAt', 'id', 'operationType', 'status']);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      organizationId: organizationA,
      operationType,
      status: 'PENDING',
      attemptCount: 0,
      version: 0,
    });
  });

  it('replays the same operation for an identical request without creating another row', async () => {
    const first = await makeOperationRequest(operationOptions('/messages', smsBody));
    const firstOperation = JSON.parse(first.body).data;
    const second = await makeOperationRequest(operationOptions('/messages', smsBody));

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).data.id).toBe(firstOperation.id);
    expect(prisma.telecomOperation.create).toHaveBeenCalledTimes(1);
    expect(operations).toHaveLength(1);
  });

  it('rejects a changed request without modifying the original operation', async () => {
    await makeOperationRequest(operationOptions('/messages', smsBody));
    const original = JSON.stringify(operations[0]);
    const changedBody = { ...smsBody, body: 'Changed message' };
    const response = await makeOperationRequest(operationOptions('/messages', changedBody));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ message: 'Idempotency key reused with a different request payload' });
    expect(JSON.stringify(operations[0])).toBe(original);
    expect(prisma.telecomOperation.create).toHaveBeenCalledTimes(1);
    expect(operations).toHaveLength(1);
  });

  it('isolates identical keys and requests by organization', async () => {
    const first = await makeOperationRequest(operationOptions('/messages', smsBody, rawIdempotencyKey, organizationA));
    const second = await makeOperationRequest(operationOptions('/messages', smsBody, rawIdempotencyKey, organizationB));

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(operations).toHaveLength(2);
    expect(operations.map((operation) => operation.organizationId).sort()).toEqual([organizationA, organizationB]);
    expect(JSON.parse(first.body).data.id).not.toBe(JSON.parse(second.body).data.id);
  });

  it('isolates the same key by operation type', async () => {
    const sms = await makeOperationRequest(operationOptions('/messages', smsBody));
    const voice = await makeOperationRequest(operationOptions('/calls', callBody));

    expect(sms.statusCode).toBe(201);
    expect(voice.statusCode).toBe(201);
    expect(JSON.parse(sms.body).data.operationType).toBe('SMS_SEND');
    expect(JSON.parse(voice.body).data.operationType).toBe('VOICE_CALL');
    expect(operations).toHaveLength(2);
  });

  it('recovers concurrent creation after P2002 without mutating the winning row', async () => {
    forceConcurrentInitialMisses = true;
    const [first, second] = await Promise.all([
      makeOperationRequest(operationOptions('/messages', smsBody)),
      makeOperationRequest(operationOptions('/messages', smsBody)),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    expect(JSON.parse(first.body).data.id).toBe(JSON.parse(second.body).data.id);
    expect(operations).toHaveLength(1);
    expect(prisma.telecomOperation.create).toHaveBeenCalledTimes(2);
    expect(operations[0]).toMatchObject({ status: 'PENDING', attemptCount: 0, version: 0 });
  });

  it('does not persist or return the raw key or internal hashes', async () => {
    const response = await makeOperationRequest(operationOptions('/messages', smsBody));
    const responseText = response.body;
    const storedText = JSON.stringify(operations[0]);
    const createData = (prisma.telecomOperation.create as jest.Mock).mock.calls[0][0].data;

    expect(responseText).not.toContain(rawIdempotencyKey);
    expect(responseText).not.toContain('idempotencyKeyHash');
    expect(responseText).not.toContain('requestHash');
    expect(storedText).not.toContain(rawIdempotencyKey);
    expect(operations[0].idempotencyKeyHash).toBe(hashValue(rawIdempotencyKey));
    expect(createData.metadata).toEqual({ ...smsBody });
    expect(JSON.stringify(createData.metadata)).not.toContain(rawIdempotencyKey);
  });

  it('canonicalizes object keys and distinguishes meaningful payload changes', () => {
    const ordered = { phoneNumberId, toNumber: '+123456789', body: 'Hello' };
    const reordered = { body: 'Hello', toNumber: '+123456789', phoneNumberId };
    const changed = { body: 'Goodbye', toNumber: '+123456789', phoneNumberId };

    expect(computeRequestHash(ordered)).toBe(computeRequestHash(reordered));
    expect(computeRequestHash(ordered)).not.toBe(computeRequestHash(changed));
    expect(computeRequestHash({ values: ['first', 'second'] })).not.toBe(computeRequestHash({ values: ['second', 'first'] }));
  });

  it('preserves organization and operation-type scoping in the service lookup', async () => {
    const input = {
      organizationId: organizationA,
      userId: 'user-a',
      operationType: 'SMS_SEND' as const,
      provider: 'mock',
      requestPayload: { phoneNumberId, toNumber: '+12125550102', customerId: 'customer-a', body: 'Hello' },
      idempotencyKey: rawIdempotencyKey,
      customerId: 'customer-a',
      phoneNumberId,
    };
    await ensureTelecomOperation(input);

    expect(prisma.telecomOperation.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: organizationA,
        operationType: 'SMS_SEND',
        idempotencyKeyHash: hashValue(rawIdempotencyKey),
      },
    });
  });
});
