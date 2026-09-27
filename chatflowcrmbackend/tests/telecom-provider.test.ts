import { getOutboundVoiceConfigurationError, getTelecomProvider, getTelecomProviderName } from '../src/modules/telecom/telecom.service';
import { MockTelecomProvider } from '../src/modules/telecom/providers/MockTelecomProvider';
import { TelnyxTelecomProvider } from '../src/modules/telecom/providers/TelnyxTelecomProvider';

describe('telecom provider selection', () => {
  const originalProvider = process.env.TELECOM_PROVIDER;
  const originalKey = process.env.TELNYX_API_KEY;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.TELECOM_PROVIDER;
    else process.env.TELECOM_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalKey;
  });

  it('normalizes the configured provider and preserves mock behavior', async () => {
    process.env.TELECOM_PROVIDER = ' MOCK ';
    expect(getTelecomProviderName()).toBe('mock');
    const provider = getTelecomProvider();
    expect(provider).toBeInstanceOf(MockTelecomProvider);
    await expect(provider.sendSMS({ fromNumber: '+1', toNumber: '+2', body: 'hello' })).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('requires a Telnyx API key when Telnyx is selected', () => {
    process.env.TELECOM_PROVIDER = ' TELNYX ';
    delete process.env.TELNYX_API_KEY;
    expect(() => getTelecomProvider()).toThrow('Telnyx provider requires TELNYX_API_KEY');
  });

  it('keeps the mock inventory token separate from each allocated number ID', async () => {
    const provider = new MockTelecomProvider();
    const available = await provider.searchNumbers({ country: 'US', numberType: 'LOCAL' });
    const first = await provider.purchaseNumber(available[0].providerNumberId);
    const second = await provider.purchaseNumber(available[0].providerNumberId);

    expect(available[0].providerNumberId).toBe('mock-us-212-local');
    expect(first.providerNumberId).toMatch(/^mock-allocation-/);
    expect(second.providerNumberId).toMatch(/^mock-allocation-/);
    expect(first.providerNumberId).not.toBe(available[0].providerNumberId);
    expect(first.providerNumberId).not.toBe(second.providerNumberId);
    await expect(provider.releaseNumber(first.providerNumberId)).resolves.toBeUndefined();
  });

  it('requires a connection ID only for Telnyx outbound voice', () => {
    expect(getOutboundVoiceConfigurationError('telnyx', '')).toBe('Telnyx outbound voice requires TELNYX_CONNECTION_ID');
    expect(getOutboundVoiceConfigurationError('telnyx', 'connection-1')).toBeNull();
    expect(getOutboundVoiceConfigurationError('mock', '')).toBeNull();
  });

  it('persists a stable Telnyx resource ID when the purchase response includes one', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify({ data: { phone_numbers: [{ id: 'telnyx-number-1', phone_number: '+15551234567', country_code: 'US', type: 'local', area_code: '212' }] } }), { status: 200 }));
    const provider = new TelnyxTelecomProvider('test-key', undefined, fetcher as typeof fetch);

    await expect(provider.purchaseNumber('+15551234567')).resolves.toMatchObject({
      providerNumberId: 'telnyx-number-1',
      phoneNumber: '+15551234567',
    });
  });

  it('falls back to the E.164 number only when Telnyx omits a resource ID', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify({ data: { phone_numbers: [{ phone_number: '+15551234567', country_code: 'US' }] } }), { status: 200 }));
    const provider = new TelnyxTelecomProvider('test-key', undefined, fetcher as typeof fetch);

    await expect(provider.purchaseNumber('+15551234567')).resolves.toMatchObject({
      providerNumberId: '+15551234567',
      phoneNumber: '+15551234567',
    });
  });

  it('uses Telnyx call-control actions without contacting the real API', async () => {
    const requests: Array<{ path: string; method?: string }> = [];
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      requests.push({ path: new URL(url).pathname, method: init?.method });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    const provider = new TelnyxTelecomProvider('test-key', 'connection-1', fetcher as typeof fetch);
    await provider.answerCall('call-1');
    await provider.declineCall('call-1');
    await provider.hangupCall('call-1');
    expect(requests).toEqual([
      { path: '/v2/calls/call-1/actions/answer', method: 'POST' },
      { path: '/v2/calls/call-1/actions/reject', method: 'POST' },
      { path: '/v2/calls/call-1/actions/hangup', method: 'POST' },
    ]);
  });

  it('rejects outbound voice before the provider request when connection ID is missing', async () => {
    const fetcher = jest.fn();
    const provider = new TelnyxTelecomProvider('test-key', undefined, fetcher as typeof fetch);

    await expect(provider.makeCall({ fromNumber: '+15551234567', toNumber: '+15557654321' })).rejects.toThrow('Telnyx outbound voice requires TELNYX_CONNECTION_ID');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('includes the configured connection ID in outbound voice requests', async () => {
    const fetcher = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ connection_id: 'connection-1' });
      return new Response(JSON.stringify({ data: { call_control_id: 'call-1' } }), { status: 200 });
    });
    const provider = new TelnyxTelecomProvider('test-key', 'connection-1', fetcher as typeof fetch);

    await expect(provider.makeCall({ fromNumber: '+15551234567', toNumber: '+15557654321' })).resolves.toMatchObject({ providerCallId: 'call-1' });
  });

  it('aborts a Telnyx request after the configured timeout', async () => {
    const fetcher = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const provider = new TelnyxTelecomProvider('test-key', undefined, fetcher as typeof fetch, 5);
    await expect(provider.sendSMS({ fromNumber: '+1', toNumber: '+2', body: 'hello' })).rejects.toThrow('Telnyx request timed out');
  });
});
