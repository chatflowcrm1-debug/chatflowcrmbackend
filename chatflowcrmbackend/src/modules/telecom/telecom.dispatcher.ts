import { randomUUID } from 'crypto';
import { prisma } from '../../db/prisma';

export const DEFAULT_TELECOM_OPERATION_LEASE_MS = 30_000;

type TelecomOperationRecord = Awaited<ReturnType<typeof prisma.telecomOperation.findUnique>>;

export type TelecomOperationClaimResult =
  | {
      status: 'claimed';
      operation: TelecomOperationRecord;
      leaseOwner: string;
      leaseUntil: Date;
    }
  | {
      status: 'not_claimable';
      reason: 'not_found' | 'unsupported_state' | 'future_retry' | 'active_lease' | 'expired_dispatching_lease' | 'already_claimed';
      operation: TelecomOperationRecord | null;
    };

function isRetryEligible(operation: {
  status: string;
  nextAttemptAt: Date | null;
}, now: Date) {
  if (operation.status === 'PENDING') return operation.nextAttemptAt === null || operation.nextAttemptAt <= now;
  if (operation.status === 'RETRYABLE_FAILURE') return !!operation.nextAttemptAt && operation.nextAttemptAt <= now;
  return false;
}

export async function claimTelecomOperation(
  operationId: string,
  options?: { now?: Date; leaseDurationMs?: number; leaseOwner?: string },
): Promise<TelecomOperationClaimResult> {
  const now = options?.now ?? new Date();
  const leaseDurationMs = options?.leaseDurationMs ?? DEFAULT_TELECOM_OPERATION_LEASE_MS;
  const current = await prisma.telecomOperation.findUnique({ where: { id: operationId } });

  if (!current) {
    return { status: 'not_claimable', reason: 'not_found', operation: null };
  }

  if (current.status === 'DISPATCHING') {
    return {
      status: 'not_claimable',
      reason: current.leaseUntil && current.leaseUntil > now ? 'active_lease' : 'expired_dispatching_lease',
      operation: current,
    };
  }

  if (!['PENDING', 'RETRYABLE_FAILURE'].includes(current.status)) {
    return { status: 'not_claimable', reason: 'unsupported_state', operation: current };
  }

  if (!isRetryEligible(current, now)) {
    return { status: 'not_claimable', reason: 'future_retry', operation: current };
  }

  const leaseOwner = options?.leaseOwner ?? randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseDurationMs);

  const updateResult = await prisma.telecomOperation.updateMany({
    where: {
      id: operationId,
      status: { in: ['PENDING', 'RETRYABLE_FAILURE'] },
      OR: [
        { status: 'PENDING', nextAttemptAt: null },
        { status: 'PENDING', nextAttemptAt: { lte: now } },
        { status: 'RETRYABLE_FAILURE', nextAttemptAt: { lte: now } },
      ],
    },
    data: {
      status: 'DISPATCHING',
      leaseOwner,
      leaseUntil,
      attemptCount: { increment: 1 },
      lastAttemptAt: now,
      version: { increment: 1 },
    },
  });

  if (updateResult.count !== 1) {
    const refreshed = await prisma.telecomOperation.findUnique({ where: { id: operationId } });
    return {
      status: 'not_claimable',
      reason: 'already_claimed',
      operation: refreshed,
    };
  }

  const claimed = await prisma.telecomOperation.findUnique({ where: { id: operationId } });
  if (!claimed) {
    return {
      status: 'not_claimable',
      reason: 'not_found',
      operation: null,
    };
  }

  return {
    status: 'claimed',
    operation: claimed,
    leaseOwner,
    leaseUntil,
  };
}
