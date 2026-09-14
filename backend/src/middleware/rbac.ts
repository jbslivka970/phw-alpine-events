import { NextFunction, Request, Response } from 'express';
import { AppRole } from './auth';

type TenantRole = NonNullable<Request['tenantContext']>['activeRole'];

function strictTenantRbacEnabled(): boolean {
  const enabled = (value: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
  return enabled(process.env['MULTI_TENANT_ENABLED']) && enabled(process.env['MULTI_TENANT_REQUIRE_MEMBERSHIP']);
}

function tenantRoleAllows(req: Request, allowedRoles: readonly TenantRole[]): boolean {
  if (!strictTenantRbacEnabled()) {
    return false;
  }
  const activeRole = req.tenantContext?.activeRole;
  return Boolean(activeRole && allowedRoles.includes(activeRole));
}

function requireRole(...roles: AppRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const allowedTenantRoles = new Set<TenantRole>();
    for (const role of roles) {
      if (role === 'ADMIN') {
        allowedTenantRoles.add('admin');
        allowedTenantRoles.add('root_admin');
      } else if (role === 'EVENT_CREATOR') {
        allowedTenantRoles.add('event_creator');
        allowedTenantRoles.add('admin');
        allowedTenantRoles.add('root_admin');
      } else if (role === 'TAVF_CREATOR') {
        allowedTenantRoles.add('tavf_creator');
        allowedTenantRoles.add('admin');
        allowedTenantRoles.add('root_admin');
      } else {
        allowedTenantRoles.add('member');
        allowedTenantRoles.add('event_creator');
        allowedTenantRoles.add('tavf_creator');
        allowedTenantRoles.add('admin');
        allowedTenantRoles.add('root_admin');
        allowedTenantRoles.add('support');
      }
    }
    const tenantRoleAllowed = tenantRoleAllows(req, [...allowedTenantRoles]);
    const globalRoleAllowed = !strictTenantRbacEnabled() && req.user.roles.some((role) => roles.includes(role));

    if (!tenantRoleAllowed && !globalRoleAllowed) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

function requireNonAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (strictTenantRbacEnabled() ? tenantRoleAllows(req, ['admin', 'root_admin']) : req.user.roles.includes('ADMIN')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  next();
}

// Allow: any non-ADMIN user, or an ADMIN who also holds EVENT_CREATOR or TAVF_CREATOR.
function requireTavfCreatorFn(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const allowed = strictTenantRbacEnabled()
    ? tenantRoleAllows(req, ['tavf_creator', 'event_creator', 'admin', 'root_admin'])
    : req.user.roles.includes('TAVF_CREATOR') || req.user.roles.includes('EVENT_CREATOR');

  if (!allowed) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  next();
}

const requireAdmin = requireRole('ADMIN');
const requireEventCreatorOrAdmin = requireRole('ADMIN', 'EVENT_CREATOR');
const requireTavfCreator = requireTavfCreatorFn;
function requireAnyAuthenticatedRole(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const hasTenantRole = strictTenantRbacEnabled() && Boolean(req.tenantContext?.activeRole);
  if (!hasTenantRole && (req.user.roles ?? []).length === 0) {
    res.status(403).json({ error: 'No recognized application role was found for this account' });
    return;
  }

  next();
}

export { requireAdmin, requireAnyAuthenticatedRole, requireEventCreatorOrAdmin, requireRole, requireTavfCreator };