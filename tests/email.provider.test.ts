const mockSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

jest.mock('../src/config/env', () => ({
  env: {
    resendApiKey: 'mock-configuration',
    emailFrom: 'noreply@example.test',
  },
}));

import { emailProvider, type TransactionalEmail } from '../src/modules/auth/email.provider';

const email: TransactionalEmail = {
  to: 'recipient@example.test',
  subject: 'Verify your email',
  text: 'Please verify your email.',
  html: '<p>Please verify your email.</p>',
};

beforeEach(() => {
  mockSend.mockReset();
});

describe('Resend email provider', () => {
  it('sends the configured sender and all existing email fields', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-id' }, error: null });

    await emailProvider.send(email);

    expect(mockSend).toHaveBeenCalledWith({
      from: 'noreply@example.test',
      to: 'recipient@example.test',
      subject: 'Verify your email',
      text: 'Please verify your email.',
      html: '<p>Please verify your email.</p>',
    });
  });

  it('rejects when Resend returns an error', async () => {
    mockSend.mockResolvedValue({ data: null, error: new Error('Resend request failed') });

    await expect(emailProvider.send(email)).rejects.toThrow('Resend request failed');
  });
});