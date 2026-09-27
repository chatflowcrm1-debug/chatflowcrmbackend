import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { hashPassword, hashRefreshToken } from '../src/modules/auth/auth.service';
import { sendPasswordResetEmail, sendVerificationEmail } from '../src/modules/auth/auth.email';

const user = {
  id: 'user-1',
  email: 'user@example.com',
  firstName: 'Test',
  lastName: 'User',
  passwordHash: '',
  isActive: true,
  isEmailVerified: false,
  organization: { id: 'org-1', name: 'Test Org' },
  memberships: [{ organizationId: 'org-1', role: 'OWNER', isActive: true }],
};
const verificationTokens = new Map<string, any>();
const resetTokens = new Map<string, any>();
const refreshSessions = [{ userId: user.id, revokedAt: null }];
const sentVerificationTokens: string[] = [];
const sentResetTokens: string[] = [];
let allowExistingUser = true;

const prismaMock: any = {
  user: {
    findUnique: jest.fn(async ({ where }: any) => {
      if (where.email && (!allowExistingUser || where.email !== user.email)) return null;
      if (where.id && where.id !== user.id) return null;
      return user;
    }),
    create: jest.fn(async () => user),
    update: jest.fn(async ({ data }: any) => Object.assign(user, data)),
  },
  organizationMember: { create: jest.fn() },
  refreshSession: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(async ({ data }: any) => { refreshSessions.forEach((session) => Object.assign(session, data)); return { count: refreshSessions.length }; }),
  },
  emailVerificationToken: {
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const record of verificationTokens.values()) {
        if (where.tokenHash && record.tokenHash !== where.tokenHash) continue;
        if (where.userId && record.userId !== where.userId) continue;
        if (where.consumedAt === null && record.consumedAt !== null) continue;
        if (where.expiresAt?.gt && record.expiresAt <= where.expiresAt.gt) continue;
        Object.assign(record, data);
        count += 1;
      }
      return { count };
    }),
    create: jest.fn(async ({ data }: any) => { const record = { id: `verification-${verificationTokens.size}`, ...data, consumedAt: null }; verificationTokens.set(data.tokenHash, record); return record; }),
    findUnique: jest.fn(async ({ where }: any) => verificationTokens.get(where.tokenHash) || null),
    update: jest.fn(async ({ where, data }: any) => { const record = [...verificationTokens.values()].find((candidate) => candidate.id === where.id); Object.assign(record, data); return record; }),
  },
  passwordResetToken: {
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const record of resetTokens.values()) {
        if (where.tokenHash && record.tokenHash !== where.tokenHash) continue;
        if (where.userId && record.userId !== where.userId) continue;
        if (where.consumedAt === null && record.consumedAt !== null) continue;
        if (where.expiresAt?.gt && record.expiresAt <= where.expiresAt.gt) continue;
        Object.assign(record, data);
        count += 1;
      }
      return { count };
    }),
    create: jest.fn(async ({ data }: any) => { const record = { id: `reset-${resetTokens.size}`, ...data, consumedAt: null }; resetTokens.set(data.tokenHash, record); return record; }),
    findUnique: jest.fn(async ({ where }: any) => resetTokens.get(where.tokenHash) || null),
    update: jest.fn(async ({ where, data }: any) => { const record = [...resetTokens.values()].find((candidate) => candidate.id === where.id); Object.assign(record, data); return record; }),
  },
  $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(prismaMock)),
};

jest.mock('../src/db/prisma', () => ({ prisma: prismaMock }));
jest.mock('../src/modules/auth/auth.email', () => ({
  sendVerificationEmail: jest.fn(async (_email: string, token: string) => { sentVerificationTokens.push(token); }),
  sendPasswordResetEmail: jest.fn(async (_email: string, token: string) => { sentResetTokens.push(token); }),
}));

import authRoutes from '../src/modules/auth/auth.routes';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/api/auth', authRoutes);
let testIp = 1;

async function request(path: string, body: unknown) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${testIp}` }, body: JSON.stringify(body) });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

beforeEach(() => {
  testIp += 1;
  user.isEmailVerified = false;
  verificationTokens.clear();
  resetTokens.clear();
  sentVerificationTokens.length = 0;
  sentResetTokens.length = 0;
  refreshSessions[0].revokedAt = null;
  allowExistingUser = true;
  jest.clearAllMocks();
});

beforeAll(async () => {
  user.passwordHash = await hashPassword('password-123');
});

describe('Phase 1B email verification and password reset', () => {
  it('registers an unverified user and sends a high-entropy token hash, not the raw token', async () => {
    allowExistingUser = false;
    const response = await request('/api/auth/register', { email: user.email, password: 'password-123', firstName: 'Test', lastName: 'User', organizationName: 'Test Org' });
    expect(response.status).toBe(201);
    expect(user.isEmailVerified).toBe(false);
    expect(sentVerificationTokens).toHaveLength(1);
    expect(sentVerificationTokens[0]).toHaveLength(64);
    expect(verificationTokens.has(hashRefreshToken(sentVerificationTokens[0]))).toBe(true);
    expect([...verificationTokens.values()][0].tokenHash).not.toBe(sentVerificationTokens[0]);
  });

  it('verifies a valid token once and rejects reuse, expiry, and random tokens', async () => {
    allowExistingUser = false;
    await request('/api/auth/register', { email: user.email, password: 'password-123', firstName: 'Test', lastName: 'User', organizationName: 'Test Org' });
    const token = sentVerificationTokens[0];
    expect((await request('/api/auth/verify-email', { token })).status).toBe(200);
    expect(user.isEmailVerified).toBe(true);
    expect((await request('/api/auth/verify-email', { token })).status).toBe(400);
    expect((await request('/api/auth/verify-email', { token: 'random-token' })).status).toBe(400);
    const expiredToken = 'expired-token';
    verificationTokens.set(hashRefreshToken(expiredToken), { id: 'expired', userId: user.id, tokenHash: hashRefreshToken(expiredToken), expiresAt: new Date('2020-01-01'), consumedAt: null });
    expect((await request('/api/auth/verify-email', { token: expiredToken })).status).toBe(400);
  });

  it('allows only one concurrent verification claim', async () => {
    allowExistingUser = false;
    await request('/api/auth/register', { email: user.email, password: 'password-123', firstName: 'Test', lastName: 'User', organizationName: 'Test Org' });
    const token = sentVerificationTokens[0];
    const results = await Promise.all([
      request('/api/auth/verify-email', { token }),
      request('/api/auth/verify-email', { token }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  });

  it('blocks unverified login and permits verified login', async () => {
    const blocked = await request('/api/auth/login', { email: user.email, password: 'password-123' });
    expect(blocked.status).toBe(403);
    user.isEmailVerified = true;
    const allowed = await request('/api/auth/login', { email: user.email, password: 'password-123' });
    expect(allowed.status).toBe(200);
  });

  it('resends verification with a new token and invalidates the old one', async () => {
    const first = 'first-verification-token';
    verificationTokens.set(hashRefreshToken(first), { id: 'first', userId: user.id, tokenHash: hashRefreshToken(first), expiresAt: new Date('2099-01-01'), consumedAt: null });
    sentVerificationTokens.push(first);
    await request('/api/auth/resend-verification', { email: user.email });
    expect(sentVerificationTokens[1]).not.toBe(first);
    expect(verificationTokens.get(hashRefreshToken(first)).consumedAt).toBeTruthy();
  });

  it('returns a generic response for unknown password-reset emails', async () => {
    const known = await request('/api/auth/forgot-password', { email: user.email });
    const unknown = await request('/api/auth/forgot-password', { email: 'unknown@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it('keeps registration unverified and reports unavailable delivery without exposing provider errors', async () => {
    allowExistingUser = false;
    (sendVerificationEmail as jest.Mock).mockRejectedValueOnce(new Error('SMTP credentials must not be exposed'));
    const response = await request('/api/auth/register', { email: user.email, password: 'password-123', firstName: 'Test', lastName: 'User', organizationName: 'Test Org' });
    const payload = await response.json() as { message: string };
    expect(response.status).toBe(201);
    expect(payload.message).toContain('delivery is temporarily unavailable');
    expect(payload.message).not.toContain('SMTP');
    expect(user.isEmailVerified).toBe(false);
  });

  it('keeps forgot-password responses generic when delivery fails', async () => {
    (sendPasswordResetEmail as jest.Mock).mockRejectedValueOnce(new Error('provider failure details'));
    const response = await request('/api/auth/forgot-password', { email: user.email });
    const payload = await response.json() as { message: string };
    expect(response.status).toBe(200);
    expect(payload.message).toBe('If an account exists for that email, password reset instructions have been sent.');
    expect(JSON.stringify(payload)).not.toContain('provider failure details');
  });

  it('resets the password once and revokes existing refresh sessions', async () => {
    await request('/api/auth/forgot-password', { email: user.email });
    const token = sentResetTokens[0];
    expect(resetTokens.has(hashRefreshToken(token))).toBe(true);
    expect((await request('/api/auth/reset-password', { token, password: 'new-password-123' })).status).toBe(200);
    expect(refreshSessions[0].revokedAt).toBeTruthy();
    expect((await request('/api/auth/reset-password', { token, password: 'another-password-123' })).status).toBe(400);
  });

  it('rate-limits repeated refresh requests', async () => {
    const results = await Promise.all(Array.from({ length: 31 }, () => request('/api/auth/refresh', { refreshToken: 'invalid-refresh-token' })));
    expect(results.filter((response) => response.status === 429)).toHaveLength(1);
  });
});
