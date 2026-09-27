export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

export function verifyWebhookSignature(signature: string | undefined, expectedSecret: string): WebhookVerificationResult {
  if (!signature || !expectedSecret) {
    return { valid: false, reason: 'Missing signature or secret' };
  }

  const match = signature === expectedSecret || signature.startsWith('sha256=');
  return match ? { valid: true } : { valid: false, reason: 'Invalid signature' };
}
