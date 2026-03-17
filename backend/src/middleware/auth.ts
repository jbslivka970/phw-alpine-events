import { Request, Response, NextFunction } from 'express';

/**
 * Lightweight auth middleware.
 * In development (NODE_ENV !== 'production') it passes through with a
 * synthetic user so routes can be exercised without a real token.
 * In production this should be replaced with full Azure AD B2C JWT
 * validation (jsonwebtoken + jwks-rsa).
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    oid: string;
    email: string;
    roles: string[];
  };
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (process.env.NODE_ENV !== 'production') {
    // Dev bypass – attach a stub user so handlers can read req.user
    req.user = {
      oid: 'dev-user',
      email: 'dev@example.com',
      roles: ['admin'],
    };
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // TODO: validate JWT with Azure AD B2C (jsonwebtoken + jwks-rsa)
  res.status(401).json({ error: 'Unauthorized – JWT validation not yet wired' });
}
