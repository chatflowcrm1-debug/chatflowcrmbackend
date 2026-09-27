import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AuthenticatedUser } from '../../types';

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function hashRefreshToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createOneTimeToken() {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return { rawToken, tokenHash: hashRefreshToken(rawToken) };
}

export function signJwt(user: AuthenticatedUser) {
  return jwt.sign(user, env.jwtSecret, { expiresIn: '1h' });
}

export function signRefreshToken(user: AuthenticatedUser) {
  return jwt.sign({ id: user.id, organizationId: user.organizationId }, env.jwtRefreshSecret, { expiresIn: '30d', jwtid: crypto.randomUUID() });
}

export function isRefreshSessionUsable(session: { expiresAt: Date | string; revokedAt: Date | string | null; replacedBySessionId: string | null } | null, now = new Date()) {
  if (!session) return false;
  if (session.revokedAt) return false;
  if (session.replacedBySessionId) return false;
  return new Date(session.expiresAt) > now;
}

export const DEFAULT_PERMISSIONS = {
  OWNER: ['customers.read', 'customers.write', 'conversations.read', 'conversations.write', 'leads.read', 'leads.write', 'reports.read', 'team.manage', 'settings.manage', 'billing.manage'],
  ADMIN: ['customers.read', 'customers.write', 'conversations.read', 'conversations.write', 'leads.read', 'leads.write', 'reports.read', 'team.manage', 'settings.manage', 'billing.manage'],
  MANAGER: ['customers.read', 'customers.write', 'conversations.read', 'conversations.write', 'leads.read', 'leads.write', 'reports.read', 'team.manage'],
  SALES: ['customers.read', 'customers.write', 'conversations.read', 'conversations.write', 'leads.read', 'leads.write'],
  AGENT: ['customers.read', 'conversations.read', 'leads.read', 'leads.write'],
} as const;
