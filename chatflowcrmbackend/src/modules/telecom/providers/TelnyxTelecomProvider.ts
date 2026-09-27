import {
  AvailableNumber,
  MakeCallInput,
  NumberSearchInput,
  PurchasedNumber,
  SendSmsInput,
  TelecomProvider,
} from '../telecom.types';

const API_BASE = 'https://api.telnyx.com/v2';
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

type TelnyxResponse = Record<string, unknown>;

export class TelnyxTelecomProvider implements TelecomProvider {
  constructor(
    private readonly apiKey: string,
    private readonly connectionId?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<TelnyxResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
      const body = await response.json().catch(() => ({})) as TelnyxResponse;
      if (!response.ok) {
        const errors = body.errors as Array<{ detail?: string }> | undefined;
        const error = body.error as { message?: string } | undefined;
        const detail = errors?.[0]?.detail || error?.message || `HTTP ${response.status}`;
        throw new Error(`Telnyx request failed: ${detail}`);
      }
      return body;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Telnyx request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async searchNumbers(input: NumberSearchInput): Promise<AvailableNumber[]> {
    const params = new URLSearchParams();
    params.set('filter[country_code]', input.country);
    if (input.numberType) params.set('filter[type]', input.numberType.toLowerCase());
    if (input.areaCode) params.set('filter[locality]', input.areaCode);
    if (input.capabilities?.length) params.set('filter[features]', input.capabilities.join(','));
    const body = await this.request(`/available_phone_numbers?${params.toString()}`);
    const data = Array.isArray(body.data) ? body.data as Array<Record<string, unknown>> : [];
    return data.map((item) => ({
      providerNumberId: String(item.phone_number),
      phoneNumber: String(item.phone_number),
      country: typeof item.country_code === 'string' ? item.country_code : input.country,
      numberType: String(item.type || input.numberType || 'LOCAL').toUpperCase() as AvailableNumber['numberType'],
      areaCode: typeof item.area_code === 'string' ? item.area_code : undefined,
      capabilities: input.capabilities || ['voice', 'sms'],
    }));
  }

  async purchaseNumber(providerNumberId: string): Promise<PurchasedNumber> {
    const body = await this.request('/number_orders', {
      method: 'POST',
      body: JSON.stringify({ phone_numbers: [{ phone_number: providerNumberId }], ...(this.connectionId ? { connection_id: this.connectionId } : {}) }),
    });
    const data = body.data as Record<string, unknown> | undefined;
    const phoneNumbers = data?.phone_numbers as Array<Record<string, unknown>> | undefined;
    const item = phoneNumbers?.[0] || data;
    if (!item || typeof item.phone_number !== 'string') throw new Error('Telnyx did not return the purchased number');
    const persistedProviderNumberId = typeof item.id === 'string' && item.id.length > 0 ? item.id : item.phone_number;
    return {
      providerNumberId: persistedProviderNumberId,
      phoneNumber: item.phone_number,
      country: typeof item.country_code === 'string' ? item.country_code : 'US',
      numberType: String(item.type || 'LOCAL').toUpperCase() as PurchasedNumber['numberType'],
      areaCode: typeof item.area_code === 'string' ? item.area_code : undefined,
      capabilities: ['voice', 'sms'],
      status: 'ACTIVE',
    };
  }

  async releaseNumber(providerNumberId: string): Promise<void> {
    await this.request(`/phone_numbers/${encodeURIComponent(providerNumberId)}`, { method: 'DELETE' });
  }

  async makeCall(input: MakeCallInput) {
    if (!this.connectionId?.trim()) throw new Error('Telnyx outbound voice requires TELNYX_CONNECTION_ID');
    const body = await this.request('/calls', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: this.connectionId,
        from: input.fromNumber,
        to: input.toNumber,
        ...(input.recordingEnabled ? { record: 'record-from-answer' } : {}),
      }),
    });
    const call = body.data as Record<string, unknown> | undefined;
    if (!call || typeof call.call_control_id !== 'string') throw new Error('Telnyx did not return a call identifier');
    return { providerCallId: call.call_control_id, status: 'INITIATED' };
  }

  async hangupCall(providerCallId: string): Promise<void> {
    await this.request(`/calls/${encodeURIComponent(providerCallId)}/actions/hangup`, { method: 'POST', body: '{}' });
  }

  async answerCall(providerCallId: string): Promise<void> {
    await this.request(`/calls/${encodeURIComponent(providerCallId)}/actions/answer`, { method: 'POST', body: '{}' });
  }

  async declineCall(providerCallId: string): Promise<void> {
    await this.request(`/calls/${encodeURIComponent(providerCallId)}/actions/reject`, { method: 'POST', body: '{}' });
  }

  async sendSMS(input: SendSmsInput) {
    const body = await this.request('/messages', {
      method: 'POST',
      body: JSON.stringify({ from: input.fromNumber, to: input.toNumber, text: input.body, ...(this.connectionId ? { connection_id: this.connectionId } : {}) }),
    });
    const message = body.data as Record<string, unknown> | undefined;
    if (!message || typeof message.id !== 'string') throw new Error('Telnyx did not return a message identifier');
    return { providerMessageId: message.id, status: 'QUEUED' };
  }
}
