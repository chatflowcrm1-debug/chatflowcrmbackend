import nodemailer from 'nodemailer';
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

class SmtpEmailProvider implements EmailProvider {
  private readonly transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPassword } : undefined,
  });

  async send(email: TransactionalEmail) {
    if (!env.smtpHost || !env.emailFrom) {
      throw new Error('SMTP email provider is not configured');
    }
    await this.transporter.sendMail({ from: env.emailFrom, ...email });
  }
}

export const emailProvider: EmailProvider = new SmtpEmailProvider();