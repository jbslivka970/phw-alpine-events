import { Router, type Request, type Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import jwksRsa, { type JwksClient } from 'jwks-rsa';
import { loadAuthConfig } from '../config';
import { getPool, sql } from '../db';
import type { AppRole } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiter';

const router = Router();

type PersonaLabel = 'admin' | 'event_creator' | 'member';

type PersonaConfig = {
  email: string;
  roles: AppRole[];
};

type TestMemberRow = {
  member_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
};

let m2mJwksClient: JwksClient | null = null;

function exchangeEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env['E2E_AUTH_EXCHANGE_ENABLED'] ?? '');
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePersona(raw: unknown): PersonaLabel | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'admin' || normalized === 'event_creator' || normalized === 'member') {
    return normalized;
  }

  return null;
}

function getM2MJwksClient(): JwksClient {
  if (m2mJwksClient) {
    return m2mJwksClient;
  }

  const authConfig = loadAuthConfig();
  const jwksUri = (process.env['E2E_AUTH_M2M_JWKS_URI'] ?? authConfig.jwksUri).trim();
  m2mJwksClient = jwksRsa({
    jwksUri,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 600_000,
    rateLimit: true,
  });

  return m2mJwksClient;
}

function verifyM2MToken(token: string): Promise<JwtPayload> {
  const authConfig = loadAuthConfig();
  const audience = (process.env['E2E_AUTH_M2M_AUDIENCE'] ?? authConfig.clientId).trim();
  const issuer = (process.env['E2E_AUTH_M2M_ISSUER'] ?? authConfig.issuer).trim();

  return new Promise<JwtPayload>((resolve, reject) => {
    jwt.verify(
      token,
      (header, callback) => {
        if (!header.kid) {
          callback(new Error('JWT header missing kid'), undefined);
          return;
        }

        getM2MJwksClient().getSigningKey(header.kid, (error, key) => {
          if (error) {
            callback(error, undefined);
            return;
          }

          callback(null, key?.getPublicKey());
        });
      },
      {
        algorithms: ['RS256'],
        audience,
        issuer,
      },
      (error, decoded) => {
        if (error || !decoded || typeof decoded === 'string') {
          reject(error ?? new Error('Invalid or missing JWT payload'));
          return;
        }

        resolve(decoded as JwtPayload);
      }
    );
  });
}

function readStringClaim(claims: JwtPayload, key: string): string | undefined {
  const value = claims[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArrayClaim(claims: JwtPayload, key: string): string[] {
  const value = claims[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function resolvePersonaConfig(persona: PersonaLabel): PersonaConfig | null {
  const emailMap: Record<PersonaLabel, string> = {
    admin: (process.env['E2E_AUTH_PERSONA_ADMIN_EMAIL'] ?? '').trim().toLowerCase(),
    event_creator: (process.env['E2E_AUTH_PERSONA_EVENT_CREATOR_EMAIL'] ?? '').trim().toLowerCase(),
    member: (process.env['E2E_AUTH_PERSONA_MEMBER_EMAIL'] ?? '').trim().toLowerCase(),
  };

  const roleMap: Record<PersonaLabel, AppRole[]> = {
    admin: ['ADMIN', 'EVENT_CREATOR', 'TAVF_CREATOR', 'USER'],
    event_creator: ['EVENT_CREATOR', 'TAVF_CREATOR', 'USER'],
    member: ['USER'],
  };

  const email = emailMap[persona];
  if (!email || !email.includes('@')) {
    return null;
  }

  return {
    email,
    roles: roleMap[persona],
  };
}

async function findActiveTestMemberByEmail(email: string): Promise<TestMemberRow | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('email', sql.NVarChar(320), email)
    .query<TestMemberRow>(
      `IF COL_LENGTH('dbo.member', 'is_test_account') IS NULL
       BEGIN
         SELECT TOP 0
           CAST(NULL AS UNIQUEIDENTIFIER) AS member_id,
           CAST(NULL AS NVARCHAR(100)) AS first_name,
           CAST(NULL AS NVARCHAR(100)) AS last_name,
           CAST(NULL AS NVARCHAR(320)) AS email;
       END
       ELSE
       BEGIN
         SELECT TOP 1
           m.member_id,
           m.first_name,
           m.last_name,
           m.email
         FROM member m
         WHERE LOWER(m.email) = @email
           AND m.is_active = 1
           AND m.is_test_account = 1;
       END`
    );

  return result.recordset[0] ?? null;
}

router.post('/e2e/exchange', writeLimiter, async (req: Request, res: Response) => {
  if (!exchangeEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const signingKey = (process.env['E2E_AUTH_INTERNAL_SIGNING_KEY'] ?? '').trim();
  if (!signingKey) {
    res.status(503).json({ error: 'E2E auth exchange is not configured.' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const persona = normalizePersona(req.body?.persona);
  if (!persona) {
    res.status(400).json({ error: 'persona must be one of: admin, event_creator, member' });
    return;
  }

  const personaConfig = resolvePersonaConfig(persona);
  if (!personaConfig) {
    res.status(503).json({ error: `Persona ${persona} is not configured.` });
    return;
  }

  const allowedAppIds = new Set(parseCsv(process.env['E2E_AUTH_M2M_ALLOWED_APP_IDS']));
  if (allowedAppIds.size === 0) {
    res.status(503).json({ error: 'E2E auth exchange allow-list is not configured.' });
    return;
  }

  const requiredRole = (process.env['E2E_AUTH_M2M_REQUIRED_ROLE'] ?? 'E2E.Impersonate').trim();
  const m2mToken = authHeader.slice('Bearer '.length).trim();

  let m2mClaims: JwtPayload;
  try {
    m2mClaims = await verifyM2MToken(m2mToken);
  } catch {
    res.status(401).json({ error: 'Invalid or expired machine token' });
    return;
  }

  const appId = readStringClaim(m2mClaims, 'appid') ?? readStringClaim(m2mClaims, 'azp');
  if (!appId || !allowedAppIds.has(appId)) {
    res.status(403).json({ error: 'Calling application is not allowed for E2E impersonation.' });
    return;
  }

  const roles = readStringArrayClaim(m2mClaims, 'roles');
  if (!roles.includes(requiredRole)) {
    res.status(403).json({ error: `Machine token is missing required role ${requiredRole}.` });
    return;
  }

  const member = await findActiveTestMemberByEmail(personaConfig.email);
  if (!member) {
    res.status(403).json({ error: `No active test account exists for persona ${persona}.` });
    return;
  }

  const ttlSeconds = parsePositiveInt(process.env['E2E_AUTH_INTERNAL_TOKEN_TTL_SECONDS'], 900);
  const internalIssuer = (process.env['E2E_AUTH_INTERNAL_ISSUER'] ?? 'phw-e2e-exchange').trim();
  const internalAudience = (process.env['E2E_AUTH_INTERNAL_AUDIENCE'] ?? 'phw-e2e-internal').trim();
  const displayName = `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim() || member.email;

  const accessToken = jwt.sign(
    {
      e2e_internal: true,
      persona,
      sub: member.member_id,
      oid: member.member_id,
      email: member.email,
      name: displayName,
      roles: personaConfig.roles,
      appid: appId,
    },
    signingKey,
    {
      algorithm: 'HS256',
      issuer: internalIssuer,
      audience: internalAudience,
      expiresIn: ttlSeconds,
    }
  );

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    token_type: 'Bearer',
    access_token: accessToken,
    expires_in: ttlSeconds,
    persona,
    member_id: member.member_id,
    email: member.email,
    roles: personaConfig.roles,
  });
});

export default router;
