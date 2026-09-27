import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { env } from '../src/config/env';
import { hashPassword, hashRefreshToken, isRefreshSessionUsable, signJwt, signRefreshToken } from '../src/modules/auth/auth.service';

type Session = {
  id: string;
  userId: string;
  organizationId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBySessionId: string | null;
};

const sessions = new Map<string, Session>();
let sessionSequence = 0;
const users = new Map([
  ['user-a', { id: 'user-a', email: 'a@example.com', firstName: 'User', lastName: 'A', passwordHash: '', isActive: true, isEmailVerified: true, memberships: [{ organizationId: 'org-a', role: 'OWNER', isActive: true }] }],
  ['user-b', { id: 'user-b', email: 'b@example.com', firstName: 'User', lastName: 'B', passwordHash: '', isActive: true, isEmailVerified: true, memberships: [{ organizationId: 'org-b', role: 'OWNER', isActive: true }] }],
]);

const prismaMock: any = {
  user: {
    findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
      const user = where.id ? users.get(where.id) : [...users.values()].find((candidate) => candidate.email === where.email);
      return user ? { ...user, organization: { id: user.memberships[0].organizationId, name: 'Test Organization' } } : null;
    }),
    update: jest.fn(),
  },
  organizationMember: { create: jest.fn() },
  refreshSession: {
    create: jest.fn(async ({ data }: { data: Omit<Session, 'id' | 'revokedAt' | 'replacedBySessionId'> }) => {
      const session = { ...data, id: `session-${++sessionSequence}`, revokedAt: null, replacedBySessionId: null };
      sessions.set(session.tokenHash, session);
      return session;
    }),
    findUnique: jest.fn(async ({ where }: { where: { tokenHash?: string; id?: string } }) => {
      if (where.tokenHash) return sessions.get(where.tokenHash) || null;
      return [...sessions.values()].find((session) => session.id === where.id) || null;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => {
      const session = [...sessions.values()].find((candidate) => candidate.id === where.id);
      if (!session) throw new Error('Session not found');
      Object.assign(session, data);
      return session;
    }),
    updateMany: jest.fn(),
  },
  emailVerificationToken: { updateMany: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  passwordResetToken: { updateMany: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(async (callback: (transactionClient: any) => Promise<unknown>) => callback(prismaMock)),
};

jest.mock('../src/db/prisma', () => ({ prisma: prismaMock }));

import authRoutes from '../src/modules/auth/auth.routes';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

async function request(path: string, options: RequestInit = {}) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, options);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function login(email = 'a@example.com') {
  const response = await request('/api/auth/login', json({ email, password: 'password-123' }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ token: string; refreshToken: string; user: { organizationId: string } }>;
}

beforeAll(async () => {
  const passwordHash = await hashPassword('password-123');
  for (const user of users.values()) user.passwordHash = passwordHash;
});

beforeEach(() => {
  sessions.clear();
  sessionSequence = 0;
  jest.clearAllMocks();
});

describe('auth service', () => {
  it('signs a JWT for an authenticated user', () => {
    const token = signJwt({ id: 'user-1', email: 'owner@example.com', organizationId: 'org-1', role: 'OWNER', permissions: ['customers.read'] });
    expect(jwt.verify(token, env.jwtSecret)).toMatchObject({ id: 'user-1', organizationId: 'org-1', permissions: ['customers.read'] });
  });

  it('rejects expired or revoked session timestamps', () => {
    expect(isRefreshSessionUsable({ expiresAt: new Date('2020-01-01'), revokedAt: null, replacedBySessionId: null }, new Date('2021-01-01'))).toBe(false);
    expect(isRefreshSessionUsable({ expiresAt: new Date('2099-01-01'), revokedAt: new Date(), replacedBySessionId: null })).toBe(false);
  });
});

describe('refresh-token lifecycle', () => {
  it('returns new access and refresh tokens and preserves the original organization', async () => {
    const loginPayload = await login();
    const response = await request('/api/auth/refresh', json({ refreshToken: loginPayload.refreshToken }));
    const payload = await response.json() as { token: string; refreshToken: string; user: { organizationId: string } };
    expect(response.status).toBe(200);
    expect(payload.token).toEqual(expect.any(String));
    expect(payload.refreshToken).toEqual(expect.any(String));
    expect(payload.refreshToken).not.toBe(loginPayload.refreshToken);
    expect(payload.user.organizationId).toBe('org-a');
    expect(jwt.verify(payload.token, env.jwtSecret)).toMatchObject({ id: 'user-a', organizationId: 'org-a' });
  });

  it('rejects reuse of a rotated refresh token', async () => {
    const loginPayload = await login();
    expect((await request('/api/auth/refresh', json({ refreshToken: loginPayload.refreshToken }))).status).toBe(200);
    expect((await request('/api/auth/refresh', json({ refreshToken: loginPayload.refreshToken }))).status).toBe(401);
  });

  it('revokes the active session on logout', async () => {
    const loginPayload = await login();
    expect((await request('/api/auth/logout', json({ refreshToken: loginPayload.refreshToken }))).status).toBe(200);
    expect((await request('/api/auth/refresh', json({ refreshToken: loginPayload.refreshToken }))).status).toBe(401);
  });

  it.each(['malformed', 'random-refresh-token'])('rejects %s refresh tokens', async (refreshToken) => {
    expect((await request('/api/auth/refresh', json({ refreshToken }))).status).toBe(401);
  });

  it('rejects an expired persisted refresh session', async () => {
    const token = signRefreshToken({ id: 'user-a', email: 'a@example.com', organizationId: 'org-a', role: 'OWNER', permissions: [] });
    const tokenHash = hashRefreshToken(token);
    sessions.set(tokenHash, { id: 'expired-session', userId: 'user-a', organizationId: 'org-a', tokenHash, expiresAt: new Date('2020-01-01'), revokedAt: null, replacedBySessionId: null });
    expect((await request('/api/auth/refresh', json({ refreshToken: token }))).status).toBe(401);
  });

  it('rejects a user and organization mismatch against the persisted session', async () => {
    const token = signRefreshToken({ id: 'user-b', email: 'b@example.com', organizationId: 'org-b', role: 'OWNER', permissions: [] });
    const tokenHash = hashRefreshToken(token);
    sessions.set(tokenHash, { id: 'user-a-session', userId: 'user-a', organizationId: 'org-a', tokenHash, expiresAt: new Date('2099-01-01'), revokedAt: null, replacedBySessionId: null });
    expect((await request('/api/auth/refresh', json({ refreshToken: token }))).status).toBe(401);
  });

  it('does not allow a token claim to switch the authorized organization', async () => {
    const loginPayload = await login();
    const originalOrganizationId = (jwt.decode(loginPayload.refreshToken) as { organizationId: string }).organizationId;
    const response = await request('/api/auth/refresh', json({ refreshToken: loginPayload.refreshToken }));
    const payload = await response.json() as { token: string; user: { organizationId: string } };
    expect(payload.user.organizationId).toBe(originalOrganizationId);
    expect((jwt.verify(payload.token, env.jwtSecret) as { organizationId: string }).organizationId).toBe('org-a');
  });
});
