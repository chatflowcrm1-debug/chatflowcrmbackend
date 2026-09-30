import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { requireAuth, AuthRequest } from '../../middleware/auth';
import { loginRateLimit, passwordResetRateLimit, refreshRateLimit, registrationRateLimit, verificationRateLimit } from '../../middleware/rate-limit';
import { DEFAULT_PERMISSIONS, createOneTimeToken, hashPassword, hashRefreshToken, isRefreshSessionUsable, signJwt, signRefreshToken, verifyPassword } from './auth.service';
import { sendPasswordResetEmail, sendVerificationEmail } from './auth.email';

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organizationName: z.string().min(2),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

const emailSchema = z.object({ email: z.string().email() });
const verificationSchema = z.object({ token: z.string().min(1) });
const resetSchema = z.object({ token: z.string().min(1), password: z.string().min(8) });

const REFRESH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function safeVerificationEmailErrorMessage(error: unknown, token?: string) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  const secrets = [env.smtpUser, env.smtpPassword, env.jwtSecret, env.jwtRefreshSecret, token]
    .filter((value): value is string => Boolean(value));
  const redactedMessage = secrets.reduce((safeMessage, secret) => {
    return [secret, encodeURIComponent(secret)].reduce(
      (result, value) => result.split(value).join('[REDACTED]'),
      safeMessage,
    );
  }, message);
  return redactedMessage.replace(/https?:\/\/\S+/gi, '[REDACTED_URL]');
}

async function createRefreshSessionForUser(userId: string, organizationId: string, rawRefreshToken: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_SESSION_TTL_MS);
  return prisma.refreshSession.create({
    data: {
      userId,
      organizationId,
      tokenHash,
      expiresAt,
    },
  });
}

function getRefreshTokenFromRequest(req: { headers?: Record<string, string | string[] | undefined>; body?: { refreshToken?: string } }) {
  const bodyToken = req.body?.refreshToken;
  const headerValue = req.headers?.authorization;
  if (typeof bodyToken === 'string' && bodyToken.trim().length > 0) return bodyToken;
  if (typeof headerValue === 'string' && headerValue.startsWith('Bearer ')) return headerValue.slice('Bearer '.length).trim();
  if (Array.isArray(headerValue) && headerValue[0]?.startsWith('Bearer ')) return headerValue[0].slice('Bearer '.length).trim();
  return undefined;
}

async function issueVerificationToken(userId: string) {
  const { rawToken, tokenHash } = createOneTimeToken();
  await prisma.emailVerificationToken.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: new Date() } });
  await prisma.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS) } });
  return rawToken;
}

async function issuePasswordResetToken(userId: string) {
  const { rawToken, tokenHash } = createOneTimeToken();
  await prisma.passwordResetToken.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: new Date() } });
  await prisma.passwordResetToken.create({ data: { userId, tokenHash, expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS) } });
  return rawToken;
}

router.post('/register', registrationRateLimit, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const { email, password, firstName, lastName, organizationName } = parsed.data;

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return res.status(409).json({ message: 'User already exists' });
  }

  const slugBase = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'organization';
  const slug = `${slugBase}-${Math.random().toString(36).slice(2, 8)}`;
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName,
      lastName,
      organization: {
        create: {
          name: organizationName,
          slug,
          status: 'ACTIVE',
          currency: 'USD',
          timezone: 'UTC',
        },
      },
    },
    include: { organization: true },
  });

  if (!user.organization) {
    return res.status(500).json({ message: 'Organization creation failed' });
  }

  await prisma.organizationMember.create({
    data: {
      organizationId: user.organization.id,
      userId: user.id,
      role: 'OWNER',
      title: 'Owner',
      isActive: true,
    },
  });

  const verificationToken = await issueVerificationToken(user.id);
  let emailSent = true;
  try {
    await sendVerificationEmail(user.email, verificationToken);
  } catch (error) {
    logger.error('Verification email delivery failed', safeVerificationEmailErrorMessage(error, verificationToken));
    emailSent = false;
  }

  return res.status(201).json({
    message: emailSent
      ? 'Registration successful. Check your email to verify your account.'
      : 'Account created, but verification email delivery is temporarily unavailable. Please request a new verification email later.',
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationId: user.organization.id,
      organizationName: user.organization.name,
      role: 'OWNER',
    },
  });
});

router.post('/login', loginRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Validation failed', issues: parsed.error.issues });
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    include: { memberships: true, organization: true },
  });

  if (!user || !user.passwordHash || !user.isActive) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const valid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (!user.isEmailVerified) {
    return res.status(403).json({ message: 'Please verify your email before signing in.' });
  }

  const membership = user.memberships[0];
  if (!membership || !membership.isActive) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const organizationId = membership.organizationId;
  const role = (membership?.role || 'OWNER') as 'OWNER' | 'ADMIN' | 'MANAGER' | 'SALES' | 'AGENT';
  const permissions = DEFAULT_PERMISSIONS[role] || DEFAULT_PERMISSIONS.AGENT;

  const accessToken = signJwt({
    id: user.id,
    email: user.email,
    organizationId,
    role,
    permissions,
  });
  const refreshToken = signRefreshToken({
    id: user.id,
    email: user.email,
    organizationId,
    role,
    permissions,
  });
  await createRefreshSessionForUser(user.id, organizationId, refreshToken);

  return res.json({
    message: 'Login successful',
    token: accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationId,
      role,
    },
  });
});

router.post('/verify-email', verificationRateLimit, async (req, res) => {
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid verification link' });

  const tokenHash = hashRefreshToken(parsed.data.token);
  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.emailVerificationToken.updateMany({
        where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claim.count !== 1) throw new Error('INVALID_VERIFICATION_TOKEN');

      const tokenRecord = await tx.emailVerificationToken.findUnique({ where: { tokenHash } });
      if (!tokenRecord) throw new Error('INVALID_VERIFICATION_TOKEN');
    await tx.user.update({ where: { id: tokenRecord.userId }, data: { isEmailVerified: true } });
    });
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid or expired verification link' });
  }

  return res.json({ message: 'Email verified successfully. You can now sign in.' });
});

router.post('/resend-verification', verificationRateLimit, async (req, res) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'If an account exists for that email, verification instructions have been sent.' });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && !user.isEmailVerified) {
    let token: string | undefined;
    try {
      token = await issueVerificationToken(user.id);
      await sendVerificationEmail(user.email, token);
    } catch (error) {
      logger.error('Verification email delivery failed', safeVerificationEmailErrorMessage(error, token));
      // Keep the response generic and avoid account enumeration.
    }
  }

  return res.json({ message: 'If an account exists for that email, verification instructions have been sent.' });
});

router.post('/forgot-password', passwordResetRateLimit, async (req, res) => {
  const genericMessage = 'If an account exists for that email, password reset instructions have been sent.';
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) return res.json({ message: genericMessage });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && user.isActive) {
    try {
      const token = await issuePasswordResetToken(user.id);
      await sendPasswordResetEmail(user.email, token);
    } catch (_error) {
      // Keep the response generic and avoid account enumeration.
    }
  }

  return res.json({ message: genericMessage });
});

router.post('/reset-password', passwordResetRateLimit, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid or expired password reset link' });

  const tokenHash = hashRefreshToken(parsed.data.token);
  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.passwordResetToken.updateMany({
        where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claim.count !== 1) throw new Error('INVALID_PASSWORD_RESET_TOKEN');

      const tokenRecord = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
      if (!tokenRecord) throw new Error('INVALID_PASSWORD_RESET_TOKEN');
    await tx.user.update({ where: { id: tokenRecord.userId }, data: { passwordHash: await hashPassword(parsed.data.password) } });
    await tx.refreshSession.updateMany({ where: { userId: tokenRecord.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid or expired password reset link' });
  }

  return res.json({ message: 'Password reset successfully. Please sign in again.' });
});

router.post('/refresh', refreshRateLimit, async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  const refreshToken = parsed.success ? parsed.data.refreshToken : undefined;
  const token = refreshToken || getRefreshTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({ message: 'Refresh token required' });
  }

  try {
    const payload = jwt.verify(token, env.jwtRefreshSecret) as { id: string; organizationId: string; exp?: number };
    const session = await prisma.refreshSession.findUnique({ where: { tokenHash: hashRefreshToken(token) } });

    if (!session || session.userId !== payload.id || session.organizationId !== payload.organizationId) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    if (!isRefreshSessionUsable(session)) {
      return res.status(401).json({ message: 'Refresh token has expired or been revoked' });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      include: { memberships: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'User not active' });
    }

    const currentMembership = user.memberships.find((membership) => membership.organizationId === payload.organizationId && membership.isActive);
    if (!currentMembership) {
      return res.status(401).json({ message: 'Organization membership not active' });
    }

    const role = currentMembership.role as 'OWNER' | 'ADMIN' | 'MANAGER' | 'SALES' | 'AGENT';
    const permissions = DEFAULT_PERMISSIONS[role] || DEFAULT_PERMISSIONS.AGENT;

    const nextRefreshToken = signRefreshToken({
      id: user.id,
      email: user.email,
      organizationId: payload.organizationId,
      role,
      permissions,
    });

    const rotatedSession = await prisma.$transaction(async (tx) => {
      const currentSession = await tx.refreshSession.findUnique({ where: { id: session.id } });
      if (!currentSession || !isRefreshSessionUsable(currentSession)) {
        throw new Error('INVALID_SESSION');
      }

      const newSession = await tx.refreshSession.create({
        data: {
          userId: user.id,
          organizationId: payload.organizationId,
          tokenHash: hashRefreshToken(nextRefreshToken),
          expiresAt: new Date(Date.now() + REFRESH_SESSION_TTL_MS),
        },
      });

      await tx.refreshSession.update({
        where: { id: currentSession.id },
        data: {
          revokedAt: new Date(),
          replacedBySessionId: newSession.id,
        },
      });

      return newSession;
    });

    const accessToken = signJwt({
      id: user.id,
      email: user.email,
      organizationId: payload.organizationId,
      role,
      permissions,
    });

    return res.json({
      message: 'Token refreshed successfully',
      token: accessToken,
      refreshToken: nextRefreshToken,
      sessionId: rotatedSession.id,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        organizationId: payload.organizationId,
        role,
      },
    });
  } catch (_error) {
    return res.status(401).json({ message: 'Invalid or expired refresh token' });
  }
});

router.post('/logout', async (req, res) => {
  const refreshToken = getRefreshTokenFromRequest(req) || req.body?.refreshToken;

  if (!refreshToken) {
    return res.json({ message: 'Logged out successfully' });
  }

  try {
    const payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as { id: string; organizationId: string };
    const tokenHash = hashRefreshToken(refreshToken);
    const existing = await prisma.refreshSession.findUnique({ where: { tokenHash } });
    if (existing && existing.userId === payload.id && existing.organizationId === payload.organizationId) {
      await prisma.refreshSession.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
    }
  } catch (_error) {
    // Intentionally ignore invalid refresh tokens on logout to keep the endpoint idempotent.
  }

  return res.json({ message: 'Logged out successfully' });
});

router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      memberships: { include: { organization: true } },
      organization: true,
    },
  });

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const orgs = user.memberships.map((membership) => ({
    id: membership.organization.id,
    name: membership.organization.name,
    role: membership.role,
  }));

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      currentOrganizationId: req.user!.organizationId,
      organizations: orgs,
      role: req.user!.role,
    },
  });
});

export default router;
