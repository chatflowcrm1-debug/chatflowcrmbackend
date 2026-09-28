import { reconcileTelecomOperation } from '../src/modules/telecom/telecom.reconciliation';

jest.mock('../src/db/prisma', () => ({
  prisma: {
    telecomOperation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    phoneNumber: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    telecomMessage: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    telecomCall: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    customer: {
      findUnique: jest.fn(),
    },
  },
}));

const { prisma } = jest.requireMock('../src/db/prisma') as { prisma: any };

function makeOperation(overrides: Record<string, any> = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'op-1',
    organizationId: 'org-a',
    userId: 'user-a',
    customerId: null,
    phoneNumberId: null,
    telecomCallId: null,
    telecomMessageId: null,
    operationType: 'NUMBER_PURCHASE',
    provider: 'mock',
    status: 'PROVIDER_ACCEPTED',
    idempotencyKeyHash: 'hash',
    requestHash: 'request',
    providerResourceType: null,
    providerResourceId: null,
    providerError: null,
    providerResponseRef: null,
    providerAcceptedAt: null,
    providerResolvedAt: null,
    attemptCount: 1,
    lastAttemptAt: now,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseUntil: null,
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

describe('telecom operation reconciliation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('marks unknown outcome as reconciliation-required without retrying provider actions', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = {
      id: 'reconcile-unknown',
      organizationId: 'org-a',
      userId: 'user-a',
      customerId: null,
      phoneNumberId: null,
      telecomCallId: null,
      telecomMessageId: null,
      operationType: 'NUMBER_PURCHASE',
      provider: 'mock',
      status: 'UNKNOWN_OUTCOME',
      idempotencyKeyHash: 'hash',
      requestHash: 'request',
      providerResourceType: null,
      providerResourceId: null,
      providerError: 'Connection reset after send',
      providerResponseRef: null,
      providerAcceptedAt: null,
      providerResolvedAt: null,
      attemptCount: 1,
      lastAttemptAt: now,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseUntil: null,
      version: 2,
      failureClass: 'UNKNOWN',
      reasonCode: 'UNKNOWN_OUTCOME',
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
    };

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);
    prisma.telecomOperation.updateMany.mockResolvedValue({ count: 1 });

    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('unresolved');
    expect(result.reconciliationState).toBe('REQUIRED');
    expect(prisma.telecomOperation.updateMany).toHaveBeenCalled();
  });

  it('marks cross-organization or ambiguous provider identity as ambiguous without choosing arbitrarily', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = {
      id: 'reconcile-ambiguous',
      organizationId: 'org-a',
      userId: 'user-a',
      customerId: null,
      phoneNumberId: null,
      telecomCallId: null,
      telecomMessageId: null,
      operationType: 'NUMBER_PURCHASE',
      provider: 'mock',
      status: 'PROVIDER_ACCEPTED',
      idempotencyKeyHash: 'hash',
      requestHash: 'request',
      providerResourceType: 'PHONE_NUMBER',
      providerResourceId: 'shared-provider-id',
      providerError: null,
      providerResponseRef: null,
      providerAcceptedAt: now,
      providerResolvedAt: null,
      attemptCount: 2,
      lastAttemptAt: now,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseUntil: null,
      version: 3,
      failureClass: null,
      reasonCode: null,
      reconciliationState: null,
      reconciledAt: null,
      reconciliationError: null,
      compensationState: null,
      compensationStartedAt: null,
      compensationCompletedAt: null,
      compensationError: null,
      metadata: { providerNumberId: 'shared-provider-id' },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      failedAt: null,
    };

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);
    prisma.telecomOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.phoneNumber.findMany.mockResolvedValue([
      { id: 'number-1', organizationId: 'org-a', provider: 'mock', providerNumberId: 'shared-provider-id', phoneNumber: '+12125550101' },
      { id: 'number-2', organizationId: 'org-b', provider: 'mock', providerNumberId: 'shared-provider-id', phoneNumber: '+12125550102' },
    ]);

    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('ambiguous');
    expect(result.reconciliationState).toBe('AMBIGUOUS');
  });

  it('reuses a single local PhoneNumber for a NUMBER_PURCHASE operation and resolves without provider re-execution', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = makeOperation({
      id: 'purchase-reconcile',
      operationType: 'NUMBER_PURCHASE',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'PHONE_NUMBER',
      providerResourceId: 'provider-number-1',
      providerAcceptedAt: now,
      metadata: { providerNumberId: 'provider-number-1', phoneNumber: '+12125550101', country: 'US', numberType: 'LOCAL' },
    });

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);
    prisma.telecomOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.phoneNumber.findMany.mockResolvedValue([
      { id: 'phone-1', organizationId: 'org-a', provider: 'mock', providerNumberId: 'provider-number-1', phoneNumber: '+12125550101' },
    ]);

    const provider = { purchaseNumber: jest.fn(), sendSMS: jest.fn(), makeCall: jest.fn() } as any;
    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('resolved');
    expect(result.reconciliationState).toBe('RESOLVED');
    expect(prisma.phoneNumber.create).not.toHaveBeenCalled();
    expect(provider.purchaseNumber).not.toHaveBeenCalled();
    expect(provider.sendSMS).not.toHaveBeenCalled();
    expect(provider.makeCall).not.toHaveBeenCalled();
  });

  it('treats zero, multiple, and cross-organization number matches as unresolved or ambiguous without guessing', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const zeroMatchOperation = makeOperation({
      id: 'purchase-zero',
      operationType: 'NUMBER_PURCHASE',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'PHONE_NUMBER',
      providerResourceId: 'provider-number-missing',
      metadata: {},
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(zeroMatchOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.phoneNumber.findMany.mockResolvedValueOnce([]);
    const zeroResult = await reconcileTelecomOperation(zeroMatchOperation.id, { now });
    expect(zeroResult.status).toBe('unresolved');
    expect(zeroResult.reconciliationState).toBe('REQUIRED');

    const multiMatchOperation = makeOperation({
      id: 'purchase-multi',
      operationType: 'NUMBER_PURCHASE',
      status: 'LOCALIZING',
      providerResourceType: 'PHONE_NUMBER',
      providerResourceId: 'provider-number-shared',
      metadata: { providerNumberId: 'provider-number-shared', phoneNumber: '+12125550105', country: 'US', numberType: 'LOCAL' },
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(multiMatchOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.phoneNumber.findMany.mockResolvedValueOnce([
      { id: 'phone-2', organizationId: 'org-a', provider: 'mock', providerNumberId: 'provider-number-shared', phoneNumber: '+12125550105' },
      { id: 'phone-3', organizationId: 'org-a', provider: 'mock', providerNumberId: 'provider-number-shared', phoneNumber: '+12125550106' },
    ]);
    const multiResult = await reconcileTelecomOperation(multiMatchOperation.id, { now });
    expect(multiResult.status).toBe('ambiguous');
    expect(multiResult.reconciliationState).toBe('AMBIGUOUS');

    const crossOrgOperation = makeOperation({
      id: 'purchase-cross',
      operationType: 'NUMBER_PURCHASE',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'PHONE_NUMBER',
      providerResourceId: 'provider-number-cross',
      metadata: { providerNumberId: 'provider-number-cross', phoneNumber: '+12125550107', country: 'US', numberType: 'LOCAL' },
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(crossOrgOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.phoneNumber.findMany.mockResolvedValueOnce([
      { id: 'phone-4', organizationId: 'org-b', provider: 'mock', providerNumberId: 'provider-number-cross', phoneNumber: '+12125550107' },
    ]);
    const crossResult = await reconcileTelecomOperation(crossOrgOperation.id, { now });
    expect(crossResult.status).toBe('ambiguous');
    expect(crossResult.reconciliationState).toBe('AMBIGUOUS');
  });

  it('reuses a single local TelecomMessage for an SMS_SEND operation and does not repeat the provider send', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = makeOperation({
      id: 'sms-reconcile',
      operationType: 'SMS_SEND',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'TELECOM_MESSAGE',
      providerResourceId: 'provider-message-1',
      providerAcceptedAt: now,
      metadata: { phoneNumberId: 'phone-1', toNumber: '+12125550101', body: 'hello', providerMessageId: 'provider-message-1' },
    });

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);
    prisma.telecomOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.telecomMessage.findMany.mockResolvedValue([
      { id: 'message-1', organizationId: 'org-a', provider: 'mock', providerMessageId: 'provider-message-1', phoneNumberId: 'phone-1', toNumber: '+12125550101' },
    ]);
    const provider = { sendSMS: jest.fn(), purchaseNumber: jest.fn(), makeCall: jest.fn() } as any;

    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('resolved');
    expect(result.reconciliationState).toBe('RESOLVED');
    expect(prisma.telecomMessage.create).not.toHaveBeenCalled();
    expect(provider.sendSMS).not.toHaveBeenCalled();
    expect(provider.purchaseNumber).not.toHaveBeenCalled();
    expect(provider.makeCall).not.toHaveBeenCalled();
  });

  it('treats zero, multiple, and cross-organization SMS matches as unresolved or ambiguous', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const zeroOperation = makeOperation({
      id: 'sms-zero',
      operationType: 'SMS_SEND',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'TELECOM_MESSAGE',
      providerResourceId: 'provider-message-zero',
      metadata: {},
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(zeroOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.telecomMessage.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const zeroResult = await reconcileTelecomOperation(zeroOperation.id, { now });
    expect(zeroResult.status).toBe('unresolved');
    expect(zeroResult.reconciliationState).toBe('REQUIRED');

    const multiOperation = makeOperation({
      id: 'sms-multi',
      operationType: 'SMS_SEND',
      status: 'LOCALIZING',
      providerResourceType: 'TELECOM_MESSAGE',
      providerResourceId: 'provider-message-shared',
      metadata: { phoneNumberId: 'phone-1', toNumber: '+12125550101', body: 'hello' },
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(multiOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.telecomMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', organizationId: 'org-a', provider: 'mock', providerMessageId: 'provider-message-shared', phoneNumberId: 'phone-1', toNumber: '+12125550101' },
      { id: 'msg-2', organizationId: 'org-a', provider: 'mock', providerMessageId: 'provider-message-shared', phoneNumberId: 'phone-1', toNumber: '+12125550102' },
    ]);
    const multiResult = await reconcileTelecomOperation(multiOperation.id, { now });
    expect(multiResult.status).toBe('ambiguous');
    expect(multiResult.reconciliationState).toBe('AMBIGUOUS');

    const crossOperation = makeOperation({
      id: 'sms-cross',
      operationType: 'SMS_SEND',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'TELECOM_MESSAGE',
      providerResourceId: 'provider-message-cross',
      metadata: { phoneNumberId: 'phone-1', toNumber: '+12125550101', body: 'hello' },
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(crossOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.telecomMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-3', organizationId: 'org-b', provider: 'mock', providerMessageId: 'provider-message-cross', phoneNumberId: 'phone-1', toNumber: '+12125550101' },
    ]);
    const crossResult = await reconcileTelecomOperation(crossOperation.id, { now });
    expect(crossResult.status).toBe('ambiguous');
    expect(crossResult.reconciliationState).toBe('AMBIGUOUS');
  });

  it('reuses a single local TelecomCall for a VOICE_CALL operation and does not repeat the provider call', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = makeOperation({
      id: 'voice-reconcile',
      operationType: 'VOICE_CALL',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'TELECOM_CALL',
      providerResourceId: 'provider-call-1',
      providerAcceptedAt: now,
      metadata: { phoneNumberId: 'phone-1', toNumber: '+12125550101', recordingEnabled: true },
    });

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);
    prisma.telecomOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.telecomCall.findMany.mockResolvedValue([
      { id: 'call-1', organizationId: 'org-a', provider: 'mock', providerCallId: 'provider-call-1', toNumber: '+12125550101', status: 'INITIATED' },
    ]);
    const provider = { makeCall: jest.fn(), sendSMS: jest.fn(), purchaseNumber: jest.fn() } as any;

    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('resolved');
    expect(result.reconciliationState).toBe('RESOLVED');
    expect(prisma.telecomCall.create).not.toHaveBeenCalled();
    expect(provider.makeCall).not.toHaveBeenCalled();
    expect(provider.sendSMS).not.toHaveBeenCalled();
    expect(provider.purchaseNumber).not.toHaveBeenCalled();
  });

  it('treats zero, multiple, and cross-organization call matches as unresolved or ambiguous', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const zeroOperation = makeOperation({
      id: 'voice-zero',
      operationType: 'VOICE_CALL',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'TELECOM_CALL',
      providerResourceId: 'provider-call-zero',
      metadata: {},
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(zeroOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.telecomCall.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const zeroResult = await reconcileTelecomOperation(zeroOperation.id, { now });
    expect(zeroResult.status).toBe('unresolved');
    expect(zeroResult.reconciliationState).toBe('REQUIRED');

    const multiOperation = makeOperation({
      id: 'voice-multi',
      operationType: 'VOICE_CALL',
      status: 'LOCALIZING',
      providerResourceType: 'TELECOM_CALL',
      providerResourceId: 'provider-call-shared',
      metadata: { phoneNumberId: 'phone-1', toNumber: '+12125550101', recordingEnabled: true },
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(multiOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.telecomCall.findMany.mockResolvedValueOnce([
      { id: 'call-2', organizationId: 'org-a', provider: 'mock', providerCallId: 'provider-call-shared', toNumber: '+12125550101', status: 'INITIATED' },
      { id: 'call-3', organizationId: 'org-a', provider: 'mock', providerCallId: 'provider-call-shared', toNumber: '+12125550102', status: 'INITIATED' },
    ]);
    const multiResult = await reconcileTelecomOperation(multiOperation.id, { now });
    expect(multiResult.status).toBe('ambiguous');
    expect(multiResult.reconciliationState).toBe('AMBIGUOUS');

    const crossOperation = makeOperation({
      id: 'voice-cross',
      operationType: 'VOICE_CALL',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'TELECOM_CALL',
      providerResourceId: 'provider-call-cross',
      metadata: { phoneNumberId: 'phone-1', toNumber: '+12125550101', recordingEnabled: true },
    });
    prisma.telecomOperation.findUnique.mockResolvedValueOnce(crossOperation);
    prisma.telecomOperation.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.telecomCall.findMany.mockResolvedValueOnce([
      { id: 'call-4', organizationId: 'org-b', provider: 'mock', providerCallId: 'provider-call-cross', toNumber: '+12125550101', status: 'INITIATED' },
    ]);
    const crossResult = await reconcileTelecomOperation(crossOperation.id, { now });
    expect(crossResult.status).toBe('ambiguous');
    expect(crossResult.reconciliationState).toBe('AMBIGUOUS');
  });

  it('does not allow provider re-execution during provider-accepted recovery windows', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = makeOperation({
      id: 'accepted-crash-window',
      operationType: 'NUMBER_PURCHASE',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'PHONE_NUMBER',
      providerResourceId: 'provider-number-accepted',
      providerAcceptedAt: now,
      metadata: { providerNumberId: 'provider-number-accepted', phoneNumber: '+12125550110', country: 'US', numberType: 'LOCAL' },
    });

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);
    prisma.telecomOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.phoneNumber.findMany.mockResolvedValue([
      { id: 'phone-accepted', organizationId: 'org-a', provider: 'mock', providerNumberId: 'provider-number-accepted', phoneNumber: '+12125550110' },
    ]);

    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('resolved');
    expect(result.reconciliationState).toBe('RESOLVED');
    expect(prisma.phoneNumber.create).not.toHaveBeenCalled();
  });

  it('does not restart provider execution during a LOCALIZING crash-window recovery', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = makeOperation({
      id: 'localizing-crash-window',
      operationType: 'SMS_SEND',
      status: 'LOCALIZING',
      providerResourceType: 'TELECOM_MESSAGE',
      providerResourceId: 'provider-message-localizing',
      providerAcceptedAt: now,
      metadata: { phoneNumberId: 'phone-1', toNumber: '+12125550111', body: 'recovery', providerMessageId: 'provider-message-localizing' },
    });

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);
    prisma.telecomOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.telecomMessage.findMany.mockResolvedValue([
      { id: 'message-localizing', organizationId: 'org-a', provider: 'mock', providerMessageId: 'provider-message-localizing', phoneNumberId: 'phone-1', toNumber: '+12125550111' },
    ]);

    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('resolved');
    expect(result.reconciliationState).toBe('RESOLVED');
    expect(prisma.telecomMessage.create).not.toHaveBeenCalled();
  });

  it('allows only one concurrent reconciliation to acquire authority', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = makeOperation({
      id: 'concurrent-1',
      operationType: 'NUMBER_PURCHASE',
      status: 'PROVIDER_ACCEPTED',
      providerResourceType: 'PHONE_NUMBER',
      providerResourceId: 'provider-number-concurrent',
      providerAcceptedAt: now,
      version: 2,
      metadata: { providerNumberId: 'provider-number-concurrent', phoneNumber: '+12125550112', country: 'US', numberType: 'LOCAL' },
    });

    prisma.telecomOperation.findUnique.mockResolvedValueOnce(operation).mockResolvedValueOnce(operation);
    prisma.telecomOperation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.phoneNumber.findMany.mockResolvedValue([
      { id: 'phone-concurrent', organizationId: 'org-a', provider: 'mock', providerNumberId: 'provider-number-concurrent', phoneNumber: '+12125550112' },
    ]);

    const first = await reconcileTelecomOperation(operation.id, { now });
    const second = await reconcileTelecomOperation(operation.id, { now });

    expect(first.status).toBe('resolved');
    expect(second.status).toBe('locked');
    expect(prisma.telecomOperation.updateMany).toHaveBeenCalledTimes(3);
  });

  it('repeated reconciliation after completion is harmless and idempotent', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const operation = makeOperation({
      id: 'completed-idempotent',
      status: 'COMPLETED',
      reconciliationState: 'RESOLVED',
      completedAt: now,
    });

    prisma.telecomOperation.findUnique.mockResolvedValue(operation);

    const result = await reconcileTelecomOperation(operation.id, { now });

    expect(result.status).toBe('not_applicable');
    expect(result.reconciliationState).toBe('RESOLVED');
    expect(prisma.telecomOperation.updateMany).not.toHaveBeenCalled();
  });
});
