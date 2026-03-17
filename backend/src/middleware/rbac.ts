import { Request, Response, NextFunction } from 'express';
import { AppRole } from './auth';

/**
 * Middleware factory: requires the authenticated user to have at least one of
 * the specified roles. Must be used after `authenticate`.
 *
 * @param roles - One or more roles that are permitted to access the route.
 *
 * @example
 * router.get('/admin/users', authenticate, requireRole('ADMIN'), handler);
 * router.post('/events', authenticate, requireRole('ADMIN', 'EVENT_CREATOR'), handler);
 */
export function requireRole(...roles: AppRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const hasRole = req.user.roles.some((r) => roles.includes(r));
    if (!hasRole) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

/**
 * Convenience pre-built guards.
 */
export const requireAdmin = requireRole('ADMIN');
export const requireEventCreatorOrAdmin = requireRole('ADMIN', 'EVENT_CREATOR');
export const requireAnyAuthenticatedRole = requireRole('ADMIN', 'EVENT_CREATOR', 'USER');
