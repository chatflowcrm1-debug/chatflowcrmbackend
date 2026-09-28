import { env } from '../../../config/env';
import { SendMessagePayload, WhatsAppProvider } from './WhatsAppProvider';

export class MetaWhatsAppProvider implements WhatsAppProvider {
  async sendMessage(payload: SendMessagePayload) {
    if (!env.metaAppId || !env.whatsappAccessToken) {
      return {
        success: false,
        error: 'Meta WhatsApp credentials not configured',
      };
    }

    return {
      success: true,
      providerMessageId: `meta-${Date.now()}`,
      ...(payload.template ? { template: payload.template } : {}),
    };
  }

  verifyWebhook(signature: string, payload: unknown) {
    if (!env.whatsappVerifyToken) {
      return false;
    }

    if (!signature) {
      return false;
    }

    void payload;
    return signature.length > 0;
  }

  async handleIncomingWebhook(_payload: unknown) {
    return;
  }

  async getConnectionStatus() {
    return env.whatsappAccessToken ? 'CONNECTED' : 'DISCONNECTED';
  }
}
