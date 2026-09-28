import { randomUUID } from 'crypto';
import { prisma } from '../../db/prisma';
import { logger } from '../../utils/logger';
import { claimTelecomOperation } from './telecom.dispatcher';
import { executeTelecomOperation } from './telecom.executor';
import { reconcileTelecomOperation } from './telecom.reconciliation';

const MAX_TELECOM_RETRY_ATTEMPTS = 5;
const TELECOM_RETRY_BASE_MS = 60_000;

export function getTelecomRetryDelayMs(attemptCount: number) {
  const safeAttempt = Math.max(1, Number.isFinite(attemptCount) ? attemptCount : 1);
  return Math.min(TELECOM_RETRY_BASE_MS * 2 ** (safeAttempt - 1), 30 * 60_000);
}

export type TelecomWorkerOptions = {
  pollIntervalMs?: number;
  batchSize?: number;
  workerIdentity?: string;
  now?: () => Date;
};

export class TelecomOperationWorker {
  private timer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly workerIdentity: string;
  private readonly now: () => Date;

  constructor(options: TelecomWorkerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 10;
    this.workerIdentity = options.workerIdentity ?? `telecom-worker-${process.pid}-${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
  }

  start() {
    if (this.timer) return;
    this.schedule();
  }

  private schedule() {
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async recoverExpiredDispatchingOperations(currentTime: Date) {
    const expiredOperations = await prisma.telecomOperation.findMany({
      where: {
        status: 'DISPATCHING',
        leaseUntil: { lt: currentTime },
      },
      orderBy: { updatedAt: 'asc' },
      take: this.batchSize,
    });

    for (const operation of expiredOperations) {
      try {
        const previousAttempts = Number(operation.attemptCount ?? 0);
        const shouldFail = previousAttempts >= MAX_TELECOM_RETRY_ATTEMPTS;
        const nextAttemptAt = shouldFail ? null : new Date(currentTime.getTime() + getTelecomRetryDelayMs(previousAttempts || 1));

        const updateResult = await prisma.telecomOperation.updateMany({
          where: {
            id: operation.id,
            status: 'DISPATCHING',
            leaseUntil: { lt: currentTime },
          },
          data: {
            status: shouldFail ? 'FAILED' : 'RETRYABLE_FAILURE',
            reasonCode: shouldFail ? 'RETRY_LIMIT_EXCEEDED' : 'EXPIRED_DISPATCHING_LEASE',
            failureClass: shouldFail ? 'PERMANENT' : 'RETRYABLE',
            providerError: shouldFail ? 'Dispatch lease expired after max retries' : 'Dispatch lease expired; operation requeued for retry',
            nextAttemptAt,
            lastAttemptAt: currentTime,
            leaseOwner: null,
            leaseUntil: null,
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          continue;
        }
      } catch (error) {
        logger.warn('Telecom worker lease recovery failed', {
          operationId: operation.id,
          workerId: this.workerIdentity,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async pollOnce() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const currentTime = this.now();
      await this.recoverExpiredDispatchingOperations(currentTime);

      const reconcilingOperations = await prisma.telecomOperation.findMany({
        where: {
          status: { in: ['UNKNOWN_OUTCOME', 'PROVIDER_ACCEPTED', 'LOCALIZING'] },
        },
        orderBy: { updatedAt: 'asc' },
        take: this.batchSize,
      });

      for (const operation of reconcilingOperations) {
        try {
          await reconcileTelecomOperation(operation.id, {
            now: currentTime,
            leaseOwner: this.workerIdentity,
          });
        } catch (error) {
          logger.error('Telecom worker reconciliation failed', {
            operationId: operation.id,
            workerId: this.workerIdentity,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const operations = await prisma.telecomOperation.findMany({
        where: {
          status: { in: ['PENDING', 'RETRYABLE_FAILURE'] },
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: currentTime } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: this.batchSize,
      });

      for (const operation of operations) {
        try {
          const claimResult = await claimTelecomOperation(operation.id, {
            now: currentTime,
            leaseOwner: this.workerIdentity,
          });

          if (claimResult.status !== 'claimed') {
            continue;
          }

          await executeTelecomOperation(operation.id, {
            now: currentTime,
            leaseOwner: claimResult.leaseOwner,
          });
        } catch (error) {
          logger.error('Telecom worker operation failed', {
            operationId: operation.id,
            workerId: this.workerIdentity,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.error('Telecom worker cycle failed', {
        workerId: this.workerIdentity,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.isPolling = false;
    }
  }
}

let telecomWorker: TelecomOperationWorker | null = null;

export function startTelecomWorker(options: TelecomWorkerOptions = {}) {
  if (!telecomWorker) {
    telecomWorker = new TelecomOperationWorker(options);
    telecomWorker.start();
  }
  return telecomWorker;
}

export function stopTelecomWorker() {
  if (telecomWorker) {
    telecomWorker.stop();
    telecomWorker = null;
  }
}
