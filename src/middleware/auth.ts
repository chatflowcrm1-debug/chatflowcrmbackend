import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AuthenticatedUser, PermissionName } from '../types';

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
  organizationId?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const token = header.substring(7);

  try {
    const decoded = jwt.verify(token, env.jwtSecret) as AuthenticatedUser & { exp?: number };
    req.user = {
      id: decoded.id,
      email: decoded.email,
      organizationId: decoded.organizationId,
      role: decoded.role,
      permissions: decoded.permissions || [],
    };
    req.organizationId = decoded.organizationId;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

export function requirePermission(permission: PermissionName) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (user.role === 'OWNER' || user.role === 'ADMIN') {
      return next();
    }

    if (!user.permissions.includes(permission)) {
      return res.status(403).json({ message: 'Forbidden: missing permission' });
    }

    next();
  };
}

export function requireTenantAccess(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user;
  const tenantId = req.params.organizationId || req.query.organizationId;

  if (!user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  if (tenantId && tenantId !== user.organizationId) {
    return res.status(403).json({ message: 'Tenant access denied' });
  }

  req.organizationId = user.organizationId;
  next();
}
