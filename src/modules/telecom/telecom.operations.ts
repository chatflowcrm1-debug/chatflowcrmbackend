import crypto from 'crypto';
import { prisma } from '../../db/prisma';

export type TelecomOperationType = 'NUMBER_PURCHASE' | 'SMS_SEND' | 'VOICE_CALL';

export function normalizeIdempotencyKey(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const normalized = value?.trim();
  return normalized || null;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashValue(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function computeRequestHash(payload: Record<string, unknown>) {
  return hashValue(stableStringify(payload));
}

export function toTelecomOperationResponse(operation: {
  id: string;
  operationType: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: operation.id,
    operationType: operation.operationType,
    status: operation.status,
    createdAt: operation.createdAt,
  };
}

export async function ensureTelecomOperation(input: {
  organizationId: string;
  userId: string;
  operationType: TelecomOperationType;
  provider: string;
  requestPayload: Record<string, unknown>;
  idempotencyKey: string;
  customerId?: string | null;
  phoneNumberId?: string | null;
}) {
  const idempotencyKeyHash = hashValue(input.idempotencyKey.trim());
  const requestHash = computeRequestHash(input.requestPayload);

  const existing = await prisma.telecomOperation.findFirst({
    where: {
      organizationId: input.organizationId,
      operationType: input.operationType,
      idempotencyKeyHash,
    },
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      return {
        status: 'conflict' as const,
        operation: existing,
        message: 'Idempotency key reused with a different request payload',
      };
    }

    return {
      status: 'replay' as const,
      operation: existing,
      message: 'Telecom operation already exists',
    };
  }

  try {
    const operation = await prisma.telecomOperation.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        customerId: input.customerId ?? null,
        phoneNumberId: input.phoneNumberId ?? null,
        operationType: input.operationType,
        provider: input.provider,
        status: 'PENDING',
        idempotencyKeyHash,
        requestHash,
        metadata: JSON.parse(JSON.stringify(input.requestPayload)) as any,
      },
    });

    return {
      status: 'created' as const,
      operation,
      message: 'Telecom operation created',
    };
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const retry = await prisma.telecomOperation.findFirst({
        where: {
          organizationId: input.organizationId,
          operationType: input.operationType,
          idempotencyKeyHash,
        },
      });
      if (retry) {
        if (retry.requestHash !== requestHash) {
          return {
            status: 'conflict' as const,
            operation: retry,
            message: 'Idempotency key reused with a different request payload',
          };
        }
        return {
          status: 'replay' as const,
          operation: retry,
          message: 'Telecom operation already exists',
        };
      }
    }

    throw error;
  }
}
