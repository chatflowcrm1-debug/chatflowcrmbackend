import { SendMessagePayload, WhatsAppProvider } from './WhatsAppProvider';

export class MockWhatsAppProvider implements WhatsAppProvider {
  async sendMessage(payload: SendMessagePayload) {
    return {
      success: true,
      providerMessageId: `mock-${Date.now()}`,
      // This mock provider is intentionally isolated and safe for local development only.
    };
  }

  verifyWebhook(_signature: string, _payload: unknown) {
    return true;
  }

  async handleIncomingWebhook(_payload: unknown) {
    return;
  }

  async getConnectionStatus(): Promise<'CONNECTED' | 'DISCONNECTED' | 'ERROR'> {
    return 'DISCONNECTED';
  }
}
