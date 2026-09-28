import { NextFunction, Request, Response } from 'express';

export function tenantContext(req: Request, _res: Response, next: NextFunction) {
  const organizationId = (req.headers['x-organization-id'] as string) || undefined;
  if (organizationId) {
    (req as any).organizationId = organizationId;
  }
  next();
}
