export interface SendMessagePayload {
  to: string;
  content: string;
  template?: string;
  mediaUrl?: string;
}

export interface WhatsAppProvider {
  sendMessage(payload: SendMessagePayload): Promise<{ success: boolean; providerMessageId?: string; error?: string }>;
  verifyWebhook(signature: string, payload: unknown): boolean;
  handleIncomingWebhook(payload: unknown): Promise<void>;
  getConnectionStatus(): Promise<'CONNECTED' | 'DISCONNECTED' | 'ERROR'>;
}
