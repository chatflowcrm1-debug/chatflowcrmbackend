import crypto from 'crypto';
import { env } from '../../config/env';

export type TelnyxWebhookEvent = {
  externalEventId: string;
  eventType: string;
  occurredAt: Date | null;
  payload: Record<string, unknown>;
};

export function verifyTelnyxWebhookSignature(rawBody: Buffer, signature: string | undefined, timestamp: string | undefined, publicKey = env.telnyxPublicKey, nowMs = Date.now()) {
  if (!signature || !timestamp || !publicKey || !rawBody.length) return false;
  if (!/^\d+$/.test(timestamp)) return false;

  const timestampSeconds = Number(timestamp);
  const toleranceSeconds = env.telnyxWebhookToleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestampSeconds)) return false;

  const nowSeconds = Math.floor(nowMs / 1000);
  if (timestampSeconds < nowSeconds - toleranceSeconds || timestampSeconds > nowSeconds + toleranceSeconds) return false;

  try {
    const signedPayload = Buffer.from(`${timestamp}.${rawBody.toString('utf8')}`);
    return crypto.verify(null, signedPayload, publicKey, Buffer.from(signature, 'base64'));
  } catch (_error) {
    return false;
  }
}

export function parseTelnyxWebhookEvent(body: unknown): TelnyxWebhookEvent | null {
  if (!body || typeof body !== 'object') return null;
  const envelope = body as { data?: unknown };
  if (!envelope.data || typeof envelope.data !== 'object') return null;
  const data = envelope.data as { id?: unknown; event_type?: unknown; occurred_at?: unknown; payload?: unknown };
  if (typeof data.id !== 'string' || !data.id || typeof data.event_type !== 'string' || !data.event_type) return null;
  const payload = data.payload && typeof data.payload === 'object' ? data.payload as Record<string, unknown> : {};
  const occurredAt = typeof data.occurred_at === 'string' && !Number.isNaN(Date.parse(data.occurred_at)) ? new Date(data.occurred_at) : null;
  return { externalEventId: data.id, eventType: data.event_type, occurredAt, payload };
}

export function extractTelnyxNumberReference(payload: Record<string, unknown>) {
  const providerNumberId = [payload.phone_number_id, payload.number_id].find((value): value is string => typeof value === 'string' && value.length > 0);
  const candidates = [payload.to, payload.to_number, payload.destination_phone_number, payload.phone_number, payload.from, payload.from_number];
  const phoneNumber = candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  return { providerNumberId, phoneNumber };
}

function firstPhoneNumber(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const phone = firstPhoneNumber(item);
      if (phone) return phone;
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstPhoneNumber(record.phone_number) || firstPhoneNumber(record.number);
  }
  return undefined;
}

export type TelnyxInboundSms = {
  providerMessageId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  occurredAt: Date | null;
  media: unknown[];
};

export type TelnyxSmsStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

const smsStatusByEvent: Record<string, TelnyxSmsStatus> = {
  'message.queued': 'QUEUED',
  'message.sent': 'SENT',
  'message.finalized': 'SENT',
  'message.delivered': 'DELIVERED',
  'message.failed': 'FAILED',
};

export function parseTelnyxSmsStatus(event: TelnyxWebhookEvent) {
  const status = smsStatusByEvent[event.eventType];
  if (!status) return null;
  const providerMessageId = [event.payload.id, event.payload.message_id].find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!providerMessageId) return null;
  return { providerMessageId, status, occurredAt: event.occurredAt };
}

const smsStatusRank: Record<TelnyxSmsStatus, number> = { QUEUED: 1, SENT: 2, DELIVERED: 3, FAILED: 3 };

export function shouldAdvanceSmsStatus(current: string, next: TelnyxSmsStatus) {
  if (current === 'DELIVERED' || current === 'FAILED') return false;
  return smsStatusRank[next] >= (smsStatusRank[current as TelnyxSmsStatus] || 0);
}

export type TelnyxInboundCall = {
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  status: 'INITIATED' | 'RINGING' | 'ANSWERED' | 'COMPLETED' | 'FAILED' | 'BUSY' | 'NO_ANSWER' | 'CANCELLED';
  occurredAt: Date | null;
};

const callStatusByEvent: Record<string, TelnyxInboundCall['status']> = {
  'call.initiated': 'INITIATED',
  'call.ringing': 'RINGING',
  'call.answered': 'ANSWERED',
  'call.hangup': 'COMPLETED',
  'call.completed': 'COMPLETED',
  'call.failed': 'FAILED',
  'call.busy': 'BUSY',
  'call.no_answer': 'NO_ANSWER',
  'call.canceled': 'CANCELLED',
  'call.cancelled': 'CANCELLED',
};

export function parseTelnyxInboundCall(event: TelnyxWebhookEvent): TelnyxInboundCall | null {
  const status = callStatusByEvent[event.eventType];
  if (!status) return null;
  const payload = event.payload;
  const providerCallId = [payload.call_control_id, payload.call_session_id, payload.id].find((value): value is string => typeof value === 'string' && value.length > 0);
  const fromNumber = firstPhoneNumber(payload.from) || firstPhoneNumber(payload.from_number);
  const toNumber = firstPhoneNumber(payload.to) || firstPhoneNumber(payload.to_number);
  if (!providerCallId || !fromNumber || !toNumber) return null;
  return { providerCallId, fromNumber, toNumber, status, occurredAt: event.occurredAt };
}

const terminalCallStatuses = new Set<TelnyxInboundCall['status']>(['COMPLETED', 'FAILED', 'BUSY', 'NO_ANSWER', 'CANCELLED']);
const callStatusRank: Record<TelnyxInboundCall['status'], number> = { INITIATED: 1, RINGING: 2, ANSWERED: 3, COMPLETED: 4, FAILED: 4, BUSY: 4, NO_ANSWER: 4, CANCELLED: 4 };

export function shouldAdvanceCallStatus(current: string, next: TelnyxInboundCall['status']) {
  if (terminalCallStatuses.has(current as TelnyxInboundCall['status'])) return false;
  return callStatusRank[next] >= (callStatusRank[current as TelnyxInboundCall['status']] || 0);
}

export type TelnyxRecordingEvent = {
  providerCallId: string;
  providerRecordingId: string;
  storageUrl?: string;
  durationSeconds?: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  occurredAt: Date | null;
};

const recordingStatusByEvent: Record<string, TelnyxRecordingEvent['status']> = {
  'recording.pending': 'PENDING',
  'recording.saved': 'COMPLETED',
  'recording.completed': 'COMPLETED',
  'recording.failed': 'FAILED',
};

export function parseTelnyxRecordingEvent(event: TelnyxWebhookEvent): TelnyxRecordingEvent | null {
  if (!event.eventType.startsWith('recording.')) return null;
  const payload = event.payload;
  const providerCallId = [payload.call_control_id, payload.call_id, payload.id].find((value): value is string => typeof value === 'string' && value.length > 0);
  const providerRecordingId = [payload.recording_id, payload.id].find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!providerCallId || !providerRecordingId) return null;
  const status = recordingStatusByEvent[event.eventType] || (typeof payload.status === 'string' ? payload.status.toUpperCase() as TelnyxRecordingEvent['status'] : 'PENDING');
  const storageUrl = typeof payload.recording_url === 'string' ? payload.recording_url : typeof payload.url === 'string' ? payload.url : undefined;
  const durationSeconds = typeof payload.duration_seconds === 'number' ? payload.duration_seconds : typeof payload.duration === 'number' ? payload.duration :
    typeof payload.duration_seconds === 'string' && payload.duration_seconds.trim().length > 0 ? Number.parseInt(payload.duration_seconds, 10) : undefined;
  return { providerCallId, providerRecordingId, storageUrl, durationSeconds, status, occurredAt: event.occurredAt };
}

export function parseTelnyxInboundSms(event: TelnyxWebhookEvent): TelnyxInboundSms | null {
  if (event.eventType !== 'message.received') return null;
  const payload = event.payload;
  const providerMessageId = typeof payload.id === 'string' && payload.id ? payload.id : event.externalEventId;
  const fromNumber = firstPhoneNumber(payload.from);
  const toNumber = firstPhoneNumber(payload.to);
  const body = typeof payload.text === 'string' ? payload.text : typeof payload.body === 'string' ? payload.body : '';
  if (!fromNumber || !toNumber || !body && !Array.isArray(payload.media)) return null;
  return {
    providerMessageId,
    fromNumber,
    toNumber,
    body,
    occurredAt: event.occurredAt,
    media: Array.isArray(payload.media) ? payload.media : [],
  };
}