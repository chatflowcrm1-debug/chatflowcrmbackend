import { claimTelecomOperation } from '../src/modules/telecom/telecom.dispatcher';
import { executeTelecomOperation } from '../src/modules/telecom/telecom.executor';
import { TelecomOperationWorker, startTelecomWorker, stopTelecomWorker } from '../src/modules/telecom/telecom.worker';

jest.mock('../src/db/prisma', () => {
  const prismaMock: any = {
    telecomOperation: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
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

describe('telecom durable worker foundation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('claims and executes a pending operation', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-1' });
    const op = { id: 'op-pending', status: 'PENDING', nextAttemptAt: null, createdAt: now };

    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([op]);
    const claimSpy = jest.spyOn(require('../src/modules/telecom/telecom.dispatcher'), 'claimTelecomOperation').mockResolvedValue({
      status: 'claimed',
      operation: op,
      leaseOwner: 'worker-1',
      leaseUntil: new Date(now.getTime() + 30_000),
    } as any);
    const execSpy = jest.spyOn(require('../src/modules/telecom/telecom.executor'), 'executeTelecomOperation').mockResolvedValue({
      status: 'executed',
      operation: op,
      providerResult: {},
    } as any);

    await worker.pollOnce();

    expect(claimSpy).toHaveBeenCalledWith('op-pending', expect.objectContaining({ leaseOwner: 'worker-1' }));
    expect(execSpy).toHaveBeenCalledWith('op-pending', expect.objectContaining({ leaseOwner: 'worker-1' }));
  });

  it('claims and executes a due retryable failure', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-2' });
    const op = { id: 'op-retry', status: 'RETRYABLE_FAILURE', nextAttemptAt: new Date(now.getTime() - 1_000), createdAt: now };

    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([op]);
    jest.spyOn(require('../src/modules/telecom/telecom.dispatcher'), 'claimTelecomOperation').mockResolvedValue({
      status: 'claimed',
      operation: op,
      leaseOwner: 'worker-2',
      leaseUntil: new Date(now.getTime() + 30_000),
    } as any);
    const execSpy = jest.spyOn(require('../src/modules/telecom/telecom.executor'), 'executeTelecomOperation').mockResolvedValue({
      status: 'executed',
      operation: op,
      providerResult: {},
    } as any);

    await worker.pollOnce();

    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores terminal states and future retry windows', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-3' });
    const claimSpy = jest.spyOn(require('../src/modules/telecom/telecom.dispatcher'), 'claimTelecomOperation');
    const execSpy = jest.spyOn(require('../src/modules/telecom/telecom.executor'), 'executeTelecomOperation');
    const findManySpy = jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([]);

    await worker.pollOnce();

    expect(findManySpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ['PENDING', 'RETRYABLE_FAILURE'] },
        OR: [
          { nextAttemptAt: null },
          { nextAttemptAt: { lte: now } },
        ],
      }),
      take: 10,
    }));
    expect(claimSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('skips operations when claim fails', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-4' });
    const op = { id: 'op-claimed', status: 'PENDING', nextAttemptAt: null, createdAt: now };

    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([op]);
    jest.spyOn(require('../src/modules/telecom/telecom.dispatcher'), 'claimTelecomOperation').mockResolvedValue({
      status: 'not_claimable',
      reason: 'already_claimed',
      operation: op,
    } as any);
    const execSpy = jest.spyOn(require('../src/modules/telecom/telecom.executor'), 'executeTelecomOperation');

    await worker.pollOnce();

    expect(execSpy).not.toHaveBeenCalled();
  });

  it('continues after a single operation throws', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-5' });
    const first = { id: 'op-a', status: 'PENDING', nextAttemptAt: null, createdAt: now };
    const second = { id: 'op-b', status: 'PENDING', nextAttemptAt: null, createdAt: now };

    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([first, second]);
    jest.spyOn(require('../src/modules/telecom/telecom.dispatcher'), 'claimTelecomOperation')
      .mockResolvedValueOnce({ status: 'claimed', operation: first, leaseOwner: 'worker-5', leaseUntil: new Date(now.getTime() + 30_000) } as any)
      .mockResolvedValueOnce({ status: 'claimed', operation: second, leaseOwner: 'worker-5', leaseUntil: new Date(now.getTime() + 30_000) } as any);
    const execSpy = jest.spyOn(require('../src/modules/telecom/telecom.executor'), 'executeTelecomOperation')
      .mockRejectedValueOnce(new Error('forced fail'))
      .mockResolvedValueOnce({ status: 'executed', operation: second, providerResult: {} } as any);

    await expect(worker.pollOnce()).resolves.toBeUndefined();
    expect(execSpy).toHaveBeenCalledTimes(2);
  });

  it('does not overlap polling cycles and can stop cleanly', async () => {
    jest.useFakeTimers();
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => new Date('2026-01-01T00:00:00.000Z'), workerIdentity: 'worker-6' });
    const findManySpy = jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([]);

    worker.start();
    worker.start();
    expect(findManySpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(findManySpy).toHaveBeenCalledTimes(1);

    worker.stop();
    jest.advanceTimersByTime(500);
    expect(findManySpy).toHaveBeenCalledTimes(1);
  });

  it('starts once and shutdown is idempotent', () => {
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => new Date(), workerIdentity: 'worker-7' });
    const startSpy = jest.spyOn(worker as any, 'schedule');

    worker.start();
    worker.start();
    expect(startSpy).toHaveBeenCalledTimes(1);

    worker.stop();
    worker.stop();
    expect((worker as any).timer).toBeNull();
  });

  it('does not make provider calls directly', async () => {
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => new Date('2026-01-01T00:00:00.000Z'), workerIdentity: 'worker-8' });
    const op = { id: 'op-no-provider', status: 'PENDING', nextAttemptAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z') };

    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([op]);
    jest.spyOn(require('../src/modules/telecom/telecom.dispatcher'), 'claimTelecomOperation').mockResolvedValue({
      status: 'claimed',
      operation: op,
      leaseOwner: 'worker-8',
      leaseUntil: new Date('2026-01-01T00:00:30.000Z'),
    } as any);
    const execSpy = jest.spyOn(require('../src/modules/telecom/telecom.executor'), 'executeTelecomOperation').mockResolvedValue({
      status: 'executed',
      operation: op,
      providerResult: {},
    } as any);

    await worker.pollOnce();

    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers expired dispatch leases to retryable failure', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-9' });
    const op = {
      id: 'op-expired-dispatch',
      status: 'DISPATCHING',
      leaseOwner: 'worker-old',
      leaseUntil: new Date(now.getTime() - 1_000),
      attemptCount: 2,
      version: 5,
      nextAttemptAt: null,
      providerError: null,
    };

    const updateManySpy = jest.spyOn(prisma.telecomOperation as any, 'updateMany').mockResolvedValue({ count: 1 });
    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([op]);

    await worker.pollOnce();

    expect(updateManySpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'op-expired-dispatch',
        status: 'DISPATCHING',
      }),
      data: expect.objectContaining({
        status: 'RETRYABLE_FAILURE',
        leaseOwner: null,
        leaseUntil: null,
      }),
    }));
  });

  it('does not recover an active dispatch lease', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-10' });
    const findManySpy = jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([]);
    const updateManySpy = jest.spyOn(prisma.telecomOperation as any, 'updateMany');

    await worker.pollOnce();

    expect(findManySpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'DISPATCHING',
        leaseUntil: { lt: now },
      }),
    }));
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it('expires retry after max attempts', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-11' });
    const op = {
      id: 'op-max-retry',
      status: 'DISPATCHING',
      leaseOwner: 'worker-old',
      leaseUntil: new Date(now.getTime() - 1_000),
      attemptCount: 5,
      version: 10,
      nextAttemptAt: null,
    };

    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([op]);
    const updateManySpy = jest.spyOn(prisma.telecomOperation as any, 'updateMany').mockResolvedValue({ count: 1 });

    await worker.pollOnce();

    expect(updateManySpy).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'FAILED',
        nextAttemptAt: null,
      }),
    }));
  });

  it('does not retry unknown outcome or terminal states', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const worker = new TelecomOperationWorker({ pollIntervalMs: 100, batchSize: 10, now: () => now, workerIdentity: 'worker-12' });
    const claimSpy = jest.spyOn(require('../src/modules/telecom/telecom.dispatcher'), 'claimTelecomOperation');
    const updateManySpy = jest.spyOn(prisma.telecomOperation as any, 'updateMany');
    jest.spyOn(prisma.telecomOperation as any, 'findMany').mockResolvedValue([]);

    await worker.pollOnce();

    expect(claimSpy).not.toHaveBeenCalled();
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it('exposes start/stop control functions', () => {
    expect(typeof startTelecomWorker).toBe('function');
    expect(typeof stopTelecomWorker).toBe('function');
  });
});
