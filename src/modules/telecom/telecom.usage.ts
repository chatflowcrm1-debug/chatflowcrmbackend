import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { recordCommercialUsageForTransaction } from '../billing/billing.service';

const billableSmsStatuses = new Set(['SENT', 'DELIVERED']);

export function calculateVoiceMinutes(durationSeconds?: number | null) {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

export async function maybeRecordSmsUsage(
  organizationId: string,
  telecomMessageId: string,
  status?: string,
  transaction: Prisma.TransactionClient = prisma,
) {
  if (status && !billableSmsStatuses.has(status)) return null;

  const message = await transaction.telecomMessage.findUnique({ where: { id: telecomMessageId } });
  if (!message || message.organizationId !== organizationId || message.direction !== 'OUTBOUND') return null;

  const finalStatus = (message.status || status || '').toUpperCase();
  if (status && finalStatus === 'FAILED') return null;
  if (!billableSmsStatuses.has(finalStatus)) return null;

  const billingTransaction = transaction === prisma ? undefined : transaction;
  return recordCommercialUsageForTransaction(
    organizationId,
    {
      category: 'SMS',
      quantity: 1,
      unit: 'message',
      provider: message.provider,
      sourceType: 'TelecomMessage',
      sourceId: message.id,
      telecomMessageId: message.id,
      messageId: message.providerMessageId || message.id,
      idempotencyKey: `telecom:sms:${organizationId}:${message.id}:${finalStatus}`,
      metadata: {
        direction: message.direction,
        providerStatus: finalStatus,
      },
    },
    billingTransaction as Prisma.TransactionClient | undefined,
  );
}

export async function maybeRecordVoiceUsage(
  organizationId: string,
  telecomCallId: string,
  transaction: Prisma.TransactionClient = prisma,
) {
  const call = await transaction.telecomCall.findUnique({ where: { id: telecomCallId } });
  if (!call || call.organizationId !== organizationId) return null;
  if (call.status !== 'COMPLETED') return null;

  const minutes = calculateVoiceMinutes(call.durationSeconds ?? 0);
  if (minutes <= 0) return null;

  const billingTransaction = transaction === prisma ? undefined : transaction;
  return recordCommercialUsageForTransaction(
    organizationId,
    {
      category: 'VOICE_MINUTE',
      quantity: minutes,
      unit: 'minute',
      provider: call.provider,
      sourceType: 'TelecomCall',
      sourceId: call.id,
      telecomCallId: call.id,
      idempotencyKey: `telecom:voice:${organizationId}:${call.id}`,
      metadata: {
        durationSeconds: call.durationSeconds ?? 0,
      },
    },
    billingTransaction as Prisma.TransactionClient | undefined,
  );
}

export async function maybeRecordPhoneNumberUsage(
  organizationId: string,
  phoneNumberId: string,
  transaction: Prisma.TransactionClient = prisma,
) {
  const number = await transaction.phoneNumber.findUnique({ where: { id: phoneNumberId } });
  if (!number || number.organizationId !== organizationId) return null;

  const billingTransaction = transaction === prisma ? undefined : transaction;
  return recordCommercialUsageForTransaction(
    organizationId,
    {
      category: 'PHONE_NUMBER',
      quantity: 1,
      unit: 'number',
      provider: number.provider,
      sourceType: 'PhoneNumber',
      sourceId: number.id,
      providerId: number.providerNumberId || number.id,
      telecomMessageId: undefined,
      telecomCallId: undefined,
      idempotencyKey: `telecom:phone-number:${organizationId}:${number.id}`,
      metadata: {
        phoneNumber: number.phoneNumber,
      },
    },
    billingTransaction as Prisma.TransactionClient | undefined,
  );
}
