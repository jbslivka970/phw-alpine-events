import { Request, Response, NextFunction } from 'express';

/**
 * Auth middleware stub.
 * In production this will validate Azure AD B2C JWTs via jsonwebtoken + jwks-rsa.
 * For now it passes through and attaches a placeholder user object.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  // TODO: validate Bearer token against Azure AD B2C JWKS endpoint
  // const token = req.headers.authorization?.replace('Bearer ', '');
  // Stub: allow all requests through in development
  (req as Request & { user?: { sub: string; roles: string[] } }).user = {
    sub: 'stub-user',
    roles: ['admin'],
  };
  next();
}
