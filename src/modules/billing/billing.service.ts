import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

export const usageCategories = ['CONTACT', 'EMAIL', 'SMS', 'VOICE_MINUTE', 'PHONE_NUMBER'] as const;
export type UsageCategory = typeof usageCategories[number];

const limitFieldByCategory: Record<UsageCategory, 'contactLimit' | 'emailLimit' | 'smsLimit' | 'voiceMinuteLimit' | 'phoneNumberLimit'> = {
  CONTACT: 'contactLimit', EMAIL: 'emailLimit', SMS: 'smsLimit', VOICE_MINUTE: 'voiceMinuteLimit', PHONE_NUMBER: 'phoneNumberLimit',
};

export async function getOrganizationSubscription(organizationId: string) { return prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } }); }

export async function getUsageForCurrentPeriod(organizationId: string) {
  const subscription = await getOrganizationSubscription(organizationId);
  if (!subscription) return null;
  const records = await prisma.usageRecord.groupBy({ by: ['category'], where: { organizationId, periodStart: { gte: subscription.currentPeriodStart, lt: subscription.currentPeriodEnd }, status: { not: 'VOID' } }, _sum: { quantity: true } });
  const usage: Record<UsageCategory, number> = { CONTACT: await prisma.customer.count({ where: { organizationId } }), EMAIL: 0, SMS: 0, VOICE_MINUTE: 0, PHONE_NUMBER: 0 };
  for (const record of records) if (usageCategories.includes(record.category as UsageCategory)) usage[record.category as UsageCategory] = record._sum.quantity || 0;
  const limits = Object.fromEntries(usageCategories.map((category) => [category, subscription.plan[limitFieldByCategory[category]]])) as Record<UsageCategory, number | null>;
  const remaining = Object.fromEntries(usageCategories.map((category) => [category, limits[category] === null ? null : Math.max(0, limits[category] - usage[category])])) as Record<UsageCategory, number | null>;
  return { subscription, usage, limits, remaining };
}

export class UsageLimitExceededError extends Error {
  readonly code = 'USAGE_LIMIT_EXCEEDED';
  constructor(readonly category: UsageCategory, readonly used: number, readonly requested: number, readonly limit: number, readonly remaining: number) { super(`Usage limit exceeded for ${category}`); }
}

export class SubscriptionNotBillableError extends Error {
  readonly code = 'SUBSCRIPTION_NOT_BILLABLE';
  constructor(readonly status: string) { super('Subscription is not billable'); }
}

export interface CommercialUsageInput {
  category: UsageCategory; quantity: number; unit: string; provider: string; sourceType?: string; sourceId?: string;
  campaignId?: string; campaignRecipientId?: string; messageId?: string; telecomCallId?: string; telecomMessageId?: string;
  providerId?: string; unitPrice?: string; currency?: string; idempotencyKey: string; metadata?: unknown;
}

export async function recordCommercialUsage(organizationId: string, data: CommercialUsageInput) {
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "Subscription" WHERE "organizationId" = ${organizationId} FOR UPDATE`;
    const subscription = await transaction.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
    if (!subscription) throw new SubscriptionNotBillableError('MISSING');
    if (['CANCELED', 'EXPIRED'].includes(subscription.status)) throw new SubscriptionNotBillableError(subscription.status);
    return recordUsage(organizationId, { ...data, subscriptionId: subscription.id, planId: subscription.planId, periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd, currency: data.currency || subscription.plan.currency }, transaction);
  });
}

export async function recordCommercialUsageForTransaction(organizationId: string, data: CommercialUsageInput, transaction: Prisma.TransactionClient = prisma) {
  const subscription = await transaction.subscription?.findUnique?.({ where: { organizationId }, include: { plan: true } });
  if (!subscription) return { record: null, duplicate: false, skipped: true, reason: 'SUBSCRIPTION_REQUIRED' } as const;
  if (['CANCELED', 'EXPIRED'].includes(subscription.status)) return { record: null, duplicate: false, skipped: true, reason: subscription.status } as const;
  return recordUsage(organizationId, { ...data, subscriptionId: subscription.id, planId: subscription.planId, periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd, currency: data.currency || subscription.plan.currency }, transaction);
}

export async function recordUsage(organizationId: string, data: CommercialUsageInput & { subscriptionId: string; planId: string; periodStart: Date; periodEnd: Date }, transaction: Prisma.TransactionClient = prisma) {
  const existing = await transaction.usageRecord.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
  if (existing) return { record: existing, duplicate: true };
  const grouped = await transaction.usageRecord.groupBy({ by: ['category'], where: { organizationId, category: data.category, periodStart: { gte: data.periodStart, lt: data.periodEnd }, status: { not: 'VOID' } }, _sum: { quantity: true } });
  const used = grouped[0]?._sum.quantity || 0;
  const limitField = limitFieldByCategory[data.category];
  const plan = await transaction.plan.findUnique({ where: { id: data.planId }, select: { [limitField]: true } });
  const limit = plan?.[limitField] as number | null | undefined;
  if (limit !== null && limit !== undefined && used + data.quantity > limit) throw new UsageLimitExceededError(data.category, used, data.quantity, limit, Math.max(0, limit - used));
  const record = await transaction.usageRecord.create({ data: { organizationId, subscriptionId: data.subscriptionId, planId: data.planId, provider: data.provider, category: data.category, quantity: data.quantity, unit: data.unit, periodStart: data.periodStart, periodEnd: data.periodEnd, sourceType: data.sourceType, sourceId: data.sourceId, campaignId: data.campaignId, campaignRecipientId: data.campaignRecipientId, messageId: data.messageId, telecomCallId: data.telecomCallId, telecomMessageId: data.telecomMessageId, providerId: data.providerId, unitPrice: data.unitPrice ? new Prisma.Decimal(data.unitPrice) : null, currency: data.currency, amount: calculateAmount(data.quantity, data.unitPrice), idempotencyKey: data.idempotencyKey, metadata: data.metadata ? JSON.parse(JSON.stringify(data.metadata)) : undefined } });
  return { record, duplicate: false };
}

export function calculateAmount(quantity: number, unitPrice?: string) { return unitPrice ? new Prisma.Decimal(unitPrice).mul(quantity) : null; }
