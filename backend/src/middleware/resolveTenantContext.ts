import type { NextFunction, Request, Response } from 'express';
import { listTenantsForAuthenticatedUser, type UserTenantContext } from '../services/tenantContextService';

const DEFAULT_TENANT_ID = (process.env['DEFAULT_TENANT_ID'] ?? '1b6b9719-663a-4e56-8f7d-9a4bd4c10001').trim().toLowerCase();

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      tenantContext?: {
        activeTenantId: string;
        availableTenantIds: string[];
        source: 'default' | 'header' | 'auto';
      };
    }
  }
}

function isEnabled(raw: string | undefined, defaultValue = false): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizeHeaderTenantId(value: string | string[] | undefined): string | null {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value[0]
      : undefined;

  if (!raw) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

function chooseDefaultTenant(tenants: UserTenantContext[]): string {
  const home = tenants.find((tenant) => tenant.membership_kind === 'home');
  return (home?.tenant_id ?? tenants[0]?.tenant_id ?? DEFAULT_TENANT_ID).toLowerCase();
}

async function resolveTenantContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env['NODE_ENV'] === 'test') {
    req.tenantId = DEFAULT_TENANT_ID;
    req.tenantContext = {
      activeTenantId: DEFAULT_TENANT_ID,
      availableTenantIds: [DEFAULT_TENANT_ID],
      source: 'default',
    };
    next();
    return;
  }

  const multiTenantEnabled = isEnabled(process.env['MULTI_TENANT_ENABLED'], false);
  if (!req.user || !multiTenantEnabled) {
    req.tenantId = DEFAULT_TENANT_ID;
    req.tenantContext = {
      activeTenantId: DEFAULT_TENANT_ID,
      availableTenantIds: [DEFAULT_TENANT_ID],
      source: 'default',
    };
    next();
    return;
  }

  try {
    const memberships = await listTenantsForAuthenticatedUser({
      sub: req.user.sub,
      email: req.user.email,
      roles: req.user.roles,
    });

    if (memberships.length === 0) {
      res.status(403).json({ error: 'No active tenant access for this account.' });
      return;
    }

    const availableTenantIds = memberships.map((tenant) => tenant.tenant_id.toLowerCase());
    const requestedTenantId = normalizeHeaderTenantId(req.headers['x-tenant-id']);
    const hasRootScope = memberships.some((tenant) => tenant.role === 'root_admin' || tenant.role === 'support');

    if (requestedTenantId && !availableTenantIds.includes(requestedTenantId) && !hasRootScope) {
      res.status(403).json({ error: 'Requested tenant is not accessible for this account.' });
      return;
    }

    const activeTenantId = requestedTenantId ?? chooseDefaultTenant(memberships);
    const source: 'header' | 'auto' = requestedTenantId ? 'header' : 'auto';

    req.tenantId = activeTenantId;
    req.tenantContext = {
      activeTenantId,
      availableTenantIds,
      source,
    };
    res.setHeader('X-Active-Tenant-Id', activeTenantId);
    next();
  } catch (error) {
    next(error);
  }
}

export { resolveTenantContext, DEFAULT_TENANT_ID };