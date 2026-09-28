import crypto from 'crypto';
import { verifyWebhookSignature } from '../src/modules/whatsapp/whatsapp.routes';
import { MockWhatsAppProvider } from '../src/modules/whatsapp/providers/MockWhatsAppProvider';

describe('Inbox WhatsApp foundation', () => {
  it('accepts an HMAC webhook signature and rejects tampered payloads', () => {
    const payload = JSON.stringify({ eventId: 'event-1', text: 'hello' });
    const secret = 'test-webhook-secret';
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(`${payload}!`, signature, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, undefined, secret)).toBe(false);
  });

  it('keeps Mock provider delivery explicitly identifiable', async () => {
    const result = await new MockWhatsAppProvider().sendMessage({ to: 'contact-1', content: 'hello' });

    expect(result.success).toBe(true);
    expect(result.providerMessageId).toMatch(/^mock-/);
  });
});