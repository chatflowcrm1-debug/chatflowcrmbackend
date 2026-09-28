import { claimTelecomOperation } from '../src/modules/telecom/telecom.dispatcher';
import { MockTelecomProvider } from '../src/modules/telecom/providers/MockTelecomProvider';
import { TelnyxTelecomProvider } from '../src/modules/telecom/providers/TelnyxTelecomProvider';

jest.mock('../src/db/prisma', () => {
  const prismaMock: any = {
    telecomOperation: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    customer: { findUnique: jest.fn() },
    phoneNumber: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    telecomMessage: { create: jest.fn() },
    telecomCall: { create: jest.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = jest.requireMock('../src/db/prisma') as { prisma: any };

type StoredOperation = {
  id: string;
  organizationId: string;
  userId: string;
  customerId: string | null;
  phoneNumberId: string | null;
  telecomCallId: string | null;
  telecomMessageId: string | null;
  operationType: string;
  provider: string;
  status: string;
  idempotencyKeyHash: string;
  requestHash: string;
  providerResourceType: string | null;
  providerResourceId: string | null;
  providerError: string | null;
  providerResponseRef: string | null;
  providerAcceptedAt: Date | null;
  providerResolvedAt: Date | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  version: number;
  failureClass: string | null;
  reasonCode: string | null;
  reconciliationState: string | null;
  reconciledAt: Date | null;
  reconciliationError: string | null;
  compensationState: string | null;
  compensationStartedAt: Date | null;
  compensationCompletedAt: Date | null;
  compensationError: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
};

const now = new Date('2026-01-01T00:00:00.000Z');
let ledger: Record<string, StoredOperation>;
let providerSpies: jest.SpyInstance[];

function makeOperation(overrides: Partial<StoredOperation> = {}): StoredOperation {
  const base: StoredOperation = {
    id: 'operation-1',
    organizationId: 'org-a',
    userId: 'user-a',
    customerId: null,
    phoneNumberId: null,
    telecomCallId: null,
    telecomMessageId: null,
    operationType: 'SMS_SEND',
    provider: 'mock',
    status: 'PENDING',
    idempotencyKeyHash: 'hash-1',
    requestHash: 'request-hash-1',
    providerResourceType: null,
    providerResourceId: null,
    providerError: null,
    providerResponseRef: null,
    providerAcceptedAt: null,
    providerResolvedAt: null,
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseUntil: null,
    version: 0,
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
  };

  return { ...base, ...overrides };
}

describe('telecom dispatcher lease foundation', () => {
  beforeEach(() => {
    ledger = {};

    jest.spyOn(prisma.telecomOperation as any, 'findUnique').mockImplementation(async ({ where }: any) => {
      return ledger[where.id] ?? null;
    });

    jest.spyOn(prisma.telecomOperation as any, 'updateMany').mockImplementation(async ({ where, data }: any) => {
      const operation = ledger[where.id];
      if (!operation) return { count: 0 };

      const eligible =
        operation.status === 'PENDING'
          ? operation.nextAttemptAt === null || operation.nextAttemptAt <= now
          : operation.status === 'RETRYABLE_FAILURE'
            ? operation.nextAttemptAt !== null && operation.nextAttemptAt <= now
            : false;

      if (!eligible || !where.status?.in?.includes(operation.status)) {
        return { count: 0 };
      }

      operation.status = 'DISPATCHING';
      operation.leaseOwner = data.leaseOwner ?? operation.leaseOwner;
      operation.leaseUntil = data.leaseUntil ?? operation.leaseUntil;
      operation.lastAttemptAt = data.lastAttemptAt ?? operation.lastAttemptAt;
      operation.attemptCount += 1;
      operation.version += 1;

      return { count: 1 };
    });

    providerSpies = [
      jest.spyOn(MockTelecomProvider.prototype, 'purchaseNumber').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(MockTelecomProvider.prototype, 'sendSMS').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(MockTelecomProvider.prototype, 'makeCall').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'purchaseNumber').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'sendSMS').mockRejectedValue(new Error('Provider action must not run')),
      jest.spyOn(TelnyxTelecomProvider.prototype, 'makeCall').mockRejectedValue(new Error('Provider action must not run')),
    ];
  });

  afterEach(() => {
    expect(providerSpies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    jest.restoreAllMocks();
  });

  it('claims a pending operation with a lease and increments attempt/version/timestamps', async () => {
    const operation = makeOperation({ id: 'op-pending', status: 'PENDING', nextAttemptAt: null, attemptCount: 0, version: 0 });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, { now });

    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') throw new Error('Expected claimed result');
    expect(result.operation).toBeTruthy();
    if (!result.operation) throw new Error('expected operation');
    expect(result.operation.status).toBe('DISPATCHING');
    expect(result.operation.leaseOwner).toBeTruthy();
    expect(result.operation.leaseUntil).toBeInstanceOf(Date);
    expect(result.operation.leaseUntil!.getTime()).toBeGreaterThan(now.getTime());
    expect(result.operation.attemptCount).toBe(1);
    expect(result.operation.version).toBe(1);
    expect(result.operation.lastAttemptAt).toEqual(now);
  });

  it('does not claim a pending operation until its next attempt time', async () => {
    const operation = makeOperation({ id: 'op-pending-future', status: 'PENDING', nextAttemptAt: new Date(now.getTime() + 60_000), attemptCount: 1, version: 1 });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, { now });

    expect(result.status).toBe('not_claimable');
    if (result.status !== 'not_claimable') throw new Error('Expected not_claimable result');
    expect(result.reason).toBe('future_retry');
    expect(operation.status).toBe('PENDING');
    expect(operation.attemptCount).toBe(1);
    expect(operation.version).toBe(1);
  });

  it('claims a retryable failure that is ready for retry', async () => {
    const operation = makeOperation({ id: 'op-retry-ready', status: 'RETRYABLE_FAILURE', nextAttemptAt: new Date(now.getTime() - 1_000), attemptCount: 2, version: 2 });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, { now });

    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') throw new Error('Expected claimed result');
    expect(result.operation).toBeTruthy();
    if (!result.operation) throw new Error('expected operation');
    expect(result.operation.status).toBe('DISPATCHING');
    expect(result.operation.attemptCount).toBe(3);
    expect(result.operation.version).toBe(3);
    expect(result.operation.lastAttemptAt).toEqual(now);
  });

  it('does not claim a retryable failure scheduled in the future', async () => {
    const operation = makeOperation({ id: 'op-retry-future', status: 'RETRYABLE_FAILURE', nextAttemptAt: new Date(now.getTime() + 60_000), attemptCount: 2, version: 2 });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, { now });

    expect(result.status).toBe('not_claimable');
    if (result.status !== 'not_claimable') throw new Error('Expected not_claimable result');
    expect(result.reason).toBe('future_retry');
    expect(operation.status).toBe('RETRYABLE_FAILURE');
    expect(operation.attemptCount).toBe(2);
    expect(operation.version).toBe(2);
  });

  it('protects an active dispatching lease from theft', async () => {
    const operation = makeOperation({
      id: 'op-active-lease',
      status: 'DISPATCHING',
      leaseOwner: 'worker-1',
      leaseUntil: new Date(now.getTime() + 10_000),
      attemptCount: 4,
      version: 4,
    });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, { now });

    expect(result.status).toBe('not_claimable');
    if (result.status !== 'not_claimable') throw new Error('Expected not_claimable result');
    expect(result.reason).toBe('active_lease');
    expect(operation.leaseOwner).toBe('worker-1');
    expect(operation.leaseUntil!.getTime()).toBeGreaterThan(now.getTime());
    expect(operation.attemptCount).toBe(4);
    expect(operation.version).toBe(4);
  });

  it('does not reclaim an expired dispatching lease in this phase', async () => {
    const operation = makeOperation({
      id: 'op-expired-dispatching',
      status: 'DISPATCHING',
      leaseOwner: 'worker-2',
      leaseUntil: new Date(now.getTime() - 1_000),
      attemptCount: 9,
      version: 9,
    });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, { now });

    expect(result.status).toBe('not_claimable');
    if (result.status !== 'not_claimable') throw new Error('Expected not_claimable result');
    expect(result.reason).toBe('expired_dispatching_lease');
    expect(operation.status).toBe('DISPATCHING');
    expect(operation.leaseOwner).toBe('worker-2');
    expect(operation.attemptCount).toBe(9);
    expect(operation.version).toBe(9);
  });

  it('protects terminal states from dispatching', async () => {
    const completed = makeOperation({ id: 'op-completed', status: 'COMPLETED', attemptCount: 5, version: 5 });
    const failed = makeOperation({ id: 'op-failed', status: 'FAILED', attemptCount: 6, version: 6 });
    ledger[completed.id] = completed;
    ledger[failed.id] = failed;

    const completedResult = await claimTelecomOperation(completed.id, { now });
    const failedResult = await claimTelecomOperation(failed.id, { now });

    expect(completedResult.status).toBe('not_claimable');
    if (completedResult.status !== 'not_claimable') throw new Error('Expected not_claimable result');
    expect(completedResult.reason).toBe('unsupported_state');
    expect(failedResult.status).toBe('not_claimable');
    if (failedResult.status !== 'not_claimable') throw new Error('Expected not_claimable result');
    expect(failedResult.reason).toBe('unsupported_state');
  });

  it('allows only one winner on concurrent claims for the same operation', async () => {
    const operation = makeOperation({ id: 'op-concurrent', status: 'PENDING', nextAttemptAt: null, attemptCount: 0, version: 0 });
    ledger[operation.id] = operation;

    const first = await claimTelecomOperation(operation.id, { now });
    const second = await claimTelecomOperation(operation.id, { now });

    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') throw new Error('Expected claimed result');
    expect(second.status).toBe('not_claimable');
    if (second.status !== 'not_claimable') throw new Error('Expected not_claimable result');
    expect(first.operation).toBeTruthy();
    if (!first.operation) throw new Error('expected operation');
    expect(first.operation.attemptCount).toBe(1);
    expect(first.operation.version).toBe(1);
    expect(operation.status).toBe('DISPATCHING');
    expect(operation.attemptCount).toBe(1);
    expect(operation.version).toBe(1);
  });

  it('does not modify non-lease fields while claiming an operation', async () => {
    const operation = makeOperation({
      id: 'op-data-integrity',
      organizationId: 'org-z',
      userId: 'user-z',
      customerId: 'customer-z',
      phoneNumberId: 'phone-z',
      telecomCallId: null,
      telecomMessageId: null,
      operationType: 'VOICE_CALL',
      provider: 'mock',
      idempotencyKeyHash: 'key-hash',
      requestHash: 'request-hash',
      status: 'PENDING',
      nextAttemptAt: null,
    });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, { now });

    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') throw new Error('Expected claimed result');
    expect(result.operation).toBeTruthy();
    if (!result.operation) throw new Error('expected operation');
    expect(result.operation.organizationId).toBe('org-z');
    expect(result.operation.userId).toBe('user-z');
    expect(result.operation.customerId).toBe('customer-z');
    expect(result.operation.phoneNumberId).toBe('phone-z');
    expect(result.operation.operationType).toBe('VOICE_CALL');
    expect(result.operation.idempotencyKeyHash).toBe('key-hash');
    expect(result.operation.requestHash).toBe('request-hash');
    expect(result.operation.status).toBe('DISPATCHING');
  });

  it('uses the configured dispatcher lease duration', async () => {
    const operation = makeOperation({ id: 'op-lease-duration', status: 'PENDING', nextAttemptAt: null });
    ledger[operation.id] = operation;

    const result = await claimTelecomOperation(operation.id, {
      now,
      leaseDurationMs: 12_345,
    });

    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') throw new Error('Expected claimed result');
    expect(result.leaseUntil.getTime() - now.getTime()).toBe(12_345);
    expect(result.operation).toBeTruthy();
    if (!result.operation) throw new Error('expected operation');
    expect(result.leaseUntil.getTime() - result.operation.lastAttemptAt!.getTime()).toBeLessThanOrEqual(12_345);
  });

  it('keeps the provider boundary closed during dispatcher operations', async () => {
    const operation = makeOperation({ id: 'op-provider-boundary', status: 'PENDING', nextAttemptAt: null });
    ledger[operation.id] = operation;

    await claimTelecomOperation(operation.id, { now });

    expect(MockTelecomProvider.prototype.purchaseNumber).not.toHaveBeenCalled();
    expect(MockTelecomProvider.prototype.sendSMS).not.toHaveBeenCalled();
    expect(MockTelecomProvider.prototype.makeCall).not.toHaveBeenCalled();
    expect(TelnyxTelecomProvider.prototype.purchaseNumber).not.toHaveBeenCalled();
    expect(TelnyxTelecomProvider.prototype.sendSMS).not.toHaveBeenCalled();
    expect(TelnyxTelecomProvider.prototype.makeCall).not.toHaveBeenCalled();
  });
});
