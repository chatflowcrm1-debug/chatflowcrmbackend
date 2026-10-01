import { Resend } from 'resend';
import { env } from '../../config/env';

export type TransactionalEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface EmailProvider {
  send(email: TransactionalEmail): Promise<void>;
}

class ResendEmailProvider implements EmailProvider {
  private client?: Resend;

  private getClient() {
    if (!this.client) this.client = new Resend(env.resendApiKey);
    return this.client;
  }

  async send(email: TransactionalEmail) {
    if (!env.resendApiKey || !env.emailFrom) {
      throw new Error('Resend email provider is not configured');
    }
    const { error } = await this.getClient().emails.send({ from: env.emailFrom, ...email });
    if (error) throw error;
  }
}

export const emailProvider: EmailProvider = new ResendEmailProvider();