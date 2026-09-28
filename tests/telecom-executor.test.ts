import { executeTelecomOperation } from '../src/modules/telecom/telecom.executor';
import { MockTelecomProvider } from '../src/modules/telecom/providers/MockTelecomProvider';
import { TelnyxTelecomProvider } from '../src/modules/telecom/providers/TelnyxTelecomProvider';

jest.mock('../src/db/prisma', () => {
  const prismaMock: any = {
    telecomOperation: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    customer: { findUnique: jest.fn() },
    phoneNumber: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    telecomMessage: { create: jest.fn() },
    telecomCall: { create: jest.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = jest.requireMock('../src/db/prisma') as { prisma: any };

const now = new Date('2026-01-01T00:00:00.000Z');
let operations: Record<string, any>;
let provider: MockTelecomProvider;
let telnyxSpies: jest.SpyInstance[];

function makeOperation(overrides: Record<string, any> = {}) {
  return {
    id: 'op-1',
    organizationId: 'org-a',
    userId: 'user-a',
    customerId: null,
    phoneNumberId: null,
    telecomCallId: null,
    telecomMessageId: null,
    operationType: 'SMS_SEND',
    provider: 'mock',
    status: 'DISPATCHING',
    idempotencyKeyHash: 'hash',
    requestHash: 'request-hash',
    providerResourceType: null,
    providerResourceId: null,
    providerError: null,
    providerResponseRef: null,
    providerAcceptedAt: null,
    providerResolvedAt: null,
    attemptCount: 1,
    lastAttemptAt: now,
    nextAttemptAt: null,
    leaseOwner: 'lease-1',
    leaseUntil: new Date(now.getTime() + 60_000),
    version: 1,
    failureClass: null,
    reasonCode: null,
    reconciliationState: null,
    reconciledAt: null,
    reconciliationError: null,
    compensationState: null,
    compensationStartedAt: null,
    compensationCompletedAt: null,
    compensationError: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    failedAt: null,
    ...overrides,
  };
}

function applyMutation(existing: Record<string, any>, patch: Record<string, any>) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value && typeof value === 'object' && 'increment' in value) {
      existing[key] = Number(existing[key] ?? 0) + Number((value as any).increment ?? 0);
      return;
    }
    existing[key] = value;
  });
  return existing;
}

describe('telecom executor boundary', () => {
  beforeEach(() => {
    operations = {};
    provider = new MockTelecomProvider();

    (jest.spyOn(prisma.telecomOperation as any, 'findUnique') as any).mockImplementation(async ({ where }: any) => operations[where.id] ?? null);
    (jest.spyOn(prisma.telecomOperation as any, 'update') as any).mockImplementation(async ({ where, data }: any) => {
      const current = operations[where.id];
      if (!current) throw new Error('Operation not found');
      operations[where.id] = applyMutation({ ...current }, data);
      return operations[where.id];
    });
    (jest.spyOn(prisma.customer as any, 'findUnique') as any).mockImplementation(async ({ where }: any) => {
      const customers: Record<string, { id: string; organizationId: string }> = {
        'customer-a': { id: 'customer-a', organizationId: 'org-a' },
        'customer-b': { id: 'customer-b', organizationId: 'org-b' },
      };
      return customers[where.id] ?? null;
    });
    (jest.spyOn(prisma.phoneNumber as any, 'findUnique') as any).mockImplementation(async ({ where }: any) => {
      const match = Object.values(operations).flatMap((op) => op.createdPhoneNumber ? [op.createdPhoneNumber] : []).find((item: any) => item && item.id === where.id) ?? null;
      return match ?? null;
    });
    (jest.spyOn(prisma.phoneNumber as any, 'findFirst') as any).mockImplementation(async ({ where }: any) => {
      if (where.provider === 'mock' && where.providerNumberId === 'mock-allocation-existing') {
        return { id: 'phone-existing', organizationId: 'org-a', provider: 'mock', providerNumberId: 'mock-allocation-existing', phoneNumber: '+12125550055', capabilities: ['sms', 'voice'] };
      }
      return null;
    });
    (jest.spyOn(prisma.phoneNumber as any, 'create') as any).mockImplementation(async ({ data }: any) => {
      const row = {
        id: `phone-${Math.random().toString(36).slice(2)}`,
        ...data,
        createdAt: now,
        updatedAt: now,
      };
      operations[`phone:${row.id}`] = row;
      return row;
    });
    (jest.spyOn(prisma.telecomMessage as any, 'create') as any).mockImplementation(async ({ data }: any) => ({
      id: `msg-${Math.random().toString(36).slice(2)}`,
      ...data,
      createdAt: now,
      updatedAt: now,
    }));
    (jest.spyOn(prisma.telecomCall as any, 'create') as any).mockImplementation(async ({ data }: any) => ({
      id: `call-${Math.random().toString(36).slice(2)}`,
      ...data,
      createdAt: now,
      updatedAt: now,
    }));

    telnyxSpies = [
      jest.spyOn(TelnyxTelecomProvider.prototype, 'purchaseNumber').mockRejectedValue(new Error('Telnyx must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'sendSMS').mockRejectedValue(new Error('Telnyx must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'makeCall').mockRejectedValue(new Error('Telnyx must not run')),
    ];
  });

  afterEach(() => {
    expect(telnyxSpies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    jest.restoreAllMocks();
  });

  it('executes a NUMBER_PURCHASE and links the created PhoneNumber', async () => {
    const operation = makeOperation({
      id: 'purchase-op',
      operationType: 'NUMBER_PURCHASE',
      metadata: { providerNumberId: 'mock-us-212-local' },
      leaseOwner: 'lease-1',
      leaseUntil: new Date(now.getTime() + 60_000),
      provider: 'mock',
    });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-1', now });

    expect(result.status).toBe('executed');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(operations[operation.id].status).toBe('COMPLETED');
    expect(operations[operation.id].phoneNumberId).toBeTruthy();
    expect(operations[operation.id].providerResourceType).toBe('PHONE_NUMBER');
  });

  it('executes an SMS_SEND and links the created TelecomMessage', async () => {
    const createdNumber = {
      id: 'phone-123',
      organizationId: 'org-a',
      phoneNumber: '+12125550000',
      capabilities: ['sms'],
    };
    (operations as any)['phone:phone-123'] = createdNumber;
    const operation = makeOperation({
      id: 'sms-op',
      operationType: 'SMS_SEND',
      metadata: { phoneNumberId: 'phone-123', toNumber: '+12125550199', body: 'Hello there' },
      leaseOwner: 'lease-2',
      leaseUntil: new Date(now.getTime() + 60_000),
      provider: 'mock',
    });
    operations[operation.id] = operation;

    (jest.spyOn(prisma.phoneNumber as any, 'findUnique') as any).mockImplementation(async ({ where }: any) => {
      if (where.id === 'phone-123') return createdNumber;
      return null;
    });

    const spy = jest.spyOn(provider, 'sendSMS');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-2', now });

    expect(result.status).toBe('executed');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(operations[operation.id].status).toBe('COMPLETED');
    expect(operations[operation.id].telecomMessageId).toBeTruthy();
    expect(operations[operation.id].providerResourceType).toBe('TELECOM_MESSAGE');
  });

  it('executes a VOICE_CALL and links the created TelecomCall', async () => {
    const createdNumber = {
      id: 'phone-456',
      organizationId: 'org-a',
      phoneNumber: '+12125550001',
      capabilities: ['voice'],
    };
    (operations as any)['phone:phone-456'] = createdNumber;
    const operation = makeOperation({
      id: 'call-op',
      operationType: 'VOICE_CALL',
      metadata: { phoneNumberId: 'phone-456', toNumber: '+12125550198', recordingEnabled: true },
      leaseOwner: 'lease-3',
      leaseUntil: new Date(now.getTime() + 60_000),
      provider: 'mock',
    });
    operations[operation.id] = operation;

    (jest.spyOn(prisma.phoneNumber as any, 'findUnique') as any).mockImplementation(async ({ where }: any) => {
      if (where.id === 'phone-456') return createdNumber;
      return null;
    });

    const spy = jest.spyOn(provider, 'makeCall');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-3', now });

    expect(result.status).toBe('executed');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(operations[operation.id].status).toBe('COMPLETED');
    expect(operations[operation.id].telecomCallId).toBeTruthy();
    expect(operations[operation.id].providerResourceType).toBe('TELECOM_CALL');
  });

  it('marks a provider rejection as permanent failure and does not retry', async () => {
    const operation = makeOperation({
      id: 'failed-op',
      operationType: 'NUMBER_PURCHASE',
      metadata: { providerNumberId: 'bad-number' },
      leaseOwner: 'lease-4',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber').mockRejectedValue(new Error('Invalid number provided'));
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-4', now });

    expect(result.status).toBe('not_executable');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(operations[operation.id].status).toBe('FAILED');
    expect(operations[operation.id].failureClass).toBe('PERMANENT');
  });

  it('marks a retryable provider failure and schedules retry', async () => {
    const operation = makeOperation({
      id: 'retry-op',
      operationType: 'NUMBER_PURCHASE',
      metadata: { providerNumberId: 'temp-issue' },
      leaseOwner: 'lease-5',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber').mockRejectedValue(new Error('Telnyx 503 unavailable'));
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-5', now });

    expect(result.status).toBe('not_executable');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(operations[operation.id].status).toBe('RETRYABLE_FAILURE');
    expect(operations[operation.id].nextAttemptAt).toBeInstanceOf(Date);
  });

  it('marks an unknown outcome without immediate retry', async () => {
    const operation = makeOperation({
      id: 'unknown-op',
      operationType: 'NUMBER_PURCHASE',
      metadata: { providerNumberId: 'uncertain' },
      leaseOwner: 'lease-6',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber').mockRejectedValue(new Error('Connection reset after send'));
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-6', now });

    expect(result.status).toBe('not_executable');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(operations[operation.id].status).toBe('UNKNOWN_OUTCOME');
    expect(operations[operation.id].nextAttemptAt).toBeNull();
  });

  it('does not execute an already completed operation', async () => {
    const operation = makeOperation({ id: 'done-op', status: 'COMPLETED' });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'ignored', now });

    if (result.status !== 'not_executable') throw new Error('Expected not_executable');
    expect(result.reason).toBe('already_final');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not re-execute a failed operation', async () => {
    const operation = makeOperation({ id: 'failed-retry-op', status: 'FAILED' });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'ignored', now });

    if (result.status !== 'not_executable') throw new Error('Expected not_executable');
    expect(result.reason).toBe('already_final');
    expect(spy).not.toHaveBeenCalled();
    expect(operations[operation.id].status).toBe('FAILED');
  });

  it('does not re-execute an unknown-outcome operation', async () => {
    const operation = makeOperation({ id: 'unknown-retry-op', status: 'UNKNOWN_OUTCOME' });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'ignored', now });

    if (result.status !== 'not_executable') throw new Error('Expected not_executable');
    expect(result.reason).toBe('already_final');
    expect(spy).not.toHaveBeenCalled();
    expect(operations[operation.id].status).toBe('UNKNOWN_OUTCOME');
  });

  it('does not re-execute a provider-accepted operation', async () => {
    const operation = makeOperation({ id: 'accepted-retry-op', status: 'PROVIDER_ACCEPTED' });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'ignored', now });

    if (result.status !== 'not_executable') throw new Error('Expected not_executable');
    expect(result.reason).toBe('already_final');
    expect(spy).not.toHaveBeenCalled();
    expect(operations[operation.id].status).toBe('PROVIDER_ACCEPTED');
  });

  it('does not re-execute a localizing operation', async () => {
    const operation = makeOperation({ id: 'localizing-retry-op', status: 'LOCALIZING' });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'ignored', now });

    if (result.status !== 'not_executable') throw new Error('Expected not_executable');
    expect(result.reason).toBe('already_final');
    expect(spy).not.toHaveBeenCalled();
    expect(operations[operation.id].status).toBe('LOCALIZING');
  });

  it('does not execute when lease ownership does not match', async () => {
    const operation = makeOperation({ id: 'lease-mismatch', leaseOwner: 'lease-7', leaseUntil: new Date(now.getTime() + 60_000) });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'wrong-owner', now });

    if (result.status !== 'not_executable') throw new Error('Expected not_executable');
    expect(result.reason).toBe('wrong_lease_owner');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not execute when the lease has expired', async () => {
    const operation = makeOperation({ id: 'expired-lease', leaseOwner: 'lease-8', leaseUntil: new Date(now.getTime() - 1_000) });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-8', now });

    if (result.status !== 'not_executable') throw new Error('Expected not_executable');
    expect(result.reason).toBe('expired_lease');
    expect(spy).not.toHaveBeenCalled();
  });

  it('prevents cross-organization resource access', async () => {
    const operation = makeOperation({
      id: 'cross-org',
      organizationId: 'org-a',
      operationType: 'SMS_SEND',
      metadata: { phoneNumberId: 'other-org-number', toNumber: '+12125550150', body: 'Hello' },
      leaseOwner: 'lease-9',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    operations[operation.id] = operation;

    (jest.spyOn(prisma.phoneNumber as any, 'findUnique') as any).mockImplementation(async ({ where }: any) => {
      if (where.id === 'other-org-number') return { id: 'other-org-number', organizationId: 'org-b', phoneNumber: '+12125550009' };
      return null;
    });

    const spy = jest.spyOn(provider, 'sendSMS');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-9', now });

    expect(result.status).toBe('not_executable');
    expect(spy).not.toHaveBeenCalled();
    expect(operations[operation.id].status).toBe('FAILED');
  });

  it('rejects a cross-organization customer before provider execution', async () => {
    const operation = makeOperation({
      id: 'cross-org-customer',
      organizationId: 'org-a',
      customerId: 'customer-b',
      operationType: 'SMS_SEND',
      metadata: { phoneNumberId: 'phone-123', toNumber: '+12125550150', body: 'Hello' },
      leaseOwner: 'lease-10',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    operations[operation.id] = operation;

    (jest.spyOn(prisma.phoneNumber as any, 'findUnique') as any).mockImplementation(async ({ where }: any) => {
      if (where.id === 'phone-123') return { id: 'phone-123', organizationId: 'org-a', phoneNumber: '+12125550009', capabilities: ['sms'] };
      return null;
    });

    const spy = jest.spyOn(provider, 'sendSMS');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-10', now });

    expect(result.status).toBe('not_executable');
    expect(spy).not.toHaveBeenCalled();
    expect(operations[operation.id].status).toBe('FAILED');
    expect(operations[operation.id].reasonCode).toBe('CUSTOMER_ORGANIZATION_MISMATCH');
  });

  it('allows a same-organization customer to proceed', async () => {
    const operation = makeOperation({
      id: 'same-org-customer',
      organizationId: 'org-a',
      customerId: 'customer-a',
      operationType: 'NUMBER_PURCHASE',
      metadata: { providerNumberId: 'mock-us-212-local' },
      leaseOwner: 'lease-11',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    operations[operation.id] = operation;

    const spy = jest.spyOn(provider, 'purchaseNumber');
    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-11', now });

    expect(result.status).toBe('executed');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(operations[operation.id].status).toBe('COMPLETED');
  });

  it('reuses an existing provider-qualified PhoneNumber instead of creating a duplicate', async () => {
    const operation = makeOperation({
      id: 'duplicate-phone',
      organizationId: 'org-a',
      operationType: 'NUMBER_PURCHASE',
      metadata: { providerNumberId: 'mock-allocation-existing' },
      leaseOwner: 'lease-12',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    operations[operation.id] = operation;

    const providerSpy = jest.spyOn(provider, 'purchaseNumber').mockResolvedValue({
      providerNumberId: 'mock-allocation-existing',
      phoneNumber: '+12125550055',
      country: 'US',
      numberType: 'LOCAL',
      areaCode: '212',
      capabilities: ['sms', 'voice'],
      status: 'ACTIVE',
    });
    const createSpy = jest.spyOn(prisma.phoneNumber as any, 'create');

    const result = await executeTelecomOperation(operation.id, { provider, leaseOwner: 'lease-12', now });

    expect(result.status).toBe('executed');
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
    expect(operations[operation.id].phoneNumberId).toBe('phone-existing');
    expect(operations[operation.id].providerResourceId).toBe('mock-allocation-existing');
  });
});
