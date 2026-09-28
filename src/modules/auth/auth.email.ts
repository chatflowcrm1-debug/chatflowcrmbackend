import { env } from '../../config/env';
import { emailProvider } from './email.provider';

function link(path: string, token: string) {
  return `${env.appUrl}${path}?token=${encodeURIComponent(token)}`;
}

export function sendVerificationEmail(email: string, token: string) {
  const verificationLink = link('/verify-email', token);
  return emailProvider.send({
    to: email,
    subject: 'Verify your ChatFlow CRM email',
    text: `Verify your ChatFlow CRM email by visiting ${verificationLink}. This link expires in 24 hours.`,
    html: `<p>Welcome to ChatFlow CRM.</p><p><a href="${verificationLink}">Verify your email</a></p><p>This link expires in 24 hours. Contact support if you need help.</p>`,
  });
}

export function sendPasswordResetEmail(email: string, token: string) {
  const resetLink = link('/reset-password', token);
  return emailProvider.send({
    to: email,
    subject: 'Reset your ChatFlow CRM password',
    text: `Reset your ChatFlow CRM password by visiting ${resetLink}. This link expires in 1 hour.`,
    html: `<p>A password reset was requested for your ChatFlow CRM account.</p><p><a href="${resetLink}">Reset your password</a></p><p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>`,
  });
}