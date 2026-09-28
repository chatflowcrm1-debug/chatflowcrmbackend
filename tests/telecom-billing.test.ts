import { prisma } from '../src/db/prisma';
import { recordCommercialUsageForTransaction } from '../src/modules/billing/billing.service';
import { maybeRecordPhoneNumberUsage, maybeRecordSmsUsage, maybeRecordVoiceUsage } from '../src/modules/telecom/telecom.usage';

jest.mock('../src/db/prisma', () => ({
  prisma: {
    telecomMessage: { findUnique: jest.fn() },
    telecomCall: { findUnique: jest.fn() },
    phoneNumber: { findUnique: jest.fn() },
  },
}));

jest.mock('../src/modules/billing/billing.service', () => ({
  ...jest.requireActual('../src/modules/billing/billing.service'),
  recordCommercialUsageForTransaction: jest.fn(),
}));

describe('telecom billing usage integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records SMS usage once for a successful outbound message status', async () => {
    (prisma.telecomMessage.findUnique as jest.Mock).mockResolvedValue({
      id: 'message-1',
      organizationId: 'org-a',
      provider: 'TELNYX',
      direction: 'OUTBOUND',
      status: 'DELIVERED',
      providerMessageId: 'provider-message-1',
    });
    (recordCommercialUsageForTransaction as jest.Mock).mockResolvedValue({ duplicate: false, record: { id: 'usage-1' } });

    const result = await maybeRecordSmsUsage('org-a', 'message-1', 'DELIVERED');

    expect(result).toEqual({ duplicate: false, record: { id: 'usage-1' } });
    expect(recordCommercialUsageForTransaction).toHaveBeenCalledWith(
      'org-a',
      expect.objectContaining({
        category: 'SMS',
        quantity: 1,
        telecomMessageId: 'message-1',
        sourceType: 'TelecomMessage',
        idempotencyKey: 'telecom:sms:org-a:message-1:DELIVERED',
      }),
      undefined,
    );
  });

  it('records voice usage with whole-minute billing for completed calls', async () => {
    (prisma.telecomCall.findUnique as jest.Mock).mockResolvedValue({
      id: 'call-1',
      organizationId: 'org-a',
      provider: 'TELNYX',
      durationSeconds: 61,
      status: 'COMPLETED',
    });
    (recordCommercialUsageForTransaction as jest.Mock).mockResolvedValue({ duplicate: false, record: { id: 'usage-2' } });

    const result = await maybeRecordVoiceUsage('org-a', 'call-1');

    expect(result).toEqual({ duplicate: false, record: { id: 'usage-2' } });
    expect(recordCommercialUsageForTransaction).toHaveBeenCalledWith(
      'org-a',
      expect.objectContaining({
        category: 'VOICE_MINUTE',
        quantity: 2,
        telecomCallId: 'call-1',
        sourceType: 'TelecomCall',
        idempotencyKey: 'telecom:voice:org-a:call-1',
      }),
      undefined,
    );
  });

  it('records a purchased phone number once for the owning organization', async () => {
    (prisma.phoneNumber.findUnique as jest.Mock).mockResolvedValue({
      id: 'number-1',
      organizationId: 'org-a',
      provider: 'TELNYX',
      providerNumberId: 'telnyx-number-1',
      phoneNumber: '+15551234567',
    });
    (recordCommercialUsageForTransaction as jest.Mock).mockResolvedValue({ duplicate: false, record: { id: 'usage-3' } });

    const result = await maybeRecordPhoneNumberUsage('org-a', 'number-1');

    expect(result).toEqual({ duplicate: false, record: { id: 'usage-3' } });
    expect(recordCommercialUsageForTransaction).toHaveBeenCalledWith(
      'org-a',
      expect.objectContaining({
        category: 'PHONE_NUMBER',
        quantity: 1,
        sourceType: 'PhoneNumber',
        sourceId: 'number-1',
        idempotencyKey: 'telecom:phone-number:org-a:number-1',
      }),
      undefined,
    );
  });
});
