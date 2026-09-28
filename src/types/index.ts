export type RoleName = 'OWNER' | 'ADMIN' | 'MANAGER' | 'SALES' | 'AGENT';

export type PermissionName =
  | 'customers.read'
  | 'customers.write'
  | 'conversations.read'
  | 'conversations.write'
  | 'leads.read'
  | 'leads.write'
  | 'campaigns.read'
  | 'campaigns.write'
  | 'reports.read'
  | 'team.manage'
  | 'settings.manage'
  | 'billing.manage';

export interface AuthenticatedUser {
  id: string;
  email: string;
  organizationId: string;
  role: RoleName;
  permissions: readonly PermissionName[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      organizationId?: string;
    }
  }
}

export {};
