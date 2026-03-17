import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload, VerifyErrors } from 'jsonwebtoken';
import jwksRsa, { JwksClient } from 'jwks-rsa';
import { loadAuthConfig } from '../config';

type AppRole = 'ADMIN' | 'EVENT_CREATOR' | 'USER';

interface AuthenticatedUser {
  sub: string;
  email?: string;
  name?: string;
  roles: AppRole[];
  rawClaims: JwtPayload;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

let jwksClient: JwksClient | null = null;

function getJwksClient(): JwksClient {
  const authConfig = loadAuthConfig();

  if (!jwksClient) {
    jwksClient = jwksRsa({
      jwksUri: authConfig.jwksUri,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600_000,
      rateLimit: true,
    });
  }

  return jwksClient;
}

function getSigningKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  if (!header.kid) {
    callback(new Error('JWT header missing kid'), undefined);
    return;
  }

  getJwksClient().getSigningKey(header.kid, (error, key) => {
    if (error) {
      callback(error, undefined);
      return;
    }

    callback(null, key?.getPublicKey());
  });
}

function extractRoles(claims: JwtPayload): AppRole[] {
  const rawRoles: string[] = [];
  const validRoles: AppRole[] = ['ADMIN', 'EVENT_CREATOR', 'USER'];

  if (Array.isArray(claims['roles'])) {
    rawRoles.push(...(claims['roles'] as string[]));
  }

  if (typeof claims['extension_roles'] === 'string') {
    rawRoles.push(
      ...(claims['extension_roles'] as string)
        .split(',')
        .map((role) => role.trim())
    );
  }

  if (Array.isArray(claims['groups'])) {
    rawRoles.push(...(claims['groups'] as string[]));
  }

  return rawRoles
    .map((role) => role.toUpperCase())
    .filter((role): role is AppRole => validRoles.includes(role as AppRole));
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authConfig = loadAuthConfig();

  if (!authConfig.isConfigured) {
    res.status(503).json({ error: 'Authentication is not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  jwt.verify(
    token,
    getSigningKey,
    {
      algorithms: ['RS256'],
      audience: authConfig.clientId,
      issuer: authConfig.issuer,
    },
    (error: VerifyErrors | null, decoded) => {
      if (error || !decoded) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }

      const claims = decoded as JwtPayload;
      req.user = {
        sub: String(claims['sub'] ?? ''),
        email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
        name: typeof claims['name'] === 'string' ? claims['name'] : undefined,
        roles: extractRoles(claims),
        rawClaims: claims,
      };

      next();
    }
  );
}

export default authenticate;
export type { AppRole, AuthenticatedUser };