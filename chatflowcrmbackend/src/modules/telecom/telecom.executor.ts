import { prisma } from '../../db/prisma';
import { MockTelecomProvider } from './providers/MockTelecomProvider';
import { TelecomProvider } from './telecom.types';

const MAX_TELECOM_RETRY_ATTEMPTS = 5;
const TELECOM_RETRY_BASE_MS = 60_000;

function getTelecomRetryDelayMs(attemptCount: number) {
  const safeAttempt = Math.max(1, Number.isFinite(attemptCount) ? attemptCount : 1);
  return Math.min(TELECOM_RETRY_BASE_MS * 2 ** (safeAttempt - 1), 30 * 60_000);
}

type TelecomOperationRecord = Awaited<ReturnType<typeof prisma.telecomOperation.findUnique>>;

type ExecutorOptions = {
  provider?: TelecomProvider;
  leaseOwner?: string;
  now?: Date;
};

export type TelecomExecutionResult =
  | {
      status: 'executed';
      operation: TelecomOperationRecord;
      providerResult: { providerResourceType?: string | null; providerResourceId?: string | null };
    }
  | {
      status: 'not_executable';
      reason: 'not_found' | 'not_dispatching' | 'wrong_lease_owner' | 'expired_lease' | 'already_final' | 'local_validation_failed';
      operation: TelecomOperationRecord | null;
    };

function isRetryableError(message: string) {
  return /timeout|timed out|rate limit|429|5\d\d|temporar|unavailable|network|ECONNRESET|EAI_AGAIN|fetch failed/i.test(message);
}

function isPermanentFailure(message: string) {
  return /invalid|unsupported|unauthorized|forbidden|not available|not found|bad request|400|401|403|404|unknown number|invalid number/i.test(message);
}

function extractMetadata(operation: TelecomOperationRecord) {
  if (!operation || !operation.metadata) return {} as Record<string, unknown>;
  return typeof operation.metadata === 'object' && operation.metadata !== null ? (operation.metadata as Record<string, unknown>) : {};
}

function toString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

async function persistOperationUpdate(operationId: string, data: Record<string, unknown>) {
  return prisma.telecomOperation.update({
    where: { id: operationId },
    data,
  });
}

async function ensurePhoneNumberForOperation(operation: NonNullable<TelecomOperationRecord>, metadata: Record<string, unknown>) {
  const phoneNumberId = toString(metadata.phoneNumberId ?? operation.phoneNumberId);
  if (!phoneNumberId) return null;

  const phoneNumber = await prisma.phoneNumber.findUnique({ where: { id: phoneNumberId } });
  if (!phoneNumber) return null;
  if (phoneNumber.organizationId !== operation.organizationId) return null;
  return phoneNumber;
}

async function ensureCustomerForOperation(operation: NonNullable<TelecomOperationRecord>) {
  if (!operation.customerId) return true;

  const customer = await prisma.customer.findUnique({ where: { id: operation.customerId } });
  if (!customer) return false;
  return customer.organizationId === operation.organizationId;
}

export async function executeTelecomOperation(
  operationId: string,
  options?: ExecutorOptions,
): Promise<TelecomExecutionResult> {
  const provider = options?.provider ?? new MockTelecomProvider();
  const now = options?.now ?? new Date();
  const operation = await prisma.telecomOperation.findUnique({ where: { id: operationId } });

  if (!operation) {
    return { status: 'not_executable', reason: 'not_found', operation: null };
  }

  if (['COMPLETED', 'FAILED', 'UNKNOWN_OUTCOME', 'PROVIDER_ACCEPTED', 'LOCALIZING'].includes(operation.status)) {
    return { status: 'not_executable', reason: 'already_final', operation };
  }

  if (operation.status !== 'DISPATCHING') {
    return { status: 'not_executable', reason: 'not_dispatching', operation };
  }

  if (operation.leaseOwner && (!options?.leaseOwner || operation.leaseOwner !== options.leaseOwner)) {
    return { status: 'not_executable', reason: 'wrong_lease_owner', operation };
  }

  if (!operation.leaseOwner || !operation.leaseUntil || operation.leaseUntil <= now) {
    return { status: 'not_executable', reason: 'expired_lease', operation };
  }

  const metadata = extractMetadata(operation);

  if (operation.customerId) {
    const customerIsValid = await ensureCustomerForOperation(operation);
    if (!customerIsValid) {
      await persistOperationUpdate(operation.id, {
        status: 'FAILED',
        providerError: 'Customer does not exist or belongs to another organization',
        failureClass: 'PERMANENT',
        reasonCode: 'CUSTOMER_ORGANIZATION_MISMATCH',
        lastAttemptAt: now,
        version: { increment: 1 },
        leaseOwner: null,
        leaseUntil: null,
      });
      return { status: 'not_executable', reason: 'local_validation_failed', operation: { ...operation, status: 'FAILED' } };
    }
  }

  try {
    if (operation.operationType === 'NUMBER_PURCHASE') {
      const providerNumberId = toString(metadata.providerNumberId);
      if (!providerNumberId) {
        await persistOperationUpdate(operation.id, {
          status: 'FAILED',
          providerError: 'Missing providerNumberId in operation metadata',
          failureClass: 'PERMANENT',
          reasonCode: 'LOCAL_VALIDATION_FAILED',
          lastAttemptAt: now,
          version: { increment: 1 },
          leaseOwner: null,
          leaseUntil: null,
        });
        return { status: 'not_executable', reason: 'local_validation_failed', operation: { ...operation, status: 'FAILED' } };
      }

      await persistOperationUpdate(operation.id, { status: 'PROVIDER_ACCEPTED', lastAttemptAt: now, version: { increment: 1 } });
      const purchased = await provider.purchaseNumber(providerNumberId);
      const existingPhoneNumber = await prisma.phoneNumber.findFirst({
        where: {
          provider: operation.provider,
          providerNumberId: purchased.providerNumberId,
        },
      });

      const createdPhoneNumber = existingPhoneNumber ?? await prisma.phoneNumber.create({
        data: {
          organizationId: operation.organizationId,
          provider: operation.provider,
          providerNumberId: purchased.providerNumberId,
          phoneNumber: purchased.phoneNumber,
          country: purchased.country,
          numberType: purchased.numberType,
          areaCode: purchased.areaCode ?? null,
          capabilities: purchased.capabilities,
          status: 'ACTIVE',
        },
      });

      if (existingPhoneNumber && existingPhoneNumber.organizationId !== operation.organizationId) {
        await persistOperationUpdate(operation.id, {
          status: 'FAILED',
          providerError: 'Phone number provider identity belongs to another organization',
          failureClass: 'PERMANENT',
          reasonCode: 'PHONE_NUMBER_ORGANIZATION_MISMATCH',
          lastAttemptAt: now,
          version: { increment: 1 },
          leaseOwner: null,
          leaseUntil: null,
        });
        return { status: 'not_executable', reason: 'local_validation_failed', operation: { ...operation, status: 'FAILED' } };
      }

      await persistOperationUpdate(operation.id, {
        status: 'LOCALIZING',
        phoneNumberId: createdPhoneNumber.id,
        providerResourceType: 'PHONE_NUMBER',
        providerResourceId: purchased.providerNumberId,
        providerAcceptedAt: now,
        providerResolvedAt: now,
        leaseOwner: null,
        leaseUntil: null,
        version: { increment: 1 },
      });

      const finalized = await persistOperationUpdate(operation.id, {
        status: 'COMPLETED',
        completedAt: now,
        lastAttemptAt: now,
        providerError: null,
        version: { increment: 1 },
        leaseOwner: null,
        leaseUntil: null,
      });

      return { status: 'executed', operation: finalized, providerResult: { providerResourceType: 'PHONE_NUMBER', providerResourceId: purchased.providerNumberId } };
    }

    if (operation.operationType === 'SMS_SEND') {
      const payload = metadata as Record<string, unknown>;
      const phoneNumber = await ensurePhoneNumberForOperation(operation, payload);
      if (!phoneNumber) {
        await persistOperationUpdate(operation.id, {
          status: 'FAILED',
          failureClass: 'PERMANENT',
          reasonCode: 'LOCAL_VALIDATION_FAILED',
          providerError: 'Phone number missing or belongs to another organization',
          lastAttemptAt: now,
          version: { increment: 1 },
          leaseOwner: null,
          leaseUntil: null,
        });
        return { status: 'not_executable', reason: 'local_validation_failed', operation: { ...operation, status: 'FAILED' } };
      }

      await persistOperationUpdate(operation.id, { status: 'PROVIDER_ACCEPTED', lastAttemptAt: now, version: { increment: 1 } });
      const result = await provider.sendSMS({
        fromNumber: phoneNumber.phoneNumber,
        toNumber: toString(payload.toNumber) || '',
        body: toString(payload.body) || '',
      });
      const createdMessage = await prisma.telecomMessage.create({
        data: {
          organizationId: operation.organizationId,
          userId: operation.userId,
          customerId: operation.customerId ?? null,
          phoneNumberId: phoneNumber.id,
          provider: operation.provider,
          providerMessageId: result.providerMessageId,
          direction: 'OUTBOUND',
          fromNumber: phoneNumber.phoneNumber,
          toNumber: toString(payload.toNumber) || '',
          body: toString(payload.body) || '',
          status: result.status || 'QUEUED',
        },
      });

      await persistOperationUpdate(operation.id, {
        status: 'LOCALIZING',
        telecomMessageId: createdMessage.id,
        providerResourceType: 'TELECOM_MESSAGE',
        providerResourceId: result.providerMessageId,
        providerAcceptedAt: now,
        providerResolvedAt: now,
        leaseOwner: null,
        leaseUntil: null,
        version: { increment: 1 },
      });

      const finalized = await persistOperationUpdate(operation.id, {
        status: 'COMPLETED',
        completedAt: now,
        lastAttemptAt: now,
        providerError: null,
        version: { increment: 1 },
        leaseOwner: null,
        leaseUntil: null,
      });

      return { status: 'executed', operation: finalized, providerResult: { providerResourceType: 'TELECOM_MESSAGE', providerResourceId: result.providerMessageId } };
    }

    if (operation.operationType === 'VOICE_CALL') {
      const payload = metadata as Record<string, unknown>;
      const phoneNumber = await ensurePhoneNumberForOperation(operation, payload);
      if (!phoneNumber) {
        await persistOperationUpdate(operation.id, {
          status: 'FAILED',
          failureClass: 'PERMANENT',
          reasonCode: 'LOCAL_VALIDATION_FAILED',
          providerError: 'Phone number missing or belongs to another organization',
          lastAttemptAt: now,
          version: { increment: 1 },
          leaseOwner: null,
          leaseUntil: null,
        });
        return { status: 'not_executable', reason: 'local_validation_failed', operation: { ...operation, status: 'FAILED' } };
      }

      await persistOperationUpdate(operation.id, { status: 'PROVIDER_ACCEPTED', lastAttemptAt: now, version: { increment: 1 } });
      const result = await provider.makeCall({
        fromNumber: phoneNumber.phoneNumber,
        toNumber: toString(payload.toNumber) || '',
        recordingEnabled: Boolean(payload.recordingEnabled),
      });
      const createdCall = await prisma.telecomCall.create({
        data: {
          organizationId: operation.organizationId,
          userId: operation.userId,
          customerId: operation.customerId ?? null,
          phoneNumberId: phoneNumber.id,
          provider: operation.provider,
          providerCallId: result.providerCallId,
          direction: 'OUTBOUND',
          status: result.status || 'INITIATED',
          fromNumber: phoneNumber.phoneNumber,
          toNumber: toString(payload.toNumber) || '',
          recordingEnabled: Boolean(payload.recordingEnabled),
          startedAt: now,
        },
      });

      await persistOperationUpdate(operation.id, {
        status: 'LOCALIZING',
        telecomCallId: createdCall.id,
        providerResourceType: 'TELECOM_CALL',
        providerResourceId: result.providerCallId,
        providerAcceptedAt: now,
        providerResolvedAt: now,
        leaseOwner: null,
        leaseUntil: null,
        version: { increment: 1 },
      });

      const finalized = await persistOperationUpdate(operation.id, {
        status: 'COMPLETED',
        completedAt: now,
        lastAttemptAt: now,
        providerError: null,
        version: { increment: 1 },
        leaseOwner: null,
        leaseUntil: null,
      });

      return { status: 'executed', operation: finalized, providerResult: { providerResourceType: 'TELECOM_CALL', providerResourceId: result.providerCallId } };
    }

    await persistOperationUpdate(operation.id, {
      status: 'FAILED',
      failureClass: 'PERMANENT',
      reasonCode: 'UNSUPPORTED_OPERATION',
      providerError: `Unsupported operationType: ${operation.operationType}`,
      lastAttemptAt: now,
      version: { increment: 1 },
      leaseOwner: null,
      leaseUntil: null,
    });
    return { status: 'not_executable', reason: 'local_validation_failed', operation: { ...operation, status: 'FAILED' } };
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown provider failure');
    const retryable = isRetryableError(message);
    const permanent = isPermanentFailure(message);
    const attemptCount = Number(operation.attemptCount ?? 0);
    const shouldRetry = retryable && attemptCount < MAX_TELECOM_RETRY_ATTEMPTS;
    const nextAttemptAt = shouldRetry ? new Date(now.getTime() + getTelecomRetryDelayMs(attemptCount || 1)) : null;

    const failureStatus = shouldRetry ? 'RETRYABLE_FAILURE' : permanent ? 'FAILED' : retryable ? 'FAILED' : 'UNKNOWN_OUTCOME';

    const updated = await persistOperationUpdate(operation.id, {
      status: failureStatus,
      providerError: message,
      failureClass: shouldRetry ? 'RETRYABLE' : permanent ? 'PERMANENT' : retryable ? 'PERMANENT' : 'UNKNOWN',
      reasonCode: shouldRetry ? 'PROVIDER_RETRYABLE' : permanent ? 'PROVIDER_REJECTED' : retryable ? 'RETRY_LIMIT_EXCEEDED' : 'UNKNOWN_OUTCOME',
      nextAttemptAt,
      lastAttemptAt: now,
      version: { increment: 1 },
      leaseOwner: null,
      leaseUntil: null,
    });

    if (failureStatus === 'UNKNOWN_OUTCOME') {
      return { status: 'not_executable', reason: 'already_final', operation: updated };
    }

    return { status: 'not_executable', reason: 'local_validation_failed', operation: updated };
  }
}
