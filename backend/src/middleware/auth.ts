import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload, VerifyErrors } from 'jsonwebtoken';
import jwksRsa, { JwksClient } from 'jwks-rsa';
import config from '../config';

// Valid role values
export type AppRole = 'ADMIN' | 'EVENT_CREATOR' | 'USER';

// Extend Express Request with authenticated user info
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export interface AuthenticatedUser {
  sub: string;
  email?: string;
  name?: string;
  roles: AppRole[];
  rawClaims: JwtPayload;
}

// Lazy-initialised JWKS client (created once per process)
let jwksClient: JwksClient | null = null;

function getJwksClient(): JwksClient {
  if (!jwksClient) {
    jwksClient = jwksRsa({
      jwksUri: config.azureAdB2c.jwksUri,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600_000, // 10 minutes
      rateLimit: true,
    });
  }
  return jwksClient;
}

/**
 * Retrieve the signing key from Azure AD B2C JWKS endpoint.
 */
function getSigningKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  if (!header.kid) {
    callback(new Error('JWT header missing kid'), undefined);
    return;
  }
  getJwksClient().getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err, undefined);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

/**
 * Extract roles from standard Azure AD B2C token claims.
 * B2C can expose roles via:
 *  - `roles` array (App Roles)
 *  - `extension_roles` string (custom attribute, comma-separated)
 *  - `groups` array (mapped group names)
 */
function extractRoles(claims: JwtPayload): AppRole[] {
  const validRoles: AppRole[] = ['ADMIN', 'EVENT_CREATOR', 'USER'];

  const rawRoles: string[] = [];

  // App Roles claim (array of strings)
  if (Array.isArray(claims['roles'])) {
    rawRoles.push(...(claims['roles'] as string[]));
  }

  // Custom extension attribute (comma-separated string)
  if (typeof claims['extension_roles'] === 'string') {
    const parts = (claims['extension_roles'] as string)
      .split(',')
      .map((r) => r.trim().toUpperCase());
    rawRoles.push(...parts);
  }

  // Groups claim (array of strings treated as role names)
  if (Array.isArray(claims['groups'])) {
    rawRoles.push(...(claims['groups'] as string[]));
  }

  const normalised = rawRoles.map((r) => r.toUpperCase());
  return normalised.filter((r): r is AppRole => validRoles.includes(r as AppRole));
}

/**
 * Middleware: validate Bearer token issued by Azure AD B2C.
 * On success, attaches `req.user` and calls `next()`.
 * On failure, responds with 401.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  const verifyOptions: jwt.VerifyOptions = {
    algorithms: ['RS256'],
    audience: config.azureAdB2c.clientId,
    issuer: config.azureAdB2c.issuer,
  };

  jwt.verify(token, getSigningKey, verifyOptions, (err: VerifyErrors | null, decoded) => {
    if (err || !decoded) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const claims = decoded as JwtPayload;
    req.user = {
      sub: claims['sub'] as string,
      email: claims['email'] as string | undefined,
      name: claims['name'] as string | undefined,
      roles: extractRoles(claims),
      rawClaims: claims,
    };

    next();
  });
}

export default authenticate;
