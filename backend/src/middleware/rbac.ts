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

const requireAdmin = requireRole('ADMIN');
const requireEventCreatorOrAdmin = requireRole('ADMIN', 'EVENT_CREATOR');
const requireTavfCreator = requireNonAdmin;
const requireAnyAuthenticatedRole = requireRole('ADMIN', 'EVENT_CREATOR', 'USER');

export { requireAdmin, requireAnyAuthenticatedRole, requireEventCreatorOrAdmin, requireRole, requireTavfCreator };