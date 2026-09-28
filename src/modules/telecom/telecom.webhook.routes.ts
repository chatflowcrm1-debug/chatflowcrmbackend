import crypto from 'crypto';
import { Router } from 'express';
import { prisma } from '../../db/prisma';
import { webhookRateLimit } from '../../middleware/rate-limit';
import { logger } from '../../utils/logger';
import { reconcileTelecomOperation } from './telecom.reconciliation';
import { normalizeTelecomNumber, resolveTelecomOrganization, TELNYX_PROVIDER } from './telecom.service';
import { maybeRecordSmsUsage, maybeRecordVoiceUsage } from './telecom.usage';
import { extractTelnyxNumberReference, parseTelnyxInboundCall, parseTelnyxInboundSms, parseTelnyxRecordingEvent, parseTelnyxSmsStatus, parseTelnyxWebhookEvent, shouldAdvanceCallStatus, shouldAdvanceSmsStatus, verifyTelnyxWebhookSignature } from './telecom.webhook';

const router = Router();

function isTerminalCallStatus(status: string) {
  return ['COMPLETED', 'FAILED', 'BUSY', 'NO_ANSWER', 'CANCELLED'].includes(status);
}

async function reconcileCorrelatedOperationSafe(input: {
  provider: string;
  providerResourceType: string;
  providerResourceId: string;
  organizationId?: string | null;
  now: Date;
}) {
  const operationModel = (prisma as any).telecomOperation;
  if (!operationModel || typeof operationModel.findMany !== 'function') {
    return;
  }

  try {
    const matches = await operationModel.findMany({
      where: {
        provider: input.provider,
        providerResourceType: input.providerResourceType,
        providerResourceId: input.providerResourceId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });

    if (!Array.isArray(matches) || matches.length !== 1) {
      return;
    }

    const [match] = matches;
    if (input.organizationId && match.organizationId !== input.organizationId) {
      return;
    }

    await reconcileTelecomOperation(match.id, {
      now: input.now,
      leaseOwner: 'telnyx-webhook',
    });
  } catch (error) {
    logger.warn('Webhook operation reconciliation skipped due to a safe correlation condition', {
      provider: input.provider,
      providerResourceType: input.providerResourceType,
      providerResourceId: input.providerResourceId,
      organizationId: input.organizationId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

router.post('/webhook', webhookRateLimit, async (req, res) => {
  const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !verifyTelnyxWebhookSignature(rawBody, req.header('telnyx-signature-ed25519'), req.header('telnyx-timestamp'))) {
    return res.status(401).json({ message: 'Invalid webhook signature' });
  }

  const event = parseTelnyxWebhookEvent(req.body);
  if (!event) return res.status(400).json({ message: 'Invalid webhook payload' });

  const inboundSms = parseTelnyxInboundSms(event);
  if (event.eventType === 'message.received' && !inboundSms) return res.status(400).json({ message: 'Invalid inbound message payload' });
  const smsStatus = parseTelnyxSmsStatus(event);
  if (event.eventType.startsWith('message.') && event.eventType !== 'message.received' && !smsStatus) return res.status(400).json({ message: 'Invalid message status payload' });
  const inboundCall = parseTelnyxInboundCall(event);
  if (event.eventType.startsWith('call.') && !inboundCall) return res.status(400).json({ message: 'Invalid inbound call payload' });

  const reference = extractTelnyxNumberReference(event.payload);
  const phoneNumber = await resolveTelecomOrganization(inboundSms ? { providerNumberId: reference.providerNumberId, phoneNumber: inboundSms.toNumber } : inboundCall ? { providerNumberId: reference.providerNumberId, phoneNumber: inboundCall.toNumber } : reference);
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  try {
    await prisma.$transaction(async (tx) => {
      await tx.webhookEvent.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: phoneNumber?.organizationId,
          provider: 'TELNYX',
          externalEventId: event.externalEventId,
          payloadHash,
          processedAt: new Date(),
        },
      });

      if (smsStatus) {
        const existingMessage = await tx.telecomMessage.findUnique({ where: { provider_providerMessageId: { provider: TELNYX_PROVIDER, providerMessageId: smsStatus.providerMessageId } } });
        if (existingMessage && shouldAdvanceSmsStatus(existingMessage.status, smsStatus.status)) {
          await tx.telecomMessage.update({ where: { id: existingMessage.id }, data: { status: smsStatus.status, events: { create: { providerEventId: event.externalEventId, eventType: event.eventType, payload: { status: smsStatus.status } } } } });
          if (existingMessage.organizationId && ['SENT', 'DELIVERED'].includes(smsStatus.status)) {
            await maybeRecordSmsUsage(existingMessage.organizationId, existingMessage.id, smsStatus.status, tx);
          }
        }

        await reconcileCorrelatedOperationSafe({
          provider: TELNYX_PROVIDER,
          providerResourceType: 'TELECOM_MESSAGE',
          providerResourceId: smsStatus.providerMessageId,
          organizationId: existingMessage?.organizationId ?? null,
          now: new Date(),
        });
        return;
      }

      const recordingEvent = parseTelnyxRecordingEvent(event);
      if (recordingEvent) {
        const call = await tx.telecomCall.findFirst({ where: { provider: TELNYX_PROVIDER, providerCallId: recordingEvent.providerCallId } });
        if (!call) return;
        if (phoneNumber && call.organizationId !== phoneNumber.organizationId) return;

        await reconcileCorrelatedOperationSafe({
          provider: TELNYX_PROVIDER,
          providerResourceType: 'TELECOM_CALL',
          providerResourceId: recordingEvent.providerCallId,
          organizationId: call.organizationId,
          now: new Date(),
        });

        const existingRecording = await tx.recording.findUnique({ where: { callId: call.id } });
        const normalizedStatus = recordingEvent.status || 'PENDING';
        const nextRecording = existingRecording
          ? await tx.recording.update({
              where: { id: existingRecording.id },
              data: {
                providerRecordingId: recordingEvent.providerRecordingId,
                storageUrl: recordingEvent.storageUrl ?? existingRecording.storageUrl,
                durationSeconds: recordingEvent.durationSeconds ?? existingRecording.durationSeconds,
                status: normalizedStatus,
              },
            })
          : await tx.recording.create({
              data: {
                organizationId: call.organizationId,
                callId: call.id,
                providerRecordingId: recordingEvent.providerRecordingId,
                storageUrl: recordingEvent.storageUrl,
                durationSeconds: recordingEvent.durationSeconds,
                status: normalizedStatus,
              },
            });

        await tx.telecomCall.update({
          where: { id: call.id },
          data: { recordingId: nextRecording.id },
        });
        await tx.webhookEvent.update({ where: { provider_externalEventId: { provider: 'TELNYX', externalEventId: event.externalEventId } }, data: { processedAt: new Date() } });
        return;
      }

      if ((!inboundSms && !inboundCall) || !phoneNumber) return;

      if (inboundCall) {
        const sender = normalizeTelecomNumber(inboundCall.fromNumber);
        const destination = normalizeTelecomNumber(inboundCall.toNumber);
        const customers = await tx.customer.findMany({ where: { organizationId: phoneNumber.organizationId, phone: { not: null } }, select: { id: true, phone: true } });
        const matches = customers.filter((customer) => normalizeTelecomNumber(customer.phone || '') === sender);
        const customerId = matches.length === 1 ? matches[0].id : null;
        const existingCall = await tx.telecomCall.findFirst({ where: { organizationId: phoneNumber.organizationId, provider: TELNYX_PROVIDER, providerCallId: inboundCall.providerCallId } });
        if (existingCall) {
          if (shouldAdvanceCallStatus(existingCall.status, inboundCall.status)) {
            await tx.telecomCall.update({ where: { id: existingCall.id }, data: { status: inboundCall.status, ...(inboundCall.status === 'ANSWERED' ? { answeredAt: inboundCall.occurredAt || new Date() } : {}), ...(isTerminalCallStatus(inboundCall.status) ? { endedAt: inboundCall.occurredAt || new Date() } : {}), events: { create: { providerEventId: event.externalEventId, eventType: event.eventType, payload: { status: inboundCall.status } } } } });
            if (inboundCall.status === 'COMPLETED') {
              await maybeRecordVoiceUsage(phoneNumber.organizationId, existingCall.id, tx);
            }
          }
        } else {
          const createdCall = await tx.telecomCall.create({ data: { organizationId: phoneNumber.organizationId, customerId, phoneNumberId: phoneNumber.id, provider: TELNYX_PROVIDER, providerCallId: inboundCall.providerCallId, direction: 'INBOUND', status: inboundCall.status, fromNumber: sender, toNumber: destination, startedAt: inboundCall.occurredAt || new Date(), answeredAt: inboundCall.status === 'ANSWERED' ? inboundCall.occurredAt || new Date() : null, endedAt: isTerminalCallStatus(inboundCall.status) ? inboundCall.occurredAt || new Date() : null, events: { create: { providerEventId: event.externalEventId, eventType: event.eventType, payload: { status: inboundCall.status } } } } });
          if (inboundCall.status === 'COMPLETED') {
            await maybeRecordVoiceUsage(phoneNumber.organizationId, createdCall.id, tx);
          }
        }
        await reconcileCorrelatedOperationSafe({
          provider: TELNYX_PROVIDER,
          providerResourceType: 'TELECOM_CALL',
          providerResourceId: inboundCall.providerCallId,
          organizationId: phoneNumber.organizationId,
          now: new Date(),
        });
        await tx.webhookEvent.update({ where: { provider_externalEventId: { provider: 'TELNYX', externalEventId: event.externalEventId } }, data: { processedAt: new Date() } });
        return;
      }

      if (!inboundSms) return;

      const destination = normalizeTelecomNumber(inboundSms.toNumber);
      const sender = normalizeTelecomNumber(inboundSms.fromNumber);
      if (!destination || !sender || destination !== (await tx.phoneNumber.findUnique({ where: { id: phoneNumber.id }, select: { phoneNumber: true } }))?.phoneNumber) return;

      const existingMessage = await tx.telecomMessage.findUnique({ where: { provider_providerMessageId: { provider: TELNYX_PROVIDER, providerMessageId: inboundSms.providerMessageId } } });
      if (existingMessage) {
        await reconcileCorrelatedOperationSafe({
          provider: TELNYX_PROVIDER,
          providerResourceType: 'TELECOM_MESSAGE',
          providerResourceId: inboundSms.providerMessageId,
          organizationId: phoneNumber.organizationId,
          now: new Date(),
        });
        return;
      }

      const customers = await tx.customer.findMany({ where: { organizationId: phoneNumber.organizationId, phone: { not: null } }, select: { id: true, phone: true } });
      const matches = customers.filter((customer) => normalizeTelecomNumber(customer.phone || '') === sender);
      const customerId = matches.length === 1 ? matches[0].id : null;
      const externalContactId = `${destination}:${sender}`;
      const conversation = await tx.conversation.upsert({
        where: { organizationId_channel_externalContactId: { organizationId: phoneNumber.organizationId, channel: 'SMS', externalContactId } },
        update: { customerId: customerId || undefined, lastMessageAt: inboundSms.occurredAt || new Date(), unreadCount: { increment: 1 } },
        create: { organizationId: phoneNumber.organizationId, channel: 'SMS', externalContactId, customerId, unreadCount: 1, lastMessageAt: inboundSms.occurredAt || new Date(), title: sender },
      });
      const message = await tx.telecomMessage.create({
        data: {
          organizationId: phoneNumber.organizationId,
          customerId,
          phoneNumberId: phoneNumber.id,
          provider: TELNYX_PROVIDER,
          providerMessageId: inboundSms.providerMessageId,
          direction: 'INBOUND',
          fromNumber: sender,
          toNumber: destination,
          body: inboundSms.body,
          status: 'RECEIVED',
          createdAt: inboundSms.occurredAt || undefined,
          events: { create: { providerEventId: event.externalEventId, eventType: event.eventType, payload: { mediaCount: inboundSms.media.length } } },
        },
      });
      await tx.message.create({
        data: {
          organizationId: phoneNumber.organizationId,
          conversationId: conversation.id,
          provider: TELNYX_PROVIDER,
          providerMessageId: inboundSms.providerMessageId,
          direction: 'INBOUND',
          body: inboundSms.body,
          status: 'RECEIVED',
          senderId: sender,
          recipientId: destination,
          createdAt: message.createdAt,
        },
      });
      await tx.webhookEvent.update({ where: { provider_externalEventId: { provider: 'TELNYX', externalEventId: event.externalEventId } }, data: { processedAt: new Date() } });
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return res.status(200).json({ ok: true, duplicate: true });
    logger.error('Telnyx webhook registration failed', { provider: 'TELNYX', eventType: event.eventType, externalEventId: event.externalEventId, category: 'registration' });
    return res.status(500).json({ message: 'Webhook processing failed' });
  }

  logger.info('Telnyx webhook acknowledged', { provider: 'TELNYX', eventType: event.eventType, externalEventId: event.externalEventId, outcome: 'registered' });
  return res.status(200).json({ ok: true, registered: true, organizationResolved: Boolean(phoneNumber) });
});

export default router;