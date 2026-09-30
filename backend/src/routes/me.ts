import { NextFunction, Request, Response, Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole } from '../middleware/rbac';
import { listTenantsForAuthenticatedUser } from '../services/tenantContextService';
import { getTenantBranding } from '../services/rootTenantBrandingService';

const router = Router();

router.get('/tenants', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const tenants = await listTenantsForAuthenticatedUser({
      sub: req.user.sub,
      email: req.user.email,
      roles: req.user.roles,
    });

    res.json({ tenants });
  } catch (error) {
    next(error);
  }
});

router.get('/tenant-branding', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.tenantId) {
      res.status(400).json({ error: 'Active tenant is required' });
      return;
    }

    const branding = await getTenantBranding(req.tenantId);
    if (!branding) {
      res.status(404).json({ error: 'Tenant branding not found' });
      return;
    }

    res.json(branding);
  } catch (error) {
    next(error);
  }
});

export default router;
