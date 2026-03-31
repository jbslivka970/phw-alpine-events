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
  const normalizedRoles: AppRole[] = [];

  const normalizeRole = (value: string): AppRole | null => {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');

    if (normalized === 'ADMIN') {
      return 'ADMIN';
    }
    if (normalized === 'EVENT_CREATOR') {
      return 'EVENT_CREATOR';
    }
    if (normalized === 'USER') {
      return 'USER';
    }

    if (['ADMINISTRATOR', 'CHAPTER_ADMIN', 'SUPERADMIN', 'SUPER_ADMIN'].includes(normalized)) {
      return 'ADMIN';
    }

    if (['EVENTCREATOR', 'EVENT_MANAGER', 'EVENT_ADMIN'].includes(normalized)) {
      return 'EVENT_CREATOR';
    }

    if (['MEMBER', 'PARTICIPANT', 'READER'].includes(normalized)) {
      return 'USER';
    }

    return null;
  };

  const pushClaimValues = (value: unknown): void => {
    if (typeof value === 'string') {
      rawRoles.push(...value.split(',').map((role) => role.trim()).filter(Boolean));
      return;
    }

    if (Array.isArray(value)) {
      rawRoles.push(...value.filter((role): role is string => typeof role === 'string').map((role) => role.trim()).filter(Boolean));
    }
  };

  pushClaimValues(claims['roles']);
  pushClaimValues(claims['role']);
  pushClaimValues(claims['extension_roles']);
  pushClaimValues(claims['extension_Roles']);
  pushClaimValues(claims['extension_role']);
  pushClaimValues(claims['extension_Role']);
  pushClaimValues(claims['appRoles']);
  pushClaimValues(claims['app_roles']);
  pushClaimValues(claims['groups']);

  for (const role of rawRoles) {
    const normalized = normalizeRole(role);
    if (normalized && !normalizedRoles.includes(normalized)) {
      normalizedRoles.push(normalized);
    }
  }

  // Delegated API access tokens can be valid for this API but omit app role claims.
  // Treat these callers as USER so read-level authenticated routes do not fail closed.
  if (normalizedRoles.length === 0 && typeof claims['scp'] === 'string' && claims['scp'].trim().length > 0) {
    normalizedRoles.push('USER');
  }

  return normalizedRoles;
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
        sub: String(claims['oid'] ?? claims['sub'] ?? ''),
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