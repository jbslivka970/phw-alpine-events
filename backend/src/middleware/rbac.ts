import { Request, Response, NextFunction } from 'express';

type AuthRequest = Request & { user?: { sub: string; roles: string[] } };

/**
 * RBAC middleware stub.
 * Checks that the authenticated user has at least one of the required roles.
 */
export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const userRoles: string[] = req.user?.roles ?? [];
    const hasRole = roles.some((r) => userRoles.includes(r));
    if (!hasRole) {
      res.status(403).json({ error: 'Forbidden – insufficient role.' });
      return;
    }
    next();
  };
}
