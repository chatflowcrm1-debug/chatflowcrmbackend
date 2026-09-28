import { MockTelecomProvider } from './providers/MockTelecomProvider';
import { TelnyxTelecomProvider } from './providers/TelnyxTelecomProvider';
import { TelecomProvider } from './telecom.types';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { logger } from '../../utils/logger';

export const TELNYX_PROVIDER = 'telnyx';

export function normalizeTelecomNumber(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

export async function resolveTelecomOrganization(input: { providerNumberId?: string; phoneNumber?: string }) {
  const normalizedPhoneNumber = input.phoneNumber ? normalizeTelecomNumber(input.phoneNumber) : '';
  async function resolveBy(where: { providerNumberId?: string; phoneNumber?: string }) {
    const matches = await prisma.phoneNumber.findMany({
      where: { provider: TELNYX_PROVIDER, status: 'ACTIVE', ...where },
      select: { organizationId: true, id: true },
    });
    if (matches.length > 1) {
      logger.warn('Ambiguous Telnyx phone-number organization resolution', {
        provider: TELNYX_PROVIDER,
        lookup: where.providerNumberId ? 'providerNumberId' : 'phoneNumber',
        matchCount: matches.length,
      });
      return { number: null, ambiguous: true };
    }
    return { number: matches[0] || null, ambiguous: false };
  }

  if (input.providerNumberId) {
    const byProviderId = await resolveBy({ providerNumberId: input.providerNumberId });
    if (byProviderId.ambiguous || byProviderId.number || !normalizedPhoneNumber) return byProviderId.number;
  }

  return normalizedPhoneNumber ? (await resolveBy({ phoneNumber: normalizedPhoneNumber })).number : null;
}

export function getOutboundVoiceConfigurationError(providerName = getTelecomProviderName(), connectionId = env.telnyxConnectionId) {
  if (providerName === TELNYX_PROVIDER && !connectionId.trim()) {
    return 'Telnyx outbound voice requires TELNYX_CONNECTION_ID';
  }
  return null;
}

export function getTelecomProvider(): TelecomProvider {
  const provider = getTelecomProviderName();
  if (provider === 'mock') return new MockTelecomProvider();
  if (provider === 'telnyx') {
    const apiKey = (process.env.TELNYX_API_KEY || env.telnyxApiKey).trim();
    if (!apiKey) throw new Error('Telnyx provider requires TELNYX_API_KEY');
    return new TelnyxTelecomProvider(apiKey, process.env.TELNYX_CONNECTION_ID || env.telnyxConnectionId || undefined, undefined, env.telnyxRequestTimeoutMs);
  }
  throw new Error(`Unsupported telecom provider: ${provider}`);
}

export function getTelecomProviderName() {
  return (process.env.TELECOM_PROVIDER || env.telecomProvider).trim().toLowerCase();
}
