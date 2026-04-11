import { NextFunction, Request, Response } from 'express';
import { AppRole } from './auth';

function requireRole(...roles: AppRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!req.user.roles.some((role) => roles.includes(role))) {
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

  if (req.user.roles.includes('ADMIN')) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  next();
}

// Allow: any non-ADMIN user, OR an ADMIN who also holds TAVF_CREATOR (guide+admin combo)
function requireTavfCreatorFn(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const isAdmin = req.user.roles.includes('ADMIN');
  const isTavfCreator = req.user.roles.includes('TAVF_CREATOR');

  if (isAdmin && !isTavfCreator) {
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

  if ((req.user.roles ?? []).length === 0) {
    res.status(403).json({ error: 'No recognized application role was found for this account' });
    return;
  }

  next();
}

export { requireAdmin, requireAnyAuthenticatedRole, requireEventCreatorOrAdmin, requireRole, requireTavfCreator };