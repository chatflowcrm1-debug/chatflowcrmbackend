import { randomUUID } from 'crypto';
import { prisma } from '../../db/prisma';

export const TELECOM_RECONCILIATION_STATES = ['REQUIRED', 'IN_PROGRESS', 'RESOLVED', 'FAILED', 'AMBIGUOUS'] as const;
export type TelecomReconciliationState = (typeof TELECOM_RECONCILIATION_STATES)[number];

const RECONCILIABLE_STATUSES = new Set(['UNKNOWN_OUTCOME', 'PROVIDER_ACCEPTED', 'LOCALIZING']);
const FINAL_STATUSES = new Set(['COMPLETED', 'FAILED']);

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function normalizePhoneNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

export async function findMatchingTelecomOperationsByProviderResource(input: {
  provider: string;
  providerResourceType: string;
  providerResourceId: string;
  organizationId?: string;
}) {
  const where: Record<string, unknown> = {
    provider: input.provider,
    providerResourceType: input.providerResourceType,
    providerResourceId: input.providerResourceId,
  };

  if (input.organizationId) {
    where.organizationId = input.organizationId;
  }

  return prisma.telecomOperation.findMany({
    where,
    orderBy: { updatedAt: 'asc' },
  });
}

async function applyReconciliationState(operationId: string, data: Record<string, unknown>, now: Date) {
  return prisma.telecomOperation.update({
    where: { id: operationId },
    data: {
      ...data,
      updatedAt: now,
      version: { increment: 1 },
    },
  });
}

async function finalizeReconciliation(operation: any, state: TelecomReconciliationState, reason: string | null, now: Date) {
  const baseState = state === 'RESOLVED' ? 'COMPLETED' : operation.status;
  const payload: Record<string, unknown> = {
    reconciliationState: state,
    reconciledAt: state === 'RESOLVED' ? now : null,
    reconciliationError: reason,
    leaseOwner: null,
    leaseUntil: null,
    providerResolvedAt: state === 'RESOLVED' ? now : operation.providerResolvedAt ?? null,
    updatedAt: now,
    version: { increment: 1 },
  };

  if (state === 'RESOLVED') {
    payload.status = 'COMPLETED';
    payload.completedAt = now;
    payload.failedAt = operation.failedAt ?? null;
  } else if (state === 'AMBIGUOUS' || state === 'FAILED' || state === 'REQUIRED') {
    payload.status = operation.status;
    payload.completedAt = operation.completedAt ?? null;
    payload.failedAt = operation.failedAt ?? null;
  } else if (state === 'IN_PROGRESS') {
    payload.status = operation.status;
    payload.completedAt = operation.completedAt ?? null;
    payload.failedAt = operation.failedAt ?? null;
  }

  if (state === 'FAILED') {
    payload.status = 'FAILED';
    payload.failedAt = now;
    payload.completedAt = operation.completedAt ?? null;
  }

  if (state === 'REQUIRED') {
    payload.status = operation.status;
    payload.completedAt = operation.completedAt ?? null;
    payload.failedAt = operation.failedAt ?? null;
  }

  const resolved = await applyReconciliationState(operation.id, payload, now);
  return resolved;
}

async function findExistingPhoneNumberMatch(operation: any) {
  if (!operation.providerResourceId) return [] as any[];
  return prisma.phoneNumber.findMany({
    where: {
      provider: operation.provider,
      providerNumberId: operation.providerResourceId,
    },
  });
}

async function findExistingMessageMatch(operation: any) {
  if (!operation.providerResourceId) return [] as any[];
  return prisma.telecomMessage.findMany({
    where: {
      provider: operation.provider,
      providerMessageId: operation.providerResourceId,
    },
  });
}

async function findExistingCallMatch(operation: any) {
  if (!operation.providerResourceId) return [] as any[];
  return prisma.telecomCall.findMany({
    where: {
      provider: operation.provider,
      providerCallId: operation.providerResourceId,
    },
  });
}

async function ensureLocalPhoneNumber(operation: any, now: Date) {
  const metadata = toRecord(operation.metadata);
  const providerNumberId = typeof operation.providerResourceId === 'string' && operation.providerResourceId.length > 0
    ? operation.providerResourceId
    : typeof metadata.providerNumberId === 'string' ? metadata.providerNumberId : null;
  const phoneNumberValue = typeof metadata.phoneNumber === 'string' ? metadata.phoneNumber : typeof metadata.number === 'string' ? metadata.number : null;
  const e164 = phoneNumberValue ? normalizePhoneNumber(phoneNumberValue) : null;

  if (!providerNumberId || !e164) {
    return { kind: 'missing-evidence' as const, result: null };
  }

  const existing = await prisma.phoneNumber.findMany({
    where: {
      organizationId: operation.organizationId,
      provider: operation.provider,
      OR: [
        { providerNumberId },
        { phoneNumber: e164 },
      ],
    },
  });

  if (existing.length > 1) {
    return { kind: 'ambiguous' as const, result: existing };
  }
  if (existing.length === 1) {
    return { kind: 'existing' as const, result: existing[0] };
  }

  const country = typeof metadata.country === 'string' ? metadata.country : 'US';
  const numberType = typeof metadata.numberType === 'string' ? metadata.numberType : 'LOCAL';
  const areaCode = typeof metadata.areaCode === 'string' ? metadata.areaCode : undefined;
  const capabilities = Array.isArray(metadata.capabilities)
    ? metadata.capabilities.filter((item): item is string => typeof item === 'string')
    : ['voice', 'sms'];

  const created = await prisma.phoneNumber.create({
    data: {
      organizationId: operation.organizationId,
      provider: operation.provider,
      providerNumberId,
      phoneNumber: e164,
      country,
      numberType,
      areaCode,
      capabilities,
      status: 'ACTIVE',
    },
  });

  return { kind: 'created' as const, result: created };
}

async function ensureLocalMessage(operation: any, now: Date) {
  if (!operation.providerResourceId) return { kind: 'missing-evidence' as const, result: null };
  const metadata = toRecord(operation.metadata);
  const existing = await prisma.telecomMessage.findMany({
    where: {
      organizationId: operation.organizationId,
      provider: operation.provider,
      providerMessageId: operation.providerResourceId,
    },
  });

  if (existing.length > 1) {
    return { kind: 'ambiguous' as const, result: existing };
  }
  if (existing.length === 1) {
    return { kind: 'existing' as const, result: existing[0] };
  }

  const phoneNumberId = typeof operation.phoneNumberId === 'string' && operation.phoneNumberId.length > 0
    ? operation.phoneNumberId
    : typeof metadata.phoneNumberId === 'string' ? metadata.phoneNumberId : null;
  const toNumber = typeof metadata.toNumber === 'string' ? metadata.toNumber : typeof metadata.to === 'string' ? metadata.to : null;
  const body = typeof metadata.body === 'string' ? metadata.body : typeof metadata.text === 'string' ? metadata.text : '';

  if (!phoneNumberId || !toNumber) {
    return { kind: 'missing-evidence' as const, result: null };
  }

  const created = await prisma.telecomMessage.create({
    data: {
      organizationId: operation.organizationId,
      customerId: operation.customerId ?? null,
      phoneNumberId,
      provider: operation.provider,
      providerMessageId: operation.providerResourceId,
      direction: 'OUTBOUND',
      fromNumber: '',
      toNumber,
      body,
      status: 'QUEUED',
    },
  });

  return { kind: 'created' as const, result: created };
}

async function ensureLocalCall(operation: any, now: Date) {
  if (!operation.providerResourceId) return { kind: 'missing-evidence' as const, result: null };
  const metadata = toRecord(operation.metadata);
  const existing = await prisma.telecomCall.findMany({
    where: {
      organizationId: operation.organizationId,
      provider: operation.provider,
      providerCallId: operation.providerResourceId,
    },
  });

  if (existing.length > 1) {
    return { kind: 'ambiguous' as const, result: existing };
  }
  if (existing.length === 1) {
    return { kind: 'existing' as const, result: existing[0] };
  }

  const phoneNumberId = typeof operation.phoneNumberId === 'string' && operation.phoneNumberId.length > 0
    ? operation.phoneNumberId
    : typeof metadata.phoneNumberId === 'string' ? metadata.phoneNumberId : null;
  const toNumber = typeof metadata.toNumber === 'string' ? metadata.toNumber : typeof metadata.to === 'string' ? metadata.to : null;

  if (!phoneNumberId || !toNumber) {
    return { kind: 'missing-evidence' as const, result: null };
  }

  const created = await prisma.telecomCall.create({
    data: {
      organizationId: operation.organizationId,
      userId: operation.userId,
      customerId: operation.customerId ?? null,
      phoneNumberId,
      provider: operation.provider,
      providerCallId: operation.providerResourceId,
      direction: 'OUTBOUND',
      status: 'INITIATED',
      fromNumber: '',
      toNumber,
      startedAt: now,
      recordingEnabled: Boolean(metadata.recordingEnabled),
    },
  });

  return { kind: 'created' as const, result: created };
}

async function resolveLocalResourceForOperation(operation: any, now: Date) {
  const providerType = operation.providerResourceType;
  if (!providerType || !operation.providerResourceId) {
    return { kind: 'missing-evidence' as const, result: null };
  }

  if (providerType === 'PHONE_NUMBER') {
    const matches = await findExistingPhoneNumberMatch(operation);
    if (matches.length > 1) return { kind: 'ambiguous' as const, result: matches };
    if (matches.length === 1) {
      if (matches[0].organizationId !== operation.organizationId) {
        return { kind: 'cross-org' as const, result: matches[0] };
      }
      return { kind: 'existing' as const, result: matches[0] };
    }
    return ensureLocalPhoneNumber(operation, now);
  }

  if (providerType === 'TELECOM_MESSAGE') {
    const matches = await findExistingMessageMatch(operation);
    if (matches.length > 1) return { kind: 'ambiguous' as const, result: matches };
    if (matches.length === 1) {
      if (matches[0].organizationId !== operation.organizationId) {
        return { kind: 'cross-org' as const, result: matches[0] };
      }
      return { kind: 'existing' as const, result: matches[0] };
    }
    return ensureLocalMessage(operation, now);
  }

  if (providerType === 'TELECOM_CALL') {
    const matches = await findExistingCallMatch(operation);
    if (matches.length > 1) return { kind: 'ambiguous' as const, result: matches };
    if (matches.length === 1) {
      if (matches[0].organizationId !== operation.organizationId) {
        return { kind: 'cross-org' as const, result: matches[0] };
      }
      return { kind: 'existing' as const, result: matches[0] };
    }
    return ensureLocalCall(operation, now);
  }

  return { kind: 'missing-evidence' as const, result: null };
}

export async function reconcileTelecomOperation(operationId: string, options?: { now?: Date; leaseOwner?: string }) {
  const now = options?.now ?? new Date();
  const operation = await prisma.telecomOperation.findUnique({ where: { id: operationId } });

  if (!operation) {
    return { status: 'not_found', operation: null, reconciliationState: null };
  }

  if (FINAL_STATUSES.has(operation.status)) {
    return { status: 'not_applicable', operation, reconciliationState: operation.reconciliationState ?? null };
  }

  if (!RECONCILIABLE_STATUSES.has(operation.status)) {
    return { status: 'not_applicable', operation, reconciliationState: operation.reconciliationState ?? null };
  }

  const leaseOwner = options?.leaseOwner ?? `reconcile-${randomUUID()}`;
  const leaseUntil = new Date(now.getTime() + 30_000);
  const lockResult = await prisma.telecomOperation.updateMany({
    where: {
      id: operationId,
      status: operation.status,
      version: operation.version,
    },
    data: {
      reconciliationState: 'IN_PROGRESS',
      leaseOwner,
      leaseUntil,
      version: { increment: 1 },
    },
  });

  if (lockResult.count !== 1) {
    return {
      status: 'locked',
      operation,
      reconciliationState: operation.reconciliationState ?? null,
      reason: 'Another worker is reconciling this telecom operation',
    };
  }

  try {
    const resourceType = operation.providerResourceType;
    const resourceId = operation.providerResourceId;

    if (!resourceType || !resourceId) {
      await finalizeReconciliation(operation, 'REQUIRED', 'Provider resource identity is not available for safe reconciliation', now);
      return {
        status: 'unresolved',
        operation: await prisma.telecomOperation.findUnique({ where: { id: operationId } }),
        reconciliationState: 'REQUIRED',
        reason: 'Provider resource identity is not available for safe reconciliation',
      };
    }

    const resolution = await resolveLocalResourceForOperation(operation, now);

    if (resolution.kind === 'ambiguous' || resolution.kind === 'cross-org') {
      await finalizeReconciliation(operation, 'AMBIGUOUS', resolution.kind === 'cross-org' ? 'Provider identity resolved to another organization' : 'Multiple local authoritative records matched the provider identity', now);
      return {
        status: 'ambiguous',
        operation: await prisma.telecomOperation.findUnique({ where: { id: operationId } }),
        reconciliationState: 'AMBIGUOUS',
      };
    }

    if (resolution.kind === 'missing-evidence') {
      await finalizeReconciliation(operation, 'REQUIRED', 'Required durable evidence for authoritative local resource is missing', now);
      return {
        status: 'unresolved',
        operation: await prisma.telecomOperation.findUnique({ where: { id: operationId } }),
        reconciliationState: 'REQUIRED',
      };
    }

    const resource = resolution.result;
    const nowUpdated = new Date(now.getTime());
    const targetStatus = operation.status === 'UNKNOWN_OUTCOME' || operation.status === 'PROVIDER_ACCEPTED' || operation.status === 'LOCALIZING' ? 'COMPLETED' : operation.status;

    const update: Record<string, unknown> = {
      status: targetStatus,
      reconciliationState: 'RESOLVED',
      reconciledAt: nowUpdated,
      reconciliationError: null,
      providerResolvedAt: nowUpdated,
      updatedAt: nowUpdated,
      leaseOwner: null,
      leaseUntil: null,
      completedAt: targetStatus === 'COMPLETED' ? nowUpdated : operation.completedAt ?? null,
      failedAt: operation.failedAt ?? null,
    };

    if (operation.operationType === 'NUMBER_PURCHASE' && resource && typeof resource === 'object' && 'id' in resource) {
      update.phoneNumberId = resource.id;
    }
    if (operation.operationType === 'SMS_SEND' && resource && typeof resource === 'object' && 'id' in resource) {
      update.telecomMessageId = resource.id;
    }
    if (operation.operationType === 'VOICE_CALL' && resource && typeof resource === 'object' && 'id' in resource) {
      update.telecomCallId = resource.id;
    }

    const finalized = await applyReconciliationState(operation.id, update, nowUpdated);

    return {
      status: 'resolved',
      operation: finalized,
      reconciliationState: 'RESOLVED',
    };
  } finally {
    await prisma.telecomOperation.updateMany({
      where: { id: operationId },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
