import { NextFunction, Request, Response, Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole } from '../middleware/rbac';
import { listTenantsForAuthenticatedUser } from '../services/tenantContextService';

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

export default router;
